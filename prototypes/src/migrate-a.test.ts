import { describe, it, expect } from 'vitest'
import { square, assertNoErrors } from './client.js'
import { seedFlatItem } from './seed.js'
import { migrateFlatToVariations } from './migrate-a.js'
import {
  readOrderLines,
  catalogObjectExists,
  resolveVariationToItem,
  itemVariationNames,
} from './verify.js'

describe('Prototype A: flat item to colour variations', () => {
  it('preserves item_id, keeps history resolvable, and adds colour variations', async () => {
    const seeded = await seedFlatItem('Proto A Scarf', 6500, 3)
    const originalVariationId = seeded.variationIds[0]

    const before = await readOrderLines(seeded.orderIds)
    expect(before).toHaveLength(3)

    const result = await migrateFlatToVariations(
      seeded.itemId,
      ['Blue', 'Green', 'Multi'],
      6500,
    )

    // 1. item_id is unchanged
    expect(result.itemId).toBe(seeded.itemId)

    // 2. the original variation still exists and still belongs to the same item
    expect(result.legacyVariationId).toBe(originalVariationId)
    expect(await catalogObjectExists(originalVariationId)).toBe(true)
    expect(await resolveVariationToItem(originalVariationId)).toBe(seeded.itemId)

    // 3. historical order lines still point at a live catalog object
    const after = await readOrderLines(seeded.orderIds)
    expect(after).toHaveLength(3)
    for (const line of after) {
      expect(line.catalogObjectId).toBe(originalVariationId)
      expect(await catalogObjectExists(line.catalogObjectId!)).toBe(true)
    }

    // 4. the item now carries the colour variations plus the relabelled legacy one
    const names = await itemVariationNames(result.itemId)
    expect(names).toContain('Blue')
    expect(names).toContain('Green')
    expect(names).toContain('Multi')
    expect(names).toContain('Unspecified (pre-2026)')
    expect(names).not.toContain('Regular')
    expect(result.newVariationIds).toHaveLength(3)

    // 5. the honest label and unsellable flag sit on the SAME object that
    // carries the history, not merely somewhere on the item. Without this,
    // an implementation that renames the legacy variation to "Blue" and
    // adds "Unspecified (pre-2026)" as a fourth NEW variation passes every
    // assertion above (names contains everything expected, doesn't contain
    // "Regular", newVariationIds has length 3) while silently mislabelling
    // every historical sale as blue — exactly the failure this approach
    // exists to avoid. Fetching the legacy variation directly and checking
    // its own name/sellable fields is the only way to bind the property to
    // the right object.
    const legacyObj = await square.catalog.object.get({ objectId: originalVariationId })
    assertNoErrors(legacyObj, 'catalog.object.get legacy variation')
    expect(legacyObj.object?.itemVariationData?.name).toBe('Unspecified (pre-2026)')
    expect(legacyObj.object?.itemVariationData?.sellable).toBe(false)
  })
})
