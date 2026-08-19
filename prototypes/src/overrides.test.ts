import { describe, it, expect } from 'vitest'
import { square, assertNoErrors, mainLocationId } from './client.js'
import { seedFlatItem } from './seed.js'
import { migrateFlatToVariations } from './migrate-a.js'
import {
  ensureSecondLocation,
  setVariationOverride,
  getVariationOverrides,
} from './locations.js'

describe('Prototype A: per-location price overrides survive migration', () => {
  it('keeps the override on the legacy variation after restructure', async () => {
    // F3: the sandbox merchant may not permit creating a location via the
    // Locations API. If ensureSecondLocation() fails, fall back to setting
    // the override on the single existing location and still assert it
    // survives the migration — that still proves the field is preserved,
    // which is the actual requirement. In that case the multi-location
    // case stays unproven in sandbox and must be confirmed on a live item
    // in Plan 3.
    let secondLocation: string
    try {
      secondLocation = await ensureSecondLocation()
    } catch (err) {
      console.warn(
        `[overrides.test] ensureSecondLocation() failed: ${(err as Error).message}. ` +
          `Falling back to the single existing sandbox location — the multi-location ` +
          `case is unproven in this run.`,
      )
      secondLocation = await mainLocationId()
    }

    // I4: distinctness must be CI-enforced, not inferred from the absence
    // of the console.warn above. If ensureSecondLocation() silently
    // returned the main location (or the fallback above kicked in), the
    // rest of this test would still "pass" while proving nothing about a
    // genuine second location. Fail loudly instead.
    expect(secondLocation).not.toBe(await mainLocationId())

    const seeded = await seedFlatItem('Proto Override Cape', 16500, 1)
    const variationId = seeded.variationIds[0]

    // Mirror the real Carmel premium: base 165.00, Carmel 177.00
    await setVariationOverride(variationId, secondLocation, 17700)

    const before = await getVariationOverrides(variationId)
    expect(before[secondLocation]).toBe(17700)

    const migrated = await migrateFlatToVariations(
      seeded.itemId,
      ['Gray', 'Multi'],
      16500,
    )

    const after = await getVariationOverrides(variationId)
    expect(after[secondLocation]).toBe(17700)

    // F9 (carried forward from Task 4's review): migrateFlatToVariations
    // builds the new colour variations from scratch — see migrate-a.ts —
    // with no `locationOverrides` and no `presentAtLocationIds` set at
    // all. That means a migration would preserve the legacy row's Carmel
    // premium while leaving every new colour row at a flat price across
    // all markets. This is out of scope to fix here, but it must not stay
    // an unexamined gap: assert exactly what the new variations come out
    // with so Plan 3's production scripts are written knowing the truth.
    expect(migrated.newVariationIds.length).toBeGreaterThan(0)
    for (const newVariationId of migrated.newVariationIds) {
      const overrides = await getVariationOverrides(newVariationId)
      expect(overrides).toEqual({})

      const newVarObj = await square.catalog.object.get({ objectId: newVariationId })
      assertNoErrors(newVarObj, 'catalog.object.get (F9 presentAtLocationIds check)')
      // I2: getVariationOverrides()'s `?? []` erases the undefined-vs-[]
      // distinction on the wire — `expect(overrides).toEqual({})` above
      // passes identically whether Square returned `undefined` or `[]`.
      // Read the raw field directly off the fetched object instead, so
      // the record's "absent, not an empty array" claim is actually
      // checked on this (the colour-variation) path.
      console.log(
        `[harness] new colour variation ${newVariationId} raw locationOverrides: ` +
          `${JSON.stringify(newVarObj.object?.itemVariationData?.locationOverrides)}`,
      )
      expect(newVarObj.object?.itemVariationData?.locationOverrides).toBeUndefined()
      // Documents current behaviour: new variations carry no explicit
      // presentAtLocationIds either. F11: assert what Square actually
      // reports for presentAtAllLocations rather than describing it only
      // in a comment/report — this is the fact the F9 production risk
      // hinges on (every new colour variation selling at flat price
      // across every market, not just "no override list").
      expect(newVarObj.object?.presentAtLocationIds).toBeUndefined()
      expect(newVarObj.object?.presentAtAllLocations).toBe(true)
    }
  })
})
