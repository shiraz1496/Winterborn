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
