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
 * each tile is `sizes.length`, independent of how many patterns exist.
 *
 * `entriesPerItem` is measured, not assumed: each upsert response is read
 * back for `itemData.variations.length` — what Square actually persisted
 * and returned — the same way `expandInPlace` derives `entryCount`. It
 * would be wrong to just return `sizes.length` from the input, because
 * that number is true regardless of what Square did with the request; a
 * silently dropped variation would still report the full count. If Square
 * ever persisted a different count per item, the items would not be
 * interchangeable for the "four entries each" claim this function makes,
 * so all per-item counts are asserted equal before a single number is
 * returned — the honest thing to do when the tiles are meant to be
 * identical, rather than silently taking the first or last one.
 */
export async function createItemPerPattern(
  baseName: string,
  patterns: string[],
  sizes: string[],
  priceCents: number,
): Promise<PatternItemResult> {
  const createdItemIds: string[] = []
  const perItemCounts: number[] = []

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

    const saved = res.catalogObject
    const id = saved?.id
    if (!id) throw new Error(`Failed to create pattern item ${patterns[p]}`)
    createdItemIds.push(id)

    // Measure what Square actually persisted, not what was requested. A
    // missing variations array is a real failure (Square silently dropped
    // everything) and must throw, not be read as "0 entries" — a reader
    // downstream would otherwise mistake a broken response for evidence
    // that the item was created empty on purpose.
    const variations = saved.itemData?.variations
    if (!variations) {
      throw new Error(
        `Pattern item ${id} (${patterns[p]}) came back with no variations array at all`,
      )
    }
    perItemCounts.push(variations.length)
  }

  const [first, ...rest] = perItemCounts
  if (rest.some((count) => count !== first)) {
    throw new Error(
      `Pattern items came back with differing variation counts: ${JSON.stringify(perItemCounts)} ` +
        `— tiles were expected to be identical (${sizes.length} entries each)`,
    )
  }

  return { createdItemIds, entriesPerItem: first }
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
