import type { Square } from 'square'
import type { PrismaService } from '../prisma/prisma.service.js'
import { square, assertNoErrors } from './square-client.js'
import { assertFreshBackup } from './catalog-backup.js'

/**
 * Builds, applies and verifies the flat-item-to-colour-variations catalog
 * restructure (task-5 brief, spec §8.3/§8.4), per the binding rules in
 * `docs/superpowers/decisions/2026-08-19-flat-item-migration.md`:
 *
 *   1. Preserve and relabel -- read-modify-write the existing ITEM, keep
 *      `item_id`, never delete the original variation. Rename it to
 *      `Unspecified (pre-2026)` and mark it unsellable.
 *   2. New variations come out with no `locationOverrides` at all --
 *      absent, not empty -- so `applyPlan` must reapply the legacy
 *      variation's overrides onto every new variation explicitly, and
 *      `verifyPlan` must fail the run if any are missing.
 *
 * `buildPlan` reads and mutates nothing in Square. `applyPlan` performs
 * the writes. `verifyPlan` re-reads and asserts. `catalog-plan`/
 * `catalog-apply`/`catalog-verify` (the three CLIs) are thin wrappers
 * around these three functions, sharing this one plan shape so what was
 * reviewed on disk is what actually runs.
 */

const LEGACY_LABEL = 'Unspecified (pre-2026)'

export type PlanOverride = { locationId: string; priceCents: number; currency: string }

export type NewVariationPlan = {
  /** Client-supplied temp ID (`#...`) used when creating this variation. */
  tempId: string
  /** What the cashier sees, e.g. the colour family name. */
  variationName: string
  /** The till SKU from Task 4 -- written to Square's `sku` field. */
  sku: string
  priceCents: number
  currency: string
}

export type ItemPlan = {
  itemGroupId: string
  itemGroupName: string
  squareItemId: string
  legacyVariationId: string
  legacyLabel: string
  /**
   * The legacy variation's name and flags exactly as they were before
   * migration -- e.g. `"Regular"`, `sellable: true`. `catalog-rollback`
   * writes these back verbatim to reverse the relabel step (build guide
   * guard 5); without capturing them here at plan time, rollback would
   * have nothing to restore *to*.
   */
  originalLegacyName: string
  originalLegacySellable: boolean
  originalLegacyStockable: boolean
  /** Read from the legacy variation before migration; reapplied onto every new variation. */
  capturedOverrides: PlanOverride[]
  presentAtLocationIds?: string[]
  presentAtAllLocations?: boolean
  newVariations: NewVariationPlan[]
  /**
   * Optional: catalog object IDs of historical order lines known to
   * reference the legacy variation, for `verifyPlan` to confirm still
   * resolve after migration. Not populated by `buildPlan` against
   * production data (Square, not this schema, is the source of order
   * history) -- present only when a caller supplies it directly, as the
   * sandbox proof run does for its own seeded orders.
   */
  sampleOrderLineCatalogObjectIds?: string[]
}

export type CatalogPlan = {
  createdAt: string
  category: string
  items: ItemPlan[]
}

function isItem(obj: Square.CatalogObject | undefined): obj is Square.CatalogObject.Item {
  return obj?.type === 'ITEM'
}

function isItemVariation(obj: Square.CatalogObject): obj is Square.CatalogObject.ItemVariation {
  return obj.type === 'ITEM_VARIATION'
}

/**
 * Computes the intended Square writes for every `ItemGroup` in `category`
 * that has been joined to a Square item (`squareItemId` set by
 * `join-square.ts`). Mutates nothing in Square -- every call here is a
 * read. Throws if a joined item is not a flat (exactly one variation)
 * ITEM, since the read-modify-write shape this plan builds assumes that.
 */
