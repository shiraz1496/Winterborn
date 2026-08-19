import { describe, it, expect } from 'vitest'
import { seedFlatItem } from './seed.js'
import {
  readOrderLines,
  catalogObjectExists,
  resolveVariationToItem,
  itemVariationNames,
} from './verify.js'

describe('verification helpers', () => {
  it('resolves seeded orders back to their catalog objects', async () => {
    const s = await seedFlatItem('Proto Verify Scarf', 6500, 2)

    const lines = await readOrderLines(s.orderIds)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.catalogObjectId).toBe(s.variationIds[0])
    }

    expect(await catalogObjectExists(s.variationIds[0])).toBe(true)
    expect(await resolveVariationToItem(s.variationIds[0])).toBe(s.itemId)
    expect(await itemVariationNames(s.itemId)).toEqual(['Regular'])
  })

  it('reports a non-existent catalog object as absent', async () => {
    expect(await catalogObjectExists('DOES_NOT_EXIST_XXXXXXXX')).toBe(false)
  })
})
