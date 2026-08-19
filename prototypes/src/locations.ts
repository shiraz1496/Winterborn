import { randomUUID } from 'node:crypto'
import { square, RUN_ID, assertNoErrors } from './client.js'

/**
 * Returns a second sandbox location ID, creating one if the merchant only
 * has one. Overrides on a single-location merchant would be a vacuous
 * test (there'd be nothing to differ from the default price), so this
 * exists to make the override test genuinely exercise per-location
 * pricing.
 *
 * If the sandbox rejects location creation (permissions vary by sandbox
 * merchant), this throws and the caller is expected to fall back to
 * proving the override survives on the existing single location instead.
 */
export async function ensureSecondLocation(): Promise<string> {
  const existing = await square.locations.list()
  assertNoErrors(existing, 'locations.list (ensureSecondLocation)')
  const locations = existing.locations ?? []
  if (locations.length >= 2) {
    const id = locations[1].id
    if (!id) throw new Error('Second location in sandbox has no id')
    // I4: the sandbox accumulates locations across runs with no teardown,
    // so this branch — reusing an already-existing second location — is
    // the expected, common case. `locations.create` below is the
    // exception, not the rule. Logged so a test run's output states which
    // branch actually executed, rather than leaving it inferred.
    console.log(`[harness] ensureSecondLocation: reused existing second location ${id}`)
    return id
  }

  const created = await square.locations.create({
    location: {
      name: `Proto Second Location ${RUN_ID}`,
      address: {
        addressLine1: '1 Test Street',
        locality: 'Denver',
        administrativeDistrictLevel1: 'CO',
        postalCode: '80202',
        country: 'US',
      },
    },
  })
  assertNoErrors(created, 'locations.create (ensureSecondLocation)')
  const id = created.location?.id
  if (!id) throw new Error('Failed to create a second sandbox location')
  console.log(`[harness] ensureSecondLocation: created a new second location ${id}`)
  return id
}

/**
 * Sets (or replaces) a per-location price override on an item variation.
 * `locationOverrides` lives inside `itemVariationData`, not at the item
 * (or catalog object) level — see `CatalogItemVariation.locationOverrides`
 * in the SDK types.
 */
export async function setVariationOverride(
  variationId: string,
  locationId: string,
  priceCents: number,
): Promise<void> {
  const current = await square.catalog.object.get({ objectId: variationId })
  assertNoErrors(current, 'catalog.object.get (setVariationOverride read)')
  const variation = current.object
  if (!variation?.itemVariationData) {
    throw new Error(`Variation ${variationId} not found`)
  }

  const existing = variation.itemVariationData.locationOverrides ?? []
  const others = existing.filter((o) => o.locationId !== locationId)

  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      ...variation,
      itemVariationData: {
        ...variation.itemVariationData,
        locationOverrides: [
          ...others,
          {
            locationId,
            priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
            pricingType: 'FIXED_PRICING',
          },
        ],
      },
    },
  })
  assertNoErrors(res, 'catalog.object.upsert (setVariationOverride write)')
}

/**
 * Reads back the per-location price overrides on a variation as a plain
 * `locationId -> priceCents` map, for easy assertion in tests.
 */
export async function getVariationOverrides(
  variationId: string,
): Promise<Record<string, number>> {
  const res = await square.catalog.object.get({ objectId: variationId })
  assertNoErrors(res, 'catalog.object.get (getVariationOverrides)')
  const overrides = res.object?.itemVariationData?.locationOverrides ?? []
  const out: Record<string, number> = {}
  for (const o of overrides) {
    if (o.locationId && o.priceMoney?.amount !== undefined) {
      out[o.locationId] = Number(o.priceMoney.amount)
    }
  }
  return out
}