export async function buildPlan(prisma: PrismaService, category: string): Promise<CatalogPlan> {
  const itemGroups = await prisma.itemGroup.findMany({
    where: { category: { name: category }, squareItemId: { not: null } },
    include: { variations: { include: { colourFamily: true, sizeOption: true } } },
    orderBy: { name: 'asc' },
  })

  const items: ItemPlan[] = []
  for (const group of itemGroups) {
    const squareItemId = group.squareItemId
    if (!squareItemId) continue

    const current = await square.catalog.object.get({ objectId: squareItemId })
    assertNoErrors(current, `catalog.object.get (buildPlan ${group.name})`)
    const obj = current.object
    if (!isItem(obj) || !obj.itemData) {
      throw new Error(`buildPlan: ${squareItemId} (${group.name}) is not a live ITEM`)
    }

    const existingVariations = (obj.itemData.variations ?? []).filter(isItemVariation)
    if (existingVariations.length !== 1) {
      throw new Error(
        `buildPlan: ${group.name} (${squareItemId}) has ${existingVariations.length} existing variations, ` +
          `expected exactly 1 (a flat item). Item groups that already carry structure are out of scope here -- ` +
          `see decision record Consequences item 8.`,
      )
    }
    const legacy = existingVariations[0]
    if (!legacy) throw new Error(`buildPlan: ${squareItemId} (${group.name}) has no variations`)
    const legacyData = legacy.itemVariationData
    const legacyPriceCents = legacyData?.priceMoney?.amount !== undefined ? Number(legacyData.priceMoney.amount) : 0
    const currency = legacyData?.priceMoney?.currency ?? 'USD'

    const capturedOverrides: PlanOverride[] = (legacyData?.locationOverrides ?? [])
      .filter((o) => o.locationId && o.priceMoney?.amount !== undefined)
      .map((o) => ({
        locationId: o.locationId!,
        priceCents: Number(o.priceMoney!.amount),
        currency: o.priceMoney!.currency ?? currency,
      }))

    const newVariations: NewVariationPlan[] = group.variations.map((v, i) => ({
      tempId: `#new_${group.id}_${i}`,
      variationName: v.colourFamily.name,
      sku: v.tillSku,
      priceCents: legacyPriceCents,
      currency,
    }))

    items.push({
      itemGroupId: group.id,
      itemGroupName: group.name,
      squareItemId,
      legacyVariationId: legacy.id,
      legacyLabel: LEGACY_LABEL,
      originalLegacyName: legacyData?.name ?? group.name,
      originalLegacySellable: legacyData?.sellable ?? true,
      originalLegacyStockable: legacyData?.stockable ?? true,
      capturedOverrides,
      presentAtLocationIds: obj.presentAtLocationIds ?? undefined,
      presentAtAllLocations: obj.presentAtAllLocations ?? undefined,
      newVariations,
    })
  }

  return { createdAt: new Date().toISOString(), category, items }
}

/**
 * Every Square object ID `applyPlan` is authorised to write, computed once
 * from the reviewed plan file. Build guide guard 2 ("allowlist
 * enforcement"): someone read a diff of exactly these objects, and only
 * what they read is allowed to change.
 */
export function buildAllowlist(plan: CatalogPlan): Set<string> {
  const ids = new Set<string>()
  for (const item of plan.items) {
    ids.add(item.squareItemId)
    ids.add(item.legacyVariationId)
  }
  return ids
}

/** Throws before any Square call is made if `objectId` was not reviewed as part of the plan. */
export function assertObjectAllowed(objectId: string, allowlist: Set<string>, context: string): void {
  if (!allowlist.has(objectId)) {
    throw new Error(
      `${context}: refusing to write object ${objectId} -- it does not appear in the reviewed plan. ` +
        `catalog-apply may only touch object IDs a human read in the plan diff.`,
    )
  }
}

export type ApplyOutcome = {
  itemGroupId: string
  itemGroupName: string
  squareItemId: string
  status: 'applied' | 'already-applied' | 'failed'
  newVariationIds?: Record<string, string>
  error?: string
}

/**
 * Executes a plan: read-modify-write per item, exactly per the decision
 * record -- fetch the current item, relabel the legacy variation without
 * deleting it, append the new colour variations with the captured
 * overrides reapplied explicitly, upsert with the same item `id`.
 *
 * Idempotent and resumable: the idempotency key is derived from the plan
 * (`squareItemId` + `plan.createdAt`, not `randomUUID()` -- decision
 * record Consequences item 10), and before writing, the current state is
 * checked for "already migrated" (legacy variation already relabelled,
 * variation count already matches the plan) so a re-run after a partial
 * failure skips items that already succeeded rather than reprocessing
 * them.
 *
 * `backupsDir` defaults to the real `data/backups` -- the only reason to
 * override it is test isolation (see `test/catalog-guards.spec.ts`).
 */
