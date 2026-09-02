import './load-env.js'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Arbitrary-pairing catalog mapper: assigns each cached Square catalog
 * item/variation to an available local ItemGroup / WarehouseVariant
 * WITHOUT trying to match by name.
 *
 * Why arbitrary rather than name-matched: the Sortly-imported catalog and
 * the Square sandbox catalog were seeded from completely different sources
 * with unrelated naming conventions. Name matching produces near-zero
 * hits, which then makes the Square backfill useless (every order dead-
 * letters). For a demo, any consistent mapping is fine — the recommendation
 * engine only needs *some* SALE rows tied to *some* local variations to
 * exercise the flow.
 *
 * Pairing algorithm (deterministic — sort both sides by id, walk in order):
 *   1. ItemGroups that already have a squareItemId are skipped (respects
 *      hand-mapped rows).
 *   2. SquareCatalogItems that are already claimed by an ItemGroup are
 *      skipped.
 *   3. Walk Square items in id order; for each, take the next available
 *      ItemGroup in id order and wire them together.
 *   4. Under that pair, walk the Square variations in id order and wire
 *      each to the next available WarehouseVariant under the local ItemGroup.
 *   5. If the local pool runs out (fewer ItemGroups than Square items, or
 *      fewer WarehouseVariants than Square variations), stop cleanly and
 *      report what was left over.
 *
 * The Variation.squareVariationId family fallback is set only when the
 * ItemGroup has exactly one Variation with one WarehouseVariant — a family-
 * level mapping on a multi-variant product would silently misdirect sales.
 *
 * Safety:
 *   - Dry-run by default. Pass `--apply` to write.
 *   - Skips rows where the target column is already set (won't overwrite).
 *   - `--wipe` clears all squareItemId / squareVariationId columns first
 *     so you can re-map from scratch after a bad run.
 */

interface Plan {
  itemGroups: Array<{ itemGroupId: string; itemGroupName: string; squareItemId: string; squareItemName: string }>
  warehouseVariants: Array<{
    warehouseVariantId: string
    warehouseSku: string
    itemGroupName: string
    squareVariationId: string
    squareVariationName: string
  }>
  variations: Array<{ variationId: string; itemGroupName: string; squareVariationId: string; squareVariationName: string }>
  leftover: {
    unusedSquareItems: number
    unusedLocalItemGroups: number
    unusedSquareVariationsPerItem: number
    unusedLocalWarehouseVariantsPerItem: number
  }
}

async function wipe(prisma: PrismaService): Promise<void> {
  await prisma.$transaction([
    prisma.warehouseVariant.updateMany({ where: { squareVariationId: { not: null } }, data: { squareVariationId: null } }),
    prisma.variation.updateMany({ where: { squareVariationId: { not: null } }, data: { squareVariationId: null } }),
    prisma.itemGroup.updateMany({ where: { squareItemId: { not: null } }, data: { squareItemId: null } }),
  ])
}

async function buildPlan(prisma: PrismaService): Promise<Plan> {
  const [squareItems, itemGroups, warehouseVariants, variations] = await Promise.all([
    prisma.squareCatalogItem.findMany({
      include: { variations: { orderBy: { squareVariationId: 'asc' } } },
      orderBy: { squareItemId: 'asc' },
    }),
    prisma.itemGroup.findMany({
      select: { id: true, name: true, squareItemId: true },
      orderBy: { id: 'asc' },
    }),
    prisma.warehouseVariant.findMany({
      select: { id: true, itemGroupId: true, warehouseSku: true, squareVariationId: true, variationId: true },
      orderBy: { id: 'asc' },
    }),
    prisma.variation.findMany({
      select: { id: true, itemGroupId: true, squareVariationId: true },
      orderBy: { id: 'asc' },
    }),
  ])

  const wvsByItemGroup = new Map<string, typeof warehouseVariants>()
  for (const wv of warehouseVariants) {
    const bucket = wvsByItemGroup.get(wv.itemGroupId) ?? []
    bucket.push(wv)
    wvsByItemGroup.set(wv.itemGroupId, bucket)
  }
  const variationsByItemGroup = new Map<string, typeof variations>()
  for (const v of variations) {
    const bucket = variationsByItemGroup.get(v.itemGroupId) ?? []
    bucket.push(v)
    variationsByItemGroup.set(v.itemGroupId, bucket)
  }

  const availableItemGroups = itemGroups.filter((ig) => !ig.squareItemId)
  const claimedSquareItemIds = new Set(itemGroups.map((ig) => ig.squareItemId).filter(Boolean) as string[])

  const plan: Plan = {
    itemGroups: [],
    warehouseVariants: [],
    variations: [],
    leftover: {
      unusedSquareItems: 0,
      unusedLocalItemGroups: 0,
      unusedSquareVariationsPerItem: 0,
      unusedLocalWarehouseVariantsPerItem: 0,
    },
  }

  let localCursor = 0
  for (const sqItem of squareItems) {
    if (claimedSquareItemIds.has(sqItem.squareItemId)) continue
    if (localCursor >= availableItemGroups.length) {
      plan.leftover.unusedSquareItems++
      continue
    }
    const ig = availableItemGroups[localCursor++]!

    plan.itemGroups.push({
      itemGroupId: ig.id,
      itemGroupName: ig.name,
      squareItemId: sqItem.squareItemId,
      squareItemName: sqItem.name,
    })

    // Pool of unmapped WarehouseVariants under this local ItemGroup.
    const wvPool = (wvsByItemGroup.get(ig.id) ?? []).filter((wv) => !wv.squareVariationId)
    const localVariations = variationsByItemGroup.get(ig.id) ?? []

    let sqVarIdx = 0
    for (const sqVar of sqItem.variations) {
      if (sqVarIdx >= wvPool.length) {
        plan.leftover.unusedSquareVariationsPerItem++
        continue
      }
      const wv = wvPool[sqVarIdx++]!
      plan.warehouseVariants.push({
        warehouseVariantId: wv.id,
        warehouseSku: wv.warehouseSku,
        itemGroupName: ig.name,
        squareVariationId: sqVar.squareVariationId,
        squareVariationName: sqVar.name,
      })

      // Family fallback: fill Variation.squareVariationId only if the
      // ItemGroup has exactly one Variation. Wiring a family-level id on
      // a multi-variation product would let a POS sale route to whichever
      // variation the mapper resolved first, silently misdirecting stock.
      if (localVariations.length === 1) {
        const va = localVariations[0]!
        if (!va.squareVariationId && sqVarIdx === 1) {
          plan.variations.push({
            variationId: va.id,
            itemGroupName: ig.name,
            squareVariationId: sqVar.squareVariationId,
            squareVariationName: sqVar.name,
          })
        }
      }
    }

    plan.leftover.unusedLocalWarehouseVariantsPerItem += Math.max(0, wvPool.length - sqVarIdx)
  }

  plan.leftover.unusedLocalItemGroups = availableItemGroups.length - localCursor

  return plan
}

async function applyPlan(prisma: PrismaService, plan: Plan): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const row of plan.itemGroups) {
      await tx.itemGroup.update({ where: { id: row.itemGroupId }, data: { squareItemId: row.squareItemId } })
    }
    for (const row of plan.warehouseVariants) {
      await tx.warehouseVariant.update({
        where: { id: row.warehouseVariantId },
        data: { squareVariationId: row.squareVariationId },
      })
    }
    for (const row of plan.variations) {
      await tx.variation.update({
        where: { id: row.variationId },
        data: { squareVariationId: row.squareVariationId },
      })
    }
  })
}

