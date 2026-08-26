import './load-env.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { warehouseSku, checkCollisions } from '../catalog/sku.js'

/**
 * Fills `WarehouseVariant.warehouseSku` for every row using the two-level
 * scheme in `sku.ts` (spec §5.3, task-4 brief). Supplies rows are written
 * with `isSaleItem: false` -- warehouse-only, never sold at the till.
 *
 * Note: this CLI used to also generate `Variation.tillSku`, but that
 * column was dropped from the schema (see migration
 * `20260826..._drop_till_sku`). Till-facing SKUs are now derived on the
 * fly by `catalog-plan.ts` when a Square catalog push is prepared, not
 * stored per Variation.
 *
 * Determinism requires processing each abbreviation scope's inputs in a
 * fixed order every run -- see `sku.ts`'s `abbreviate`. The query below
 * sorts alphabetically by category, group, colour and size for that reason;
 * ItemGroup/ColourVariant/SizeOption names do not change once
 * imported, so the same sort always yields the same order forever.
 *
 * Collisions are a hard stop, not a warning: every SKU is computed in
 * memory first and checked with `checkCollisions` before any database
 * write happens. If there is a collision, the offenders are printed and
 * the process exits non-zero without touching the database.
 */

const SUPPLIES_CATEGORY = 'Supplies'

type WarehouseResult = { id: string; sku: string; isSaleItem: boolean }

async function computeSkus(prisma: PrismaService): Promise<{ whResults: WarehouseResult[] }> {
  const warehouseVariants = await prisma.warehouseVariant.findMany({
    include: {
      itemGroup: { include: { category: true } },
      colourVariant: true,
      sizeOption: true,
    },
    orderBy: [
      { itemGroup: { category: { name: 'asc' } } },
      { itemGroup: { name: 'asc' } },
      { colourVariant: { name: 'asc' } },
      { sizeOption: { name: 'asc' } },
    ],
  })

  const whResults: WarehouseResult[] = warehouseVariants.map((w) => ({
    id: w.id,
    sku: warehouseSku(
      w.itemGroup.category.name,
      w.itemGroup.name,
      w.colourVariant.name,
      w.sizeOption.name,
      w.itemGroup.brand,
    ),
    isSaleItem: w.itemGroup.category.name !== SUPPLIES_CATEGORY,
  }))

  return { whResults }
}

async function main(): Promise<void> {
  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const { whResults } = await computeSkus(prisma)

    const whCollisions = checkCollisions(whResults.map((r) => r.sku))

    if (whCollisions.length > 0) {
      console.error('\nSKU generation: COLLISIONS FOUND -- refusing to write anything.\n')
      console.error(`  warehouse-level (WarehouseVariant.warehouseSku), ${whCollisions.length} colliding code(s):`)
      for (const c of whCollisions) console.error(`    ${c.sku}  x${c.count}`)
      console.error('')
      process.exitCode = 1
      return
    }

    await prisma.$transaction(
      whResults.map((r) =>
        prisma.warehouseVariant.update({
          where: { id: r.id },
          data: { warehouseSku: r.sku, isSaleItem: r.isSaleItem },
        }),
      ),
    )

    console.log('\nSKU generation')
    console.log(`  warehouse SKUs (WarehouseVariant):  ${whResults.length} generated, 0 collisions`)
    console.log('')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