export async function applyPlan(plan: CatalogPlan, backupsDir = 'data/backups'): Promise<ApplyOutcome[]> {
  // Build guide guard 1: hard stop, not a warning. This runs before a
  // single Square call is made, regardless of which caller reached
  // applyPlan -- the catalog-apply CLI, catalog-migrate's per-category
  // loop, or a test.
  assertFreshBackup(plan, backupsDir)

  // Build guide guard 2: every object this run is authorised to touch,
  // fixed before the first write.
  const allowlist = buildAllowlist(plan)

  const results: ApplyOutcome[] = []

  for (const item of plan.items) {
    try {
      assertObjectAllowed(item.squareItemId, allowlist, `applyPlan (${item.itemGroupName})`)
      assertObjectAllowed(item.legacyVariationId, allowlist, `applyPlan (${item.itemGroupName})`)

      const current = await square.catalog.object.get({ objectId: item.squareItemId })
      assertNoErrors(current, `catalog.object.get (applyPlan read ${item.itemGroupName})`)
      const obj = current.object
      if (!isItem(obj) || !obj.itemData) {
        throw new Error(`${item.squareItemId} is not a live ITEM`)
      }
      const existing = (obj.itemData.variations ?? []).filter(isItemVariation)

      // Catalog drift since the plan was built: some variation on this item
      // other than the reviewed legacy variation, and not one of the SKUs
      // this plan says it creates (which is what a prior successful apply
      // legitimately leaves behind -- recognised by SKU, since a new
      // variation's real, server-assigned ID isn't known until after it's
      // created). Writing here would silently drop whatever that object is
      // from the item's variation list, or relabel something nobody
      // reviewed -- refuse instead, per the same allowlist principle as
      // above: only IDs a human read in the plan diff may be touched.
      const newSkus = new Set(item.newVariations.map((nv) => nv.sku))
      const unplanned = existing.filter(
        (v) => v.id !== item.legacyVariationId && !newSkus.has(v.itemVariationData?.sku ?? '__no_sku__'),
      )
      if (unplanned.length > 0) {
        throw new Error(
          `applyPlan (${item.itemGroupName}): ${item.squareItemId} carries ${unplanned.length} ` +
            `variation(s) not accounted for in the plan (${unplanned.map((v) => `${v.id} "${v.itemVariationData?.name}"`).join(', ')}) -- ` +
            `the catalog has drifted since this plan was built. Refusing to write: a write here would ` +
            `either drop those variations from the item or relabel something nobody reviewed. Re-run ` +
            `catalog-plan and review the new diff before applying.`,
        )
      }

      const alreadyApplied =
        existing.length === 1 + item.newVariations.length &&
        existing.some((v) => v.id === item.legacyVariationId && v.itemVariationData?.name === item.legacyLabel)

      if (alreadyApplied) {
        results.push({
          itemGroupId: item.itemGroupId,
          itemGroupName: item.itemGroupName,
          squareItemId: item.squareItemId,
          status: 'already-applied',
        })
        continue
      }

      const legacy = existing.find((v) => v.id === item.legacyVariationId)
      if (!legacy) throw new Error(`legacy variation ${item.legacyVariationId} not found on ${item.squareItemId}`)

      const relabelledLegacy: Square.CatalogObject.ItemVariation = {
        ...legacy,
        itemVariationData: {
          ...legacy.itemVariationData,
          name: item.legacyLabel,
          sellable: false,
          stockable: true,
        },
      }

      // Reapply the captured overrides explicitly onto EVERY new
      // variation. Without this, Square's default for a from-scratch
      // object -- no locationOverrides, presentAtAllLocations: true -- is
      // exactly what silently flattens the Carmel premium onto every
      // market. See decision record Consequences item 2.
      const overridesForNew =
        item.capturedOverrides.length > 0
          ? item.capturedOverrides.map((o) => ({
              locationId: o.locationId,
              priceMoney: { amount: BigInt(o.priceCents), currency: o.currency as Square.Currency },
              pricingType: 'FIXED_PRICING' as const,
            }))
          : undefined

      const newVariationObjects: Square.CatalogObject.Request[] = item.newVariations.map((nv) => ({
        type: 'ITEM_VARIATION',
        id: nv.tempId,
        itemVariationData: {
          itemId: item.squareItemId,
          name: nv.variationName,
          sku: nv.sku,
          pricingType: 'FIXED_PRICING',
          priceMoney: { amount: BigInt(nv.priceCents), currency: nv.currency as Square.Currency },
          sellable: true,
          stockable: true,
          locationOverrides: overridesForNew,
        },
      }))

      const idempotencyKey = `catalog-apply-${item.squareItemId}-${plan.createdAt}`

      const res = await square.catalog.object.upsert({
        idempotencyKey,
        object: {
          ...obj,
          itemData: {
            ...obj.itemData,
            variations: [relabelledLegacy, ...newVariationObjects],
          },
        },
      })
      assertNoErrors(res, `catalog.object.upsert (applyPlan write ${item.itemGroupName})`)

      const saved = res.catalogObject
      if (!isItem(saved) || !saved.itemData) {
        throw new Error(`upsert for ${item.squareItemId} returned no ITEM object`)
      }

      const newVariationIds: Record<string, string> = {}
      for (const v of (saved.itemData.variations ?? []).filter(isItemVariation)) {
        const sku = v.itemVariationData?.sku
        if (sku) newVariationIds[sku] = v.id
      }

      results.push({
        itemGroupId: item.itemGroupId,
        itemGroupName: item.itemGroupName,
        squareItemId: saved.id,
        status: 'applied',
        newVariationIds,
      })
    } catch (err) {
      results.push({
        itemGroupId: item.itemGroupId,
        itemGroupName: item.itemGroupName,
        squareItemId: item.squareItemId,
        status: 'failed',
        error: (err as Error).message,
      })
    }
  }

  return results
}

