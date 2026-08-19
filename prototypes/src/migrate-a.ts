import { randomUUID } from 'node:crypto'
import { square, RUN_ID, assertNoErrors } from './client.js'

/**
 * Prototype A: preserve-and-relabel.
 *
 * Converts a flat item (one variation, e.g. "Regular") into a
 * variation-structured item (e.g. colours) by read-modify-write on the
 * existing ITEM catalog object. `item_id` never changes. The original
 * variation is never deleted — it is relabelled to `legacyLabel` and
 * marked unsellable, then the new colour variations are added alongside
 * it.
 *
 * Why relabel instead of delete: the original variation carries every
 * historical sale (order line items reference it by
 * `catalogObjectId`). Delete it and those lines orphan — `catalogObjectExists`
 * on that ID starts returning false (see the negative control in
 * verify.test.ts, which establishes that a deleted object 404s exactly
 * like one that never existed).
 *
 * Why relabel instead of reusing it as a colour (e.g. "Blue"): a
 * silently-relabelled variation is worse than an orphaned one, because
 * every historical sale would then read as having been a sale of that
 * colour — wrong, but not visibly wrong.
 *
 * Why read-modify-write instead of constructing the item object from
 * scratch: the real client catalog has per-location price overrides
 * (`locationOverrides`) and `present_at_location_ids` on many rows.
 * Building a fresh ITEM object would silently drop those fields on
 * upsert, since Square's catalog upsert replaces whatever is provided
 * for the object. Reading the current object first and spreading it
 * forward preserves anything this prototype doesn't know to touch.
 */
export async function migrateFlatToVariations(
  itemId: string,
  colourNames: string[],
  priceCents: number,
  legacyLabel = 'Unspecified (pre-2026)',
): Promise<{ itemId: string; newVariationIds: string[]; legacyVariationId: string }> {
  const current = await square.catalog.object.get({ objectId: itemId })
  assertNoErrors(current, 'catalog.object.get (migrateFlatToVariations read)')
  const item = current.object
  if (!item?.itemData) throw new Error(`Item ${itemId} not found or has no itemData`)

  const existing = item.itemData.variations ?? []
  if (existing.length !== 1) {
    throw new Error(
      `Expected exactly 1 existing variation on a flat item, found ${existing.length}`,
    )
  }
  const legacy = existing[0]
  const legacyVariationId = legacy.id!

  // Relabel the legacy variation and take it out of sale. Do NOT delete it:
  // it holds every historical order line for this item.
  const relabelledLegacy = {
    ...legacy,
    itemVariationData: {
      ...legacy.itemVariationData,
      name: legacyLabel,
      sellable: false,
      stockable: true,
    },
  }

  const newVariations = colourNames.map((name, i) => ({
    type: 'ITEM_VARIATION' as const,
    id: `#new_${RUN_ID}_${i}`,
    itemVariationData: {
      itemId,
      name,
      pricingType: 'FIXED_PRICING' as const,
      priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
      sellable: true,
      stockable: true,
    },
  }))

  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      ...item,
      itemData: {
        ...item.itemData,
        variations: [relabelledLegacy, ...newVariations],
      },
    },
  })
  assertNoErrors(res, 'catalog.object.upsert (migrateFlatToVariations write)')

  const saved = res.catalogObject
  if (!saved?.id) throw new Error('Upsert returned no object')

  const newVariationIds = (saved.itemData?.variations ?? [])
    .filter((v) => v.id !== legacyVariationId)
    .map((v) => v.id!)

  return { itemId: saved.id, newVariationIds, legacyVariationId }
}
