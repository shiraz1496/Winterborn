import { describe, it, expect, afterAll } from 'vitest'
import type { Square } from 'square'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { square, assertNoErrors, mainLocationId, catalogObjectExists } from '../src/catalog/square-client.js'
import {
  applyPlan,
  verifyPlan,
  buildAllowlist,
  assertObjectAllowed,
  type CatalogPlan,
  type ItemPlan,
} from '../src/catalog/catalog-plan.js'
import { rollbackPlan } from '../src/catalog/catalog-rollback.js'
import { backupCatalog, findLatestBackup, assertFreshBackup } from '../src/catalog/catalog-backup.js'
import { runCategoriesSequentially } from '../src/catalog/catalog-migrate.js'
import { runPreflight } from '../src/catalog/catalog-preflight.js'

/**
 * Focused coverage of the six catalog write-path guards (build guide,
 * `catalog-write-guards` branch). Every test that touches Square hits the
 * live sandbox for real -- no mocks -- matching this repo's existing
 * convention for Square-adjacent tests (`prototypes/`) and the
 * `assertSandbox()` check `square-client.ts` runs at import time, which
 * makes it structurally impossible for this file to run against
 * production. Nothing here touches Postgres/Prisma, so none of it is
 * subject to the dev database's `TRUNCATE ... LedgerEvent` reseed pattern
 * used by the fulfilment/ledger specs.
 */

function isItem(obj: Square.CatalogObject | undefined): obj is Square.CatalogObject.Item {
  return obj?.type === 'ITEM'
}

function isItemVariation(obj: Square.CatalogObject): obj is Square.CatalogObject.ItemVariation {
  return obj.type === 'ITEM_VARIATION'
}

const RUN_ID = `g${Date.now().toString(36)}`
const tempDirs: string[] = []

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

async function createFlatItem(name: string, priceCents: number): Promise<{ itemId: string; variationId: string }> {
  const tempItemId = `#item_${RUN_ID}_${randomUUID().slice(0, 8)}`
  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      type: 'ITEM',
      id: tempItemId,
      itemData: {
        name: `${name} ${RUN_ID}`,
        variations: [
          {
            type: 'ITEM_VARIATION',
            id: `${tempItemId}_var`,
            itemVariationData: {
              itemId: tempItemId,
              name: 'Regular',
              pricingType: 'FIXED_PRICING',
              priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
              sellable: true,
              stockable: true,
            },
          },
        ],
      },
    },
  })
  assertNoErrors(res, 'catalog.object.upsert (test createFlatItem)')
  const saved = res.catalogObject
  if (!isItem(saved) || !saved.itemData) throw new Error('createFlatItem: no ITEM object returned')
  const variation = (saved.itemData.variations ?? []).filter(isItemVariation)[0]
  if (!variation) throw new Error('createFlatItem: no variation returned')
  return { itemId: saved.id, variationId: variation.id }
}

async function placeOrder(variationId: string, quantity: number): Promise<string> {
  const locationId = await mainLocationId()
  const createRes = await square.orders.create({
    idempotencyKey: randomUUID(),
    order: { locationId, lineItems: [{ catalogObjectId: variationId, quantity: String(quantity) }] },
  })
  assertNoErrors(createRes, 'orders.create (test placeOrder)')
  const order = createRes.order
  const orderId = order?.id
  if (!orderId) throw new Error('placeOrder: no order id')
  const totalMoney = order.totalMoney
  if (!totalMoney?.amount) throw new Error('placeOrder: order has no totalMoney')

  const paymentRes = await square.payments.create({
    idempotencyKey: randomUUID(),
    sourceId: 'cnon:card-nonce-ok',
    orderId,
    locationId,
    amountMoney: totalMoney,
  })
  assertNoErrors(paymentRes, 'payments.create (test placeOrder)')
  if (paymentRes.payment?.status !== 'COMPLETED') {
    throw new Error(`placeOrder: payment did not complete, status=${paymentRes.payment?.status}`)
  }
  return orderId
}

