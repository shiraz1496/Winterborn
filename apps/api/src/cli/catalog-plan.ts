import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaService } from '../prisma/prisma.service.js'
import { buildPlan } from '../catalog/catalog-plan.js'

/**
 * `catalog-plan --category <name>` -- computes the intended Square writes
 * for every joined `ItemGroup` in `category` and prints a full diff.
 * Mutates nothing: every read in `buildPlan` is a `catalog.object.get`.
 * Writes the plan to a JSON file so what was reviewed here is exactly
 * what `catalog-apply` runs.
 */

function parseArgs(argv: string[]): { category: string; out?: string } {
  const catIdx = argv.indexOf('--category')
  const category = catIdx === -1 ? undefined : argv[catIdx + 1]
  if (!category) throw new Error('usage: cli:catalog-plan -- --category <name> [--out <file>]')
  const outIdx = argv.indexOf('--out')
  const out = outIdx === -1 ? undefined : argv[outIdx + 1]
  return { category, out }
}

async function main(): Promise<void> {
  const { category, out } = parseArgs(process.argv.slice(2))
  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const plan = await buildPlan(prisma, category)
    const outPath = resolve(process.cwd(), out ?? `catalog-plan-${category.toLowerCase()}.json`)
    writeFileSync(outPath, JSON.stringify(plan, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))

    console.log(`\nCatalog plan: ${category}`)
    console.log(`  items touched: ${plan.items.length}`)
    for (const item of plan.items) {
      console.log(`\n  ${item.itemGroupName}  (${item.squareItemId})`)
      console.log(`    legacy variation ${item.legacyVariationId} -> "${item.legacyLabel}", sellable: false`)
      console.log(
        `    present_at_location_ids: ${item.presentAtLocationIds ? `[${item.presentAtLocationIds.length} locations]` : 'presentAtAllLocations=' + item.presentAtAllLocations}`,
      )
      console.log(`    overrides to reapply on every new variation: ${item.capturedOverrides.length}`)
      for (const o of item.capturedOverrides) {
        console.log(`      - ${o.locationId}: ${(o.priceCents / 100).toFixed(2)} ${o.currency}`)
      }
      console.log(`    new variations (${item.newVariations.length}):`)
      for (const nv of item.newVariations) {
        console.log(`      - ${nv.variationName}  sku=${nv.sku}  ${(nv.priceCents / 100).toFixed(2)} ${nv.currency}`)
      }
    }
    console.log(`\n  plan written to ${outPath}\n`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
