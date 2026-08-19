import { randomUUID } from 'node:crypto'
import { square, RUN_ID, assertNoErrors } from './client.js'

export type PatternItemResult = {
  createdItemIds: string[]
  entriesPerItem: number
}

/**
 * Approach 1 (spec §8.6 recommendation): one Square item per warehouse
 * pattern, each keeping its existing size variations. Twelve visually
 * distinct tiles in the POS grid, four entries each — the till cost of
 * each tile is exactly `sizes.length`, independent of how many patterns
 * exist.
 */
export async function createItemPerPattern(
  baseName: string,
  patterns: string[],
  sizes: string[],
  priceCents: number,
): Promise<PatternItemResult> {
  const createdItemIds: string[] = []

  for (let p = 0; p < patterns.length; p++) {
    const tempItemId = `#pat_${RUN_ID}_${p}`
    const res = await square.catalog.object.upsert({
      idempotencyKey: randomUUID(),
      object: {
        type: 'ITEM',
        id: tempItemId,
        itemData: {
          name: `${baseName} - ${patterns[p]} ${RUN_ID}`,
          variations: sizes.map((size, i) => ({
            type: 'ITEM_VARIATION' as const,
            id: `#pat_${RUN_ID}_${p}_${i}`,
            itemVariationData: {
              itemId: tempItemId,
              name: size,
              pricingType: 'FIXED_PRICING' as const,
              priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
            },
          })),
        },
      },
    })
    assertNoErrors(res, 'catalog.object.upsert (createItemPerPattern)')

    const id = res.catalogObject?.id
    if (!id) throw new Error(`Failed to create pattern item ${patterns[p]}`)
    createdItemIds.push(id)
  }

  return { createdItemIds, entriesPerItem: sizes.length }
}

/**
 * Approach 2 (the alternative): pattern x size concatenated onto the
 * single existing item, on top of whatever variations it already has.
 * One tile, `patterns.length * sizes.length + existing.length` entries in
 * a list — measures the till cost of not splitting into separate items.
 *
 * Read-modify-write on the existing ITEM object, matching migrate-a.ts's
 * approach: existing variations (and any fields this prototype doesn't
 * know to touch, e.g. per-location overrides) are preserved by spreading
 * the fetched object forward rather than constructing a fresh one.
 */
export async function expandInPlace(
  itemId: string,
  patterns: string[],
  sizes: string[],
  priceCents: number,
): Promise<{ itemId: string; entryCount: number }> {
  const current = await square.catalog.object.get({ objectId: itemId })
  assertNoErrors(current, 'catalog.object.get (expandInPlace read)')
  const item = current.object
  if (!item?.itemData) throw new Error(`Item ${itemId} not found`)

  const existing = item.itemData.variations ?? []

  const added = patterns.flatMap((pattern, p) =>
    sizes.map((size, s) => ({
      type: 'ITEM_VARIATION' as const,
      id: `#exp_${RUN_ID}_${p}_${s}`,
      itemVariationData: {
        itemId,
        name: `${pattern} / ${size}`,
        pricingType: 'FIXED_PRICING' as const,
        priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
      },
    })),
  )

  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      ...item,
      itemData: { ...item.itemData, variations: [...existing, ...added] },
    },
  })
  assertNoErrors(res, 'catalog.object.upsert (expandInPlace write)')

  const saved = res.catalogObject
  if (!saved?.id) throw new Error('Upsert returned no object')
  return {
    itemId: saved.id,
    entryCount: (saved.itemData?.variations ?? []).length,
  }
}
