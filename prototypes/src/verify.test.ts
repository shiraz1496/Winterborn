import { describe, it, expect } from 'vitest'
import { square, assertNoErrors } from './client.js'
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

  /**
   * Negative control (Task 3 review, ruling F6).
   *
   * `catalogObjectExists` had only ever been exercised against objects
   * that genuinely exist and against an ID that never existed. Nobody had
   * confirmed what Square does for an object that DID exist and was then
   * DELETED — the exact situation Task 4's migration assertion depends on
   * to detect orphaned order lines. Two things were possible: Square's
   * `catalog.object.get` could 404 (detector works), or it could resolve
   * with the object still present carrying `isDeleted: true` (detector is
   * blind — it would report "exists" whether or not a migration destroyed
   * the object).
   *
   * Verified empirically here: deleting a real catalog object via
   * `catalog.object.delete` and then calling `catalog.object.get` on its
   * ID throws a `SquareError` with `statusCode === 404` and
   * `errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND' }]` —
   * indistinguishable from an ID that never existed. This is exactly the
   * condition `isNotFoundError` in verify.ts already checks, so
   * `catalogObjectExists` correctly reports `false` with no changes
   * needed. This test is the permanent record that the detector detects.
   */
  it('reports a genuinely deleted catalog object as absent (negative control)', async () => {
    const seeded = await seedFlatItem('Proto Verify Delete Control', 6500, 0)
    const variationId = seeded.variationIds[0]

    // Confirm it's alive before deletion, so the later "false" is meaningful.
    expect(await catalogObjectExists(variationId)).toBe(true)

    const delRes = await square.catalog.object.delete({ objectId: variationId })
    assertNoErrors(delRes, 'catalog.object.delete (negative control)')
    expect(delRes.deletedObjectIds).toContain(variationId)

    expect(await catalogObjectExists(variationId)).toBe(false)
  })
})
