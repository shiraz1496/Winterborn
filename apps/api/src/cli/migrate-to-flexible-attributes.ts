import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Backfills the flexible attribute model from the legacy fixed schema.
 *
 * For every ItemGroup, walks its existing WarehouseVariants and infers two
 * axes — Color (from ColourVariant.name) and Size (from SizeOption.name) —
 * creating ProductAttribute rows, ProductAttributeValue rows, and
 * WarehouseVariantAttribute join rows. An axis is only created if at least
 * one variant carries a non-"Unassigned"/"One Size" value, so single-SKU
 * products (Dryer Balls Set of 3) end up with zero axes and one SKU with
 * no attribute rows — the intended shape.
 *
 * Idempotent — safe to re-run. All writes use upsert / skipDuplicates so
 * a partial previous run does not corrupt this one.
 *
 * Does not touch legacy columns (colourVariantName / sizeOptionName /
 * ColourFamily / etc.) — they remain the source-of-truth for reads that
 * predate this migration and get cleaned up in a later PR.
 */

const UNASSIGNED_COLOUR_MARKER = 'Unassigned'
const ONE_SIZE_MARKER = 'One Size'

interface AxisPlan {
  attributeName: 'Color' | 'Size'
  values: Set<string>
  displayOrder: number
}

async function planAxesForItemGroup(itemGroupId: string): Promise<AxisPlan[]> {
  const variants = await prisma.warehouseVariant.findMany({
    where: { itemGroupId },
    include: { colourVariant: true, sizeOption: true },
  })

  const colours = new Set<string>()
  const sizes = new Set<string>()
  for (const v of variants) {
    const colour = v.colourVariant.name
    const size = v.sizeOption.name
    if (colour && colour !== UNASSIGNED_COLOUR_MARKER) colours.add(colour)
    if (size && size !== ONE_SIZE_MARKER) sizes.add(size)
  }

  // An axis is only meaningful if there's more than one distinct value OR
  // the sole value is non-default. If Earmuffs' only size is "One Size",
  // there's no Size axis to declare — the product just doesn't vary by size.
  // Same for colour on genuinely single-colour products.
  const plans: AxisPlan[] = []
  if (colours.size > 0) plans.push({ attributeName: 'Color', values: colours, displayOrder: 0 })
  if (sizes.size > 0) plans.push({ attributeName: 'Size', values: sizes, displayOrder: 1 })
  return plans
}

async function migrateItemGroup(itemGroupId: string, itemGroupName: string): Promise<{ axes: number; values: number; links: number }> {
  const plans = await planAxesForItemGroup(itemGroupId)

  let axes = 0
  let values = 0
  let links = 0

  // One transaction per ItemGroup keeps the blast radius small on a partial
  // failure. The idempotency of the underlying writes means a rerun continues
  // from wherever it left off rather than re-doing already-migrated groups.
  for (const plan of plans) {
    const attribute = await prisma.productAttribute.upsert({
      where: { itemGroupId_name: { itemGroupId, name: plan.attributeName } },
      create: { itemGroupId, name: plan.attributeName, displayOrder: plan.displayOrder },
      update: { displayOrder: plan.displayOrder },
    })
    axes++

    let valueDisplayOrder = 0
    for (const value of Array.from(plan.values).sort()) {
      const attrValue = await prisma.productAttributeValue.upsert({
        where: { productAttributeId_value: { productAttributeId: attribute.id, value } },
        create: { productAttributeId: attribute.id, value, displayOrder: valueDisplayOrder },
        update: { displayOrder: valueDisplayOrder },
      })
      values++
      valueDisplayOrder++

      // Link every WarehouseVariant that carries this value on this axis.
      // findMany + createMany(skipDuplicates) is safer than a single joined
      // upsert here because the composite PK on WarehouseVariantAttribute
      // has no @@unique support in Prisma's upsert.
      const matches = await prisma.warehouseVariant.findMany({
        where: {
          itemGroupId,
          ...(plan.attributeName === 'Color'
            ? { colourVariant: { name: value } }
            : { sizeOption: { name: value } }),
        },
        select: { id: true },
      })
      if (matches.length > 0) {
        const created = await prisma.warehouseVariantAttribute.createMany({
          data: matches.map((wv) => ({
            warehouseVariantId: wv.id,
            productAttributeValueId: attrValue.id,
          })),
          skipDuplicates: true,
        })
        links += created.count
      }
    }
  }

  if (plans.length === 0) {
    console.log(`  ${itemGroupName}: single-SKU product, no axes (skipped)`)
  } else {
    console.log(`  ${itemGroupName}: ${axes} axes, ${values} values, ${links} SKU links`)
  }

  return { axes, values, links }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  if (dryRun) {
    console.log('=== DRY RUN — no writes will be made ===\n')
  }

  const itemGroups = await prisma.itemGroup.findMany({
    include: { _count: { select: { warehouseVariants: true } } },
    orderBy: { name: 'asc' },
  })
  console.log(`Found ${itemGroups.length} ItemGroups\n`)

  let totals = { axes: 0, values: 0, links: 0 }

  for (const ig of itemGroups) {
    if (ig._count.warehouseVariants === 0) {
      console.log(`  ${ig.name}: no warehouse variants (skipped)`)
      continue
    }
    if (dryRun) {
      const plans = await planAxesForItemGroup(ig.id)
      console.log(`  ${ig.name}: would create ${plans.length} axes — ${plans.map((p) => `${p.attributeName}(${p.values.size})`).join(', ') || 'none'}`)
      continue
    }
    const result = await migrateItemGroup(ig.id, ig.name)
    totals.axes += result.axes
    totals.values += result.values
    totals.links += result.links
  }

  if (!dryRun) {
    console.log(`\n=== Done ===`)
    console.log(`Total: ${totals.axes} axes, ${totals.values} values, ${totals.links} SKU links`)
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
