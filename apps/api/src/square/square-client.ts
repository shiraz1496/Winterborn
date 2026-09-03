import type { Square } from 'square'
import { square, assertNoErrors } from '../catalog/square-client.js'

/**
 * Orders-API surface for the sync path. Reuses the single sandboxed
 * `square` client and `assertNoErrors` helper from `../catalog/square-client.ts`
 * rather than standing up a second SDK instance -- every Square call in
 * this codebase goes through one client, one sandbox guard, one
 * errors-array check (spec §7, global constraint: "Every Square call
 * checks res.errors").
 */
export { square, assertNoErrors }

/**
 * Fetches the full order. Webhook payloads may be partial (spec §7.1), so
 * the inbox worker never maps a webhook payload directly -- it re-fetches
 * canonical order state by ID first.
 */
export async function fetchOrder(orderId: string): Promise<Square.Order> {
  const res = await square.orders.get({ orderId })
  assertNoErrors(res, `orders.get (fetchOrder ${orderId})`)
  if (!res.order) throw new Error(`orders.get returned no order for ${orderId}`)
  return res.order
}

/** Thin, error-checked wrapper around Orders.search -- see poll.service.ts. */
export async function searchOrders(request: Square.SearchOrdersRequest): Promise<Square.SearchOrdersResponse> {
  const res = await square.orders.search(request)
  assertNoErrors(res, 'orders.search')
  return res
}

/**
 * Every Square location visible to the merchant. Consumed by the
 * /admin/locations sync flow to mirror Square's location list into our
 * `Location` table. Square typically returns a small handful, so no
 * pagination handling here -- if that ever changes, wrap this in a
 * cursor-loop like `searchOrders`'s callers do for orders.
 */
export async function listSquareLocations(): Promise<Square.Location[]> {
  const res = await square.locations.list()
  assertNoErrors(res, 'locations.list')
  return res.locations ?? []
}

/**
 * Fetch a single Square location by id. Used by the /admin/locations
 * edit modal to pre-fill the address form — we don't store addresses
 * locally (Square is source of truth) so an edit that wants to preserve
 * the current address needs the current address to preserve.
 */
export async function getSquareLocation(squareLocationId: string): Promise<Square.Location> {
  const res = await square.locations.get({ locationId: squareLocationId })
  assertNoErrors(res, `locations.get (${squareLocationId})`)
  if (!res.location) {
    throw new Error(`Square locations.get returned no location for id ${squareLocationId}`)
  }
  return res.location
}

export interface BusinessHoursPeriodInput {
  dayOfWeek: 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT'
  startLocalTime: string
  endLocalTime: string
}

export interface CreateSquareLocationInput {
  name: string
  timezone: string
  address: {
    line1: string
    line2?: string
    city: string
    state: string
    postalCode: string
    country: string
  }
  businessHours?: { periods: BusinessHoursPeriodInput[] }
}

/**
 * Toggle a Square location's status (active / inactive). Square's own
 * concept: ACTIVE = visible in POS, INACTIVE = hidden but historical
 * sales preserved. There is no "delete a location" — Square never
 * removes locations, so INACTIVE is the closest to "off."
 *
 * Used by the /admin/locations edit flow when an operator flips the
 * Active toggle on a Square-linked market so the Square Dashboard and
 * the Winterborn view stay in agreement.
 */
export async function updateSquareLocationStatus(
  squareLocationId: string,
  isActive: boolean,
): Promise<void> {
  const res = await square.locations.update({
    locationId: squareLocationId,
    location: { status: isActive ? 'ACTIVE' : 'INACTIVE' },
  })
  assertNoErrors(res, `locations.update (status=${isActive ? 'ACTIVE' : 'INACTIVE'} on ${squareLocationId})`)
}

/**
 * Mirror an arbitrary edit (name, timezone, address, active status) to a
 * Square location. Every field is optional — omit what you don't want to
 * touch. Square's update endpoint is partial: only the fields present in
 * the request body change on the Square side.
 *
 * Used by the /admin/locations edit flow so a rename here also renames
 * the Square Dashboard entry, an address correction here corrects the
 * Square merchant-of-record, etc. Prevents the two views from drifting.
 */