function makePlan(itemId: string, variationId: string, skuPrefix: string): CatalogPlan {
  const item: ItemPlan = {
    itemGroupId: 'test-group',
    itemGroupName: 'Test Item',
    squareItemId: itemId,
    legacyVariationId: variationId,
    legacyLabel: 'Unspecified (pre-2026)',
    originalLegacyName: 'Regular',
    originalLegacySellable: true,
    originalLegacyStockable: true,
    capturedOverrides: [],
    presentAtAllLocations: true,
    newVariations: [
      { tempId: '#new_0', variationName: 'Blue', sku: `${skuPrefix}-BLU`, priceCents: 6500, currency: 'USD' },
      { tempId: '#new_1', variationName: 'Green', sku: `${skuPrefix}-GRN`, priceCents: 6500, currency: 'USD' },
    ],
  }
  return { createdAt: new Date().toISOString(), category: 'Test', items: [item] }
}

/** Drops a placeholder backup file with a fresh mtime -- enough to satisfy `assertFreshBackup`, without paying for a real catalog export. */
function touchFakeBackup(dir: string): void {
  writeFileSync(join(dir, `catalog-backup-${Date.now()}.json`), '{}')
}

// ---------------------------------------------------------------------------
// Guard 1: backup before any write.
// ---------------------------------------------------------------------------
describe('guard 1: backup before any write', () => {
  it('assertFreshBackup throws when no backup exists', () => {
    const dir = freshDir('catalog-backup-none-')
    expect(() => assertFreshBackup({ createdAt: new Date().toISOString() }, dir)).toThrow(/no backup found/)
  })

  it('assertFreshBackup throws when the newest backup predates the plan', () => {
    const dir = freshDir('catalog-backup-stale-')
    const backupPath = join(dir, 'catalog-backup-old.json')
    writeFileSync(backupPath, '{}')
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(backupPath, old, old)
    expect(() => assertFreshBackup({ createdAt: new Date().toISOString() }, dir)).toThrow(/is not newer than this plan/)
  })

  it('assertFreshBackup does not throw when the newest backup postdates the plan', () => {
    const dir = freshDir('catalog-backup-fresh-')
    const planCreatedAt = new Date(Date.now() - 60_000).toISOString()
    touchFakeBackup(dir)
    expect(() => assertFreshBackup({ createdAt: planCreatedAt }, dir)).not.toThrow()
  })

  it('applyPlan refuses to run (no Square call made) with no backup', async () => {
    const dir = freshDir('apply-no-backup-')
    const plan: CatalogPlan = { createdAt: new Date().toISOString(), category: 'Test', items: [] }
    await expect(applyPlan(plan, dir)).rejects.toThrow(/no backup found/)
  })

  it('applyPlan refuses to run with a backup older than the plan', async () => {
    const dir = freshDir('apply-stale-backup-')
    const backupPath = join(dir, 'catalog-backup-old.json')
    writeFileSync(backupPath, '{}')
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(backupPath, old, old)
    const plan: CatalogPlan = { createdAt: new Date().toISOString(), category: 'Test', items: [] }
    await expect(applyPlan(plan, dir)).rejects.toThrow(/is not newer than this plan/)
  })

  it('backupCatalog writes a real export findLatestBackup can find', async () => {
    const dir = freshDir('catalog-backup-real-')
    const result = await backupCatalog(dir)
    expect(result.objectCount).toBeGreaterThan(0)
    const latest = findLatestBackup(dir)
    expect(latest?.path).toBe(result.path)
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(parsed.objectCount).toBe(result.objectCount)
    expect(Array.isArray(parsed.objects)).toBe(true)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Guard 2: allowlist enforcement.
// ---------------------------------------------------------------------------
describe('guard 2: allowlist enforcement', () => {
  it('assertObjectAllowed throws for an id absent from the allowlist', () => {
    const allowlist = new Set(['A', 'B'])
    expect(() => assertObjectAllowed('C', allowlist, 'test context')).toThrow(/does not appear in the reviewed plan/)
  })

  it('assertObjectAllowed does not throw for an id present in the allowlist', () => {
    const allowlist = new Set(['A'])
    expect(() => assertObjectAllowed('A', allowlist, 'test context')).not.toThrow()
  })

  it('buildAllowlist includes exactly the squareItemId and legacyVariationId of every item', () => {
    const plan = makePlan('item-1', 'var-1', 'X')
    const allowlist = buildAllowlist(plan)
    expect(allowlist).toEqual(new Set(['item-1', 'var-1']))
  })

  it('applyPlan refuses to write when the catalog has drifted to carry a variation the plan never reviewed', async () => {
    const { itemId, variationId } = await createFlatItem('DriftGuard', 4200)

    // Simulate drift: something else adds an out-of-plan variation to this
    // item between plan and apply.
    const current = await square.catalog.object.get({ objectId: itemId })
    assertNoErrors(current, 'test drift read')
    const obj = current.object
    if (!isItem(obj) || !obj.itemData) throw new Error('test drift read: not a live ITEM')
    const driftRes = await square.catalog.object.upsert({
      idempotencyKey: randomUUID(),
      object: {
        ...obj,
        itemData: {
          ...obj.itemData,
          variations: [
            ...(obj.itemData.variations ?? []),
            {
              type: 'ITEM_VARIATION',
              id: `#drift_${RUN_ID}`,
              itemVariationData: {
                itemId,
                name: 'Unreviewed',
                pricingType: 'FIXED_PRICING',
                priceMoney: { amount: BigInt(4200), currency: 'USD' },
              },
            },
          ],
        },
      },
    })
    assertNoErrors(driftRes, 'test drift setup')

    const plan = makePlan(itemId, variationId, `DFT${RUN_ID}`)
    const dir = freshDir('apply-drift-')
    touchFakeBackup(dir)

    const results = await applyPlan(plan, dir)
    expect(results).toHaveLength(1)
    const [result] = results
    expect(result?.status).toBe('failed')
    expect(result?.error).toMatch(/drifted since this plan was built/)
    expect(result?.error).toMatch(/Unreviewed/)

    // Confirm no write happened: the item still carries exactly the
    // original + drift variation, nothing relabelled.
    const after = await square.catalog.object.get({ objectId: itemId })
    assertNoErrors(after, 'test post-drift-refusal read')
    const afterObj = after.object
    if (!isItem(afterObj) || !afterObj.itemData) throw new Error('test post-drift-refusal read: not a live ITEM')
    const afterVariations = afterObj.itemData.variations ?? []
    expect(afterVariations).toHaveLength(2)
    const legacy = afterVariations.filter(isItemVariation).find((v) => v.id === variationId)
    expect(legacy?.itemVariationData?.name).toBe('Regular')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Guard 3: no deletes, ever.
// ---------------------------------------------------------------------------
describe('guard 3: no deletes, ever', () => {
  it('square.catalog.object.delete throws before any HTTP call', async () => {
    await expect(square.catalog.object.delete({ objectId: 'does-not-matter' })).rejects.toThrow(
      /Refusing to delete a catalog object/,
    )
  })

  it('square.catalog.batchDelete throws before any HTTP call', async () => {
    await expect(square.catalog.batchDelete({ objectIds: ['does-not-matter'] })).rejects.toThrow(
      /Refusing to batch-delete catalog objects/,
    )
  })

  it('square.catalog.object.upsert throws for an ITEM upsert carrying isArchived: true', async () => {
    await expect(
      square.catalog.object.upsert({
        idempotencyKey: randomUUID(),
        object: { type: 'ITEM', id: '#never-sent', itemData: { name: 'x', isArchived: true } },
      }),
    ).rejects.toThrow(/isArchived: true/)
  })

  it('a normal, non-archiving upsert still passes through unguarded', async () => {
    // Confirms the guard is scoped to delete/archive, not to every write.
    const { itemId } = await createFlatItem('NonArchiveGuard', 1000)
    expect(itemId).toMatch(/^[A-Za-z0-9]+$/)
  })
})

// ---------------------------------------------------------------------------
// Guard 4: stop on first failure.
// ---------------------------------------------------------------------------
describe('guard 4: stop on first failure', () => {
  it('halts at the first failing category and never invokes the ones after it', async () => {
    const invoked: string[] = []
    const { results, haltedAt } = await runCategoriesSequentially(
      ['Scarves', 'Mittens', 'Socks', 'Stuffies', 'Capes'],
      async (category) => {
        invoked.push(category)
        if (category === 'Socks') return { ok: false, reason: 'verify failed on Socks' }
        return { ok: true }
      },
    )

    expect(invoked).toEqual(['Scarves', 'Mittens', 'Socks']) // Stuffies and Capes never ran
    expect(haltedAt).toBe('Socks')
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'failed'])
    expect(results[2]?.reason).toBe('verify failed on Socks')
  })

  it('runs every category and reports no halt when all succeed', async () => {
    const invoked: string[] = []
    const { results, haltedAt } = await runCategoriesSequentially(['A', 'B', 'C'], async (category) => {
      invoked.push(category)
      return { ok: true }
    })
    expect(invoked).toEqual(['A', 'B', 'C'])
    expect(haltedAt).toBeUndefined()
    expect(results.every((r) => r.status === 'ok')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Guard 5: rollback. The sandbox proof required by the build guide --
// apply, verify, roll back, and confirm the catalog matches the pre-apply
// backup.
// ---------------------------------------------------------------------------
describe('guard 5: rollback -- sandbox round trip', () => {
  it('applies, verifies, rolls back, and the live catalog matches the pre-apply backup', async () => {
    const backupsDir = freshDir('catalog-rollback-proof-')

    const { itemId, variationId } = await createFlatItem('RollbackProof', 6500)
    const orderId = await placeOrder(variationId, 1)

    const plan = makePlan(itemId, variationId, `RBP${RUN_ID}`)
    const [planItem] = plan.items
    if (!planItem) throw new Error('test setup: plan has no items')
    planItem.sampleOrderLineCatalogObjectIds = [variationId]

    // The real backup, taken before apply -- this is both what satisfies
    // guard 1 for this run and what the post-rollback state gets diffed
    // against at the end.
    const preApplyBackup = await backupCatalog(backupsDir)
    expect(preApplyBackup.objectCount).toBeGreaterThan(0)
    expect(() => assertFreshBackup(plan, backupsDir)).not.toThrow()

    const applyResults = await applyPlan(plan, backupsDir)
    expect(applyResults).toHaveLength(1)
    const [applyResult] = applyResults
    expect(applyResult?.status).toBe('applied')
    expect(Object.keys(applyResult?.newVariationIds ?? {}).sort()).toEqual([`RBP${RUN_ID}-BLU`, `RBP${RUN_ID}-GRN`].sort())

    const verifyResult = await verifyPlan(plan)
    expect(verifyResult.failures).toEqual([])
    expect(verifyResult.ok).toBe(true)

    const rollbackResults = await rollbackPlan(plan)
    expect(rollbackResults).toHaveLength(1)
    const [rollbackResult] = rollbackResults
    expect(rollbackResult?.status).toBe('rolled-back')
    const archivedIds = rollbackResult?.archivedVariationIds ?? []
    expect(archivedIds).toHaveLength(2)

    // Nothing was deleted -- the archived variations still resolve, just
    // hidden. This is what makes the round trip genuinely reversible.
    for (const id of archivedIds) {
      expect(await catalogObjectExists(id)).toBe(true)
    }

    const after = await square.catalog.object.get({ objectId: itemId })
    assertNoErrors(after, 'test post-rollback read')
    const afterObj = after.object
    if (!isItem(afterObj) || !afterObj.itemData) throw new Error('test post-rollback read: not a live ITEM')
    const afterVariations = (afterObj.itemData.variations ?? []).filter(isItemVariation)
    const afterLegacy = afterVariations.find((v) => v.id === variationId)
    expect(afterLegacy?.itemVariationData?.name).toBe('Regular')
    expect(afterLegacy?.itemVariationData?.sellable).toBe(true)
    for (const v of afterVariations) {
      if (v.id === variationId) continue
      expect(v.itemVariationData?.sellable).toBe(false)
    }

    // Confirm the live *sellable* state matches the pre-apply backup.
    // Because nothing is ever deleted, the archived variations remain on
    // the item permanently -- so this is a sellable-state comparison
    // (exactly what a cashier or a report would see), not a byte-identical
    // one. See the catalog-guards report for why that's the honest claim.
    type BackedUpObject = {
      id: string
      itemData?: {
        variations?: Array<{
          itemVariationData?: { name?: string; sellable?: boolean; priceMoney?: { amount: string } }
        }>
      }
    }
    const backupData = JSON.parse(readFileSync(preApplyBackup.path, 'utf8')) as { objects: BackedUpObject[] }
    const backedUpItem = backupData.objects.find((o) => o.id === itemId)
    expect(backedUpItem).toBeDefined()
    const backedUpVariations = backedUpItem?.itemData?.variations ?? []
    expect(backedUpVariations).toHaveLength(1)
    expect(backedUpVariations[0]?.itemVariationData?.name).toBe('Regular')
    expect(backedUpVariations[0]?.itemVariationData?.sellable).not.toBe(false)

    const liveSellable = afterVariations.filter((v) => v.itemVariationData?.sellable !== false)
    expect(liveSellable).toHaveLength(1)
    expect(liveSellable[0]?.itemVariationData?.name).toBe('Regular')
    expect(Number(liveSellable[0]?.itemVariationData?.priceMoney?.amount)).toBe(
      Number(backedUpVariations[0]?.itemVariationData?.priceMoney?.amount),
    )

    // The historical order line survives the whole round trip untouched.
    const orderRes = await square.orders.get({ orderId })
    assertNoErrors(orderRes, 'test post-rollback order check')
    const lineObjectId = orderRes.order?.lineItems?.[0]?.catalogObjectId
    expect(lineObjectId).toBe(variationId)
    expect(await catalogObjectExists(lineObjectId!)).toBe(true)

    // Rollback is itself idempotent.
    const secondRollback = await rollbackPlan(plan)
    expect(secondRollback[0]?.status).toBe('already-rolled-back')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Guard 6: preflight. Not in the build guide's required test list, but
// cheap (every call is a read) and worth a basic sanity check.
// ---------------------------------------------------------------------------
describe('guard 6: preflight', () => {
  it('reports go against the real sandbox with the right expectations, and no-go when the operator intent mismatches', async () => {
    const dir = freshDir('preflight-go-')
    touchFakeBackup(dir)
    const locations = await square.locations.list()
    assertNoErrors(locations, 'test preflight setup')
    const expectedLocationCount = (locations.locations ?? []).length

    const go = await runPreflight({
      expectedSquareEnv: 'sandbox',
      expectedLocationCount,
      backupsDir: dir,
    })
    expect(go.checks.find((c) => c.name === 'SQUARE_ENV matches intent')?.ok).toBe(true)
    expect(go.checks.find((c) => c.name === 'a backup exists')?.ok).toBe(true)
    expect(go.checks.find((c) => c.name === 'expected number of locations visible')?.ok).toBe(true)
    expect(go.go).toBe(true)

    const noGo = await runPreflight({
      expectedSquareEnv: 'production', // operator claims production intent while SQUARE_ENV is sandbox
      expectedLocationCount,
      backupsDir: dir,
    })
    expect(noGo.checks.find((c) => c.name === 'SQUARE_ENV matches intent')?.ok).toBe(false)
    expect(noGo.go).toBe(false)
  }, 30_000)

  it('reports no-go when no backup exists', async () => {
    const dir = freshDir('preflight-no-backup-')
    const result = await runPreflight({ expectedSquareEnv: 'sandbox', expectedLocationCount: 999, backupsDir: dir })
    expect(result.checks.find((c) => c.name === 'a backup exists')?.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'expected number of locations visible')?.ok).toBe(false)
    expect(result.go).toBe(false)
  })
})