export type VerifyFailure = { itemGroupName: string; reason: string }
export type VerifyResult = { ok: boolean; failures: VerifyFailure[] }

/**
 * Re-reads every item in the plan from Square and asserts the decision
 * record's gate, item by item: `item_id` unchanged, the legacy variation
 * still present/unsellable/correctly labelled, `present_at_location_ids`
 * intact, historical order lines (when supplied) still resolving, and --
 * "the one that matters" per the brief -- every override captured in the
 * plan present on every new variation. Never throws on a failed
 * assertion; collects every failure and returns `ok: false` so the CLI
 * can report everything wrong in one run rather than stopping at the
 * first problem.
 */
export async function verifyPlan(plan: CatalogPlan): Promise<VerifyResult> {
  const failures: VerifyFailure[] = []

  for (const item of plan.items) {
    const res = await square.catalog.object.get({ objectId: item.squareItemId })
    assertNoErrors(res, `catalog.object.get (verifyPlan ${item.itemGroupName})`)
    const obj = res.object

    if (!isItem(obj) || !obj.itemData) {
      failures.push({ itemGroupName: item.itemGroupName, reason: `${item.squareItemId} is no longer a live ITEM` })
      continue
    }
    if (obj.id !== item.squareItemId) {
      failures.push({
        itemGroupName: item.itemGroupName,
        reason: `item_id changed: expected ${item.squareItemId}, got ${obj.id}`,
      })
    }

    const variations = (obj.itemData.variations ?? []).filter(isItemVariation)

    const legacy = variations.find((v) => v.id === item.legacyVariationId)
    if (!legacy) {
      failures.push({
        itemGroupName: item.itemGroupName,
        reason: `legacy variation ${item.legacyVariationId} is no longer present`,
      })
    } else {
      if (legacy.itemVariationData?.name !== item.legacyLabel) {
        failures.push({
          itemGroupName: item.itemGroupName,
          reason: `legacy variation name is "${legacy.itemVariationData?.name}", expected "${item.legacyLabel}"`,
        })
      }
      if (legacy.itemVariationData?.sellable !== false) {
        failures.push({
          itemGroupName: item.itemGroupName,
          reason: `legacy variation sellable is ${legacy.itemVariationData?.sellable}, expected false`,
        })
      }
    }

    if (item.presentAtLocationIds !== undefined) {
      const actual = obj.presentAtLocationIds
      const same =
        Array.isArray(actual) &&
        actual.length === item.presentAtLocationIds.length &&
        item.presentAtLocationIds.every((id) => actual.includes(id))
      if (!same) {
        failures.push({
          itemGroupName: item.itemGroupName,
          reason: `present_at_location_ids changed: expected ${JSON.stringify(item.presentAtLocationIds)}, got ${JSON.stringify(actual)}`,
        })
      }
    }

    if (item.sampleOrderLineCatalogObjectIds) {
      for (const lineObjectId of item.sampleOrderLineCatalogObjectIds) {
        try {
          const lineRes = await square.catalog.object.get({ objectId: lineObjectId })
          assertNoErrors(lineRes, `catalog.object.get (verifyPlan order line ${lineObjectId})`)
          if (!lineRes.object) {
            failures.push({
              itemGroupName: item.itemGroupName,
              reason: `historical order line's catalog object ${lineObjectId} no longer resolves`,
            })
          }
        } catch {
          failures.push({
            itemGroupName: item.itemGroupName,
            reason: `historical order line's catalog object ${lineObjectId} no longer resolves`,
          })
        }
      }
    }

    // The one that matters: every override captured in the plan must be
    // present on every new variation, or a customer at that market pays
    // the flat price on exactly the row they buy.
    for (const nv of item.newVariations) {
      const found = variations.find((v) => v.itemVariationData?.sku === nv.sku)
      if (!found) {
        failures.push({ itemGroupName: item.itemGroupName, reason: `new variation with sku "${nv.sku}" not found` })
        continue
      }
      const actualOverrides = found.itemVariationData?.locationOverrides ?? []
      for (const expected of item.capturedOverrides) {
        const match = actualOverrides.find(
          (o) =>
            o.locationId === expected.locationId &&
            o.priceMoney?.amount !== undefined &&
            Number(o.priceMoney.amount) === expected.priceCents &&
            o.pricingType === 'FIXED_PRICING',
        )
        if (!match) {
          failures.push({
            itemGroupName: item.itemGroupName,
            reason:
              `variation "${nv.sku}": missing override for location ${expected.locationId} ` +
              `(expected ${expected.priceCents} cents, FIXED_PRICING)`,
          })
        }
      }
    }
  }

  return { ok: failures.length === 0, failures }
}
