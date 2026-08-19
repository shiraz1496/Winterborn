import { describe, it, expect } from 'vitest'
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
  })
})
