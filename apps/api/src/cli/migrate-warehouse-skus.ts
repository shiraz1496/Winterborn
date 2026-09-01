import './load-env.js'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * One-off migration: rewrite `WarehouseVariant.warehouseSku` from the old
 * create-modal format (`WV-<COLOUR>-<8hex>`) to the new colourless format
 * (`WV-<8hex>`). Idempotent — running it twice is a no-op after the first
 * successful pass.
 *
 * Rationale: after product-creation.service.ts was updated to omit the
 * colour segment (so a colour rename never leaves a stale "BLUE" baked
 * into the SKU string), existing rows still carried the old format.
 * Those rows are what this migrates.
 *
 * Left alone:
 *   - Sortly-imported SKUs (raw SIDs from the Sortly export). Don't match
 *     the WV-<slug>-<hex> pattern.
 *   - `generate-skus.ts` spec-format SKUs (CAT-GRP-COL-SIZ). Also don't
 *     match the WV- pattern.
 *   - Anything already in the new WV-<8hex> format.
 *
 * Safety:
 *   - Dry-run by default. Pass `--apply` to actually write.
 *   - Refuses to write if the plan produces internal collisions or
 *     collides with an untouched row's existing SKU.
 *   - Writes are wrapped in one transaction so a mid-batch failure
 *     leaves the SKU column consistent (all migrated or none).
 *   - Every change writes an AuditLog row (`WarehouseVariant.warehouseSku`
 *     old → new) so the trail matches per-row PATCH audits.
 */

/// Old format: `WV-` + one or more uppercase alphanumeric/dash segments +
/// `-` + exactly 8 hex chars. The middle can be anything (single colour like
/// `BLUE`, multi-word like `DARK-GRAY`, punctuation-stripped `X` fallbacks).
const OLD_FORMAT = /^WV-[A-Z0-9-]+-[a-f0-9]{8}$/

/// New format: `WV-` + exactly 8 hex chars, nothing else.
const NEW_FORMAT = /^WV-[a-f0-9]{8}$/

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaService()
  await prisma.$connect()
  try {
    const rows = await prisma.warehouseVariant.findMany({
      select: {
        id: true,
        warehouseSku: true,
        itemGroupId: true,
        colourVariantId: true,
        sizeOptionId: true,
      },
      orderBy: { warehouseSku: 'asc' },
    })

    const plan: Array<{ id: string; oldSku: string; newSku: string }> = []
    let alreadyMigrated = 0
    let notOldFormat = 0

    for (const wv of rows) {
      if (NEW_FORMAT.test(wv.warehouseSku)) {
        alreadyMigrated++
        continue
      }
      if (!OLD_FORMAT.test(wv.warehouseSku)) {
        notOldFormat++
        continue
      }
      const seed = `${wv.itemGroupId}-${wv.colourVariantId}-${wv.sizeOptionId}`
      const newSku = `WV-${shortHash(seed)}`
      if (newSku !== wv.warehouseSku) {
        plan.push({ id: wv.id, oldSku: wv.warehouseSku, newSku })
      }
    }

    // Two collision checks:
    //   1. Two migrated rows resolve to the same new SKU (shouldn't happen
    //      given the hash inputs cover the unique tuple, but the schema
    //      dropped the DB-level uniqueness so legacy rows could in
    //      principle share a tuple — detect and refuse).
    //   2. A migrated row's new SKU is already worn by an untouched row
    //      (e.g. an already-migrated sibling or an unrelated row that
    //      happens to look like WV-<hex>).
    const newSkuCounts = new Map<string, string[]>()
    for (const p of plan) {
      const list = newSkuCounts.get(p.newSku) ?? []
      list.push(p.id)
      newSkuCounts.set(p.newSku, list)
    }
    const internalCollisions = [...newSkuCounts.entries()].filter(([, ids]) => ids.length > 1)

    const untouchedByNewSku = new Map<string, string>()
    for (const wv of rows) {
      const inPlan = plan.some((p) => p.id === wv.id)
      if (!inPlan) untouchedByNewSku.set(wv.warehouseSku, wv.id)
    }
    const externalCollisions = plan.filter((p) => untouchedByNewSku.has(p.newSku))

    console.log('\nSKU migration plan')
    console.log(`  ${rows.length} warehouse variants inspected`)
    console.log(`  ${alreadyMigrated} already in new format (WV-<hash>)`)
    console.log(`  ${notOldFormat} untouched (not old create-modal format — Sortly/spec SKUs)`)
    console.log(`  ${plan.length} to migrate WV-<COLOUR>-<hash> → WV-<hash>`)

    if (internalCollisions.length > 0 || externalCollisions.length > 0) {
      console.error('\nCOLLISIONS — refusing to write:')
      for (const [sku, ids] of internalCollisions) {
        console.error(`  ${sku} would be assigned to ${ids.length} rows: ${ids.join(', ')}`)
      }
      for (const p of externalCollisions) {
        console.error(`  ${p.newSku} already worn by row ${untouchedByNewSku.get(p.newSku)}`)
      }
      process.exitCode = 1
      return
    }

    if (plan.length === 0) {
      console.log('\nNothing to migrate.')
      return
    }

    const preview = plan.slice(0, 15)
    console.log('\nSample of planned changes:')
    for (const p of preview) console.log(`  ${p.oldSku}  →  ${p.newSku}`)
    if (plan.length > preview.length) {
      console.log(`  … and ${plan.length - preview.length} more`)
    }

    if (!apply) {
      console.log('\nDry run — pass --apply to write.')
      return
    }

    console.log('\nApplying…')
    await prisma.$transaction(async (tx) => {
      for (const p of plan) {
        await tx.warehouseVariant.update({
          where: { id: p.id },
          data: { warehouseSku: p.newSku },
        })
        await tx.auditLog.create({
          data: {
            entity: 'WarehouseVariant',
            entityId: p.id,
            field: 'warehouseSku',
            oldValue: p.oldSku,
            newValue: p.newSku,
            actorId: null,
            source: 'MIGRATION',
            reason: 'colour prefix stripped from SKU (product-creation format change)',
          },
        })
      }
    })
    console.log(`\nMigrated ${plan.length} SKUs. AuditLog rows written for each.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
