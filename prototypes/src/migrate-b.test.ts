import { describe, it, expect } from 'vitest'
import { square, assertNoErrors } from './client.js'
import { seedSizeItem } from './seed.js'
import { createItemPerPattern, expandInPlace } from './migrate-b.js'
import { readOrderLines, catalogObjectExists, itemVariationNames } from './verify.js'

const PATTERNS = ['Nordic Stripe', 'Snowflake', 'Floral', 'Geometric']
const SIZES = ['Small', 'Medium', 'Large', 'XL']

describe('Prototype B: two-dimension items', () => {
  it('item-per-pattern keeps each till list to the size count', async () => {
    const result = await createItemPerPattern('Proto Sport Sock', PATTERNS, SIZES, 3500)

    expect(result.createdItemIds).toHaveLength(PATTERNS.length)
    expect(result.entriesPerItem).toBe(SIZES.length)
    // Spec §8.6 binding rule: selectable entries per item must be <= 16
    expect(result.entriesPerItem).toBeLessThanOrEqual(16)

    for (const id of result.createdItemIds) {
      expect(await itemVariationNames(id)).toEqual(SIZES)
    }

    // Worth checking for Plan 3: each pattern becomes a brand-new Square
    // item, which (unlike migrate-a's colour variations, see Task 5's F9)
    // has never carried a location override to begin with — but it still
    // starts with no sales history and no explicit location data. Task 5
    // found that new variations produced by a from-scratch upsert come
    // out with an empty `locationOverrides`, no `presentAtLocationIds`,
    // and `presentAtAllLocations: true`. This block checks whether the
    // same is true here, since `createItemPerPattern` builds each item's
    // itemData from scratch the same way. Logged with the `[harness]`
    // prefix so the exact observed values land in the test run output for
    // the report, and CI-asserted (not just observed) so the fact is
    // proven, not merely claimed.
    for (const id of result.createdItemIds) {
      const obj = await square.catalog.object.get({ objectId: id })
      assertNoErrors(obj, 'catalog.object.get (pattern item location check)')
      console.log(
        `[harness] pattern item ${id}: presentAtAllLocations=${obj.object?.presentAtAllLocations} ` +
          `presentAtLocationIds=${JSON.stringify(obj.object?.presentAtLocationIds)}`,
      )
      expect(obj.object?.presentAtAllLocations).toBe(true)
      expect(obj.object?.presentAtLocationIds).toBeUndefined()

      for (const v of obj.object?.itemData?.variations ?? []) {
        console.log(
          `[harness]   variation ${v.id} (${v.itemVariationData?.name}): ` +
            `locationOverrides=${JSON.stringify(v.itemVariationData?.locationOverrides)} ` +
            `presentAtLocationIds=${JSON.stringify(v.presentAtLocationIds)} ` +
            `presentAtAllLocations=${v.presentAtAllLocations}`,
        )
        expect(v.itemVariationData?.locationOverrides ?? []).toEqual([])
        expect(v.presentAtLocationIds).toBeUndefined()
        expect(v.presentAtAllLocations).toBe(true)
      }
    }
  })

  it('expanding in place preserves history but breaches the entry ceiling', async () => {
    const seeded = await seedSizeItem('Proto Sock Inplace', SIZES, 3500, 1)
    const before = await readOrderLines(seeded.orderIds)
    expect(before).toHaveLength(SIZES.length)

    // Bind the pre-migration lines to the specific seeded variation IDs
    // too, so "before" and "after" are measured against the same yardstick
    // rather than "after" being the only rigorous check.
    for (let i = 0; i < before.length; i++) {
      expect(before[i].catalogObjectId).toBe(seeded.variationIds[i])
    }

    const result = await expandInPlace(seeded.itemId, PATTERNS, SIZES, 3500)

    // History survives, because existing variations are never removed.
    const after = await readOrderLines(seeded.orderIds)
    // Length gate: SIZES.length is 4, non-zero, so this also rules out an
    // empty array vacuously satisfying every assertion in the loop below.
    expect(after).toHaveLength(SIZES.length)
    expect(after.length).toBeGreaterThan(0)
    for (let i = 0; i < after.length; i++) {
      const line = after[i]
      // Strong assertion (per Task 4's F7 lesson): bind the line to the
      // SPECIFIC seeded variation ID, not merely "some catalog object that
      // happens to exist". An implementation that dropped and recreated
      // variations under new IDs — orphaning history while every object
      // still technically "exists" — would pass a weaker
      // catalogObjectExists-only check but fail this one.
      expect(line.catalogObjectId).toBe(seeded.variationIds[i])
      expect(await catalogObjectExists(line.catalogObjectId!)).toBe(true)
    }

    // But the till list is now pattern x size plus the originals.
    expect(result.entryCount).toBe(PATTERNS.length * SIZES.length + SIZES.length)
    expect(result.entryCount).toBeGreaterThan(16)
  })
})