export interface UpdateSquareLocationInput {
  name?: string
  timezone?: string
  isActive?: boolean
  address?: {
    line1: string
    line2?: string
    city: string
    state: string
    postalCode: string
    country: string
  }
  /// `null` clears business hours on Square, an object replaces them
  /// wholesale, `undefined` leaves them untouched.
  businessHours?: { periods: BusinessHoursPeriodInput[] } | null
}
export async function updateSquareLocation(
  squareLocationId: string,
  patch: UpdateSquareLocationInput,
): Promise<void> {
  const location: Square.Location = {}
  if (patch.name !== undefined) location.name = patch.name
  if (patch.timezone !== undefined) location.timezone = patch.timezone
  if (patch.isActive !== undefined) location.status = patch.isActive ? 'ACTIVE' : 'INACTIVE'
  if (patch.address) {
    location.address = {
      addressLine1: patch.address.line1,
      ...(patch.address.line2 ? { addressLine2: patch.address.line2 } : {}),
      locality: patch.address.city,
      administrativeDistrictLevel1: patch.address.state,
      postalCode: patch.address.postalCode,
      country: patch.address.country as Square.Country,
    }
  }
  if (patch.businessHours !== undefined) {
    // `null` clears business hours by sending an empty periods list —
    // Square treats an empty array as "always closed" which is our
    // clear semantic. A populated object replaces wholesale.
    location.businessHours =
      patch.businessHours === null
        ? { periods: [] }
        : {
            periods: patch.businessHours.periods.map((p) => ({
              dayOfWeek: p.dayOfWeek as Square.DayOfWeek,
              startLocalTime: p.startLocalTime,
              endLocalTime: p.endLocalTime,
            })),
          }
  }
  const res = await square.locations.update({ locationId: squareLocationId, location })
  assertNoErrors(res, `locations.update (${squareLocationId})`)
}

/**
 * Push a brand-new location into Square. Used by the /admin/locations
 * create flow so an operator can spin up a new market and have it exist
 * as a Square Location in one step, rather than having to create it in
 * the Square Dashboard first and then pull-sync it here.
 *
 * Returns the Square-assigned id + name + timezone as Square accepted
 * them (Square may normalise casing/whitespace, so the caller should
 * persist what Square returned, not what was sent).
 *
 * Square requires country + type at minimum for a valid create call.
 * The `type: 'PHYSICAL'` value is hardcoded — a MOBILE / online-only
 * location wouldn't have a physical address to fulfil against, which
 * doesn't match how Winterborn uses Locations.
 */
export async function createSquareLocation(
  input: CreateSquareLocationInput,
): Promise<{ id: string; name: string; timezone: string }> {
  const res = await square.locations.create({
    location: {
      name: input.name,
      timezone: input.timezone,
      type: 'PHYSICAL',
      address: {
        addressLine1: input.address.line1,
        ...(input.address.line2 ? { addressLine2: input.address.line2 } : {}),
        locality: input.address.city,
        administrativeDistrictLevel1: input.address.state,
        postalCode: input.address.postalCode,
        country: input.address.country as Square.Country,
      },
      ...(input.businessHours
        ? {
            businessHours: {
              periods: input.businessHours.periods.map((p) => ({
                dayOfWeek: p.dayOfWeek as Square.DayOfWeek,
                startLocalTime: p.startLocalTime,
                endLocalTime: p.endLocalTime,
              })),
            },
          }
        : {}),
    },
  })
  assertNoErrors(res, `locations.create (${input.name})`)
  const created = res.location
  if (!created?.id) {
    throw new Error(`Square locations.create returned no id for "${input.name}"`)
  }
  return {
    id: created.id,
    name: created.name ?? input.name,
    timezone: created.timezone ?? input.timezone,
  }
}
