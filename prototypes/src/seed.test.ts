import { describe, it, expect } from 'vitest'
import { seedFlatItem } from './seed.js'

describe('seedFlatItem', () => {
  it('creates a flat item with one variation and orders against it', async () => {
    const seeded = await seedFlatItem('Proto Flat Scarf', 6500, 3)

    expect(seeded.itemId).toBeTruthy()
    expect(seeded.variationIds).toHaveLength(1)
    expect(seeded.orderIds).toHaveLength(3)
  })
})
