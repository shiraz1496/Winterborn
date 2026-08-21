import { PrismaService } from '../prisma/prisma.service.js'
import { tillSku, warehouseSku, checkCollisions } from '../catalog/sku.js'

/**
 * Fills `Variation.tillSku` and `WarehouseVariant.warehouseSku` for every
 * row using the two-level scheme in `sku.ts` (spec §5.3, task-4 brief).
 * Supplies rows are written with `isSaleItem: false` -- warehouse-only,
 * never sold at the till.
 *
 * Determinism requires processing each abbreviation scope's inputs in a
 * fixed order every run -- see `sku.ts`'s `abbreviate`. Both queries below
 * sort alphabetically by category, group, colour and size for that reason;
 * ItemGroup/ColourFamily/ColourVariant/SizeOption names do not change once
 * imported, so the same sort always yields the same order forever.
 *
 * Collisions are a hard stop, not a warning: every SKU at both levels is
 * computed in memory first and checked with `checkCollisions` before any
 * database write happens. If either level has a collision, the offenders
 * are printed and the process exits non-zero without touching the
 * database.
 */

const SUPPLIES_CATEGORY = 'Supplies'

type TillResult = { id: string; sku: string }
type WarehouseResult = { id: string; sku: string; isSaleItem: boolean }

async function computeSkus(
  prisma: PrismaService,
): Promise<{ tillResults: TillResult[]; whResults: WarehouseResult[] }> {
  const variations = await prisma.variation.findMany({
    include: {
      itemGroup: { include: { category: true } },
      colourFamily: true,
      sizeOption: true,
    },
    orderBy: [
      { itemGroup: { category: { name: 'asc' } } },
      { itemGroup: { name: 'asc' } },
      { colourFamily: { name: 'asc' } },
      { sizeOption: { name: 'asc' } },
    ],
  })

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

  const tillResults: TillResult[] = variations.map((v) => ({
    id: v.id,
    sku: tillSku(v.itemGroup.category.name, v.itemGroup.name, v.colourFamily.name, v.sizeOption.name),
  }))

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

  return { tillResults, whResults }
}

async function main(): Promise<void> {
  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const { tillResults, whResults } = await computeSkus(prisma)

    const tillCollisions = checkCollisions(tillResults.map((r) => r.sku))
    const whCollisions = checkCollisions(whResults.map((r) => r.sku))

    if (tillCollisions.length > 0 || whCollisions.length > 0) {
      console.error('\nSKU generation: COLLISIONS FOUND -- refusing to write anything.\n')
      if (tillCollisions.length > 0) {
        console.error(`  till-level (Variation.tillSku), ${tillCollisions.length} colliding code(s):`)
        for (const c of tillCollisions) console.error(`    ${c.sku}  x${c.count}`)
      }
      if (whCollisions.length > 0) {
        console.error(`  warehouse-level (WarehouseVariant.warehouseSku), ${whCollisions.length} colliding code(s):`)
        for (const c of whCollisions) console.error(`    ${c.sku}  x${c.count}`)
      }
      console.error('')
      process.exitCode = 1
      return
    }

    await prisma.$transaction(
      tillResults.map((r) => prisma.variation.update({ where: { id: r.id }, data: { tillSku: r.sku } })),
    )
    await prisma.$transaction(
      whResults.map((r) =>
        prisma.warehouseVariant.update({
          where: { id: r.id },
          data: { warehouseSku: r.sku, isSaleItem: r.isSaleItem },
        }),
      ),
    )

    console.log('\nSKU generation')
    console.log(`  till SKUs (Variation):              ${tillResults.length} generated, 0 collisions`)
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