function preview<T>(arr: T[], n: number, fmt: (x: T) => string): void {
  for (const row of arr.slice(0, n)) console.log(`    ${fmt(row)}`)
  if (arr.length > n) console.log(`    … and ${arr.length - n} more`)
}

async function main(): Promise<void> {
  const shouldApply = process.argv.includes('--apply')
  const shouldWipe = process.argv.includes('--wipe')
  const prisma = new PrismaService()
  await prisma.$connect()
  try {
    console.log(`\nCatalog auto-map (arbitrary pairing)  [${shouldApply ? 'APPLY' : 'DRY RUN'}${shouldWipe ? ', WIPE' : ''}]`)

    if (shouldWipe) {
      if (shouldApply) {
        console.log('  Wiping existing squareItemId / squareVariationId columns…')
        await wipe(prisma)
      } else {
        console.log('  --wipe requested but --apply not passed — no changes in dry run.')
      }
    }

    const plan = await buildPlan(prisma)

    console.log('\nWould map:')
    console.log(`  ${plan.itemGroups.length} ItemGroup → Square item`)
    console.log(`  ${plan.warehouseVariants.length} WarehouseVariant → Square variation`)
    console.log(`  ${plan.variations.length} Variation → Square variation (family fallback)`)

    if (plan.itemGroups.length > 0) {
      console.log('\n  Sample ItemGroup pairings:')
      preview(plan.itemGroups, 8, (r) => `${r.itemGroupName}  →  ${r.squareItemName}`)
    }
    if (plan.warehouseVariants.length > 0) {
      console.log('\n  Sample WarehouseVariant pairings:')
      preview(plan.warehouseVariants, 8, (r) => `${r.itemGroupName} · ${r.warehouseSku}  →  ${r.squareVariationName}`)
    }

    console.log('\nLeftover:')
    console.log(`  ${plan.leftover.unusedSquareItems} Square items with no local ItemGroup to pair with`)
    console.log(`  ${plan.leftover.unusedLocalItemGroups} local ItemGroups still unmapped after pairing`)
    console.log(`  ${plan.leftover.unusedSquareVariationsPerItem} Square variations skipped (local ItemGroup ran out of WVs)`)
    console.log(`  ${plan.leftover.unusedLocalWarehouseVariantsPerItem} local WarehouseVariants left unmapped inside paired ItemGroups`)

    if (!shouldApply) {
      console.log('\nDry run — pass --apply to write.')
      return
    }

    if (plan.itemGroups.length === 0 && plan.warehouseVariants.length === 0 && plan.variations.length === 0) {
      console.log('\nNothing to apply.')
      return
    }

    console.log('\nApplying…')
    await applyPlan(prisma, plan)
    console.log('Done.')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
