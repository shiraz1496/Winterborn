import { SquareError } from 'square'
import { square, assertNoErrors } from './client.js'

export type LineRef = {
  orderId: string
  catalogObjectId: string | undefined
  name: string | undefined
  quantity: string
}

export async function readOrderLines(orderIds: string[]): Promise<LineRef[]> {
  const out: LineRef[] = []
  for (const orderId of orderIds) {
    const res = await square.orders.get({ orderId })
    assertNoErrors(res, 'orders.get (readOrderLines)')
    for (const li of res.order?.lineItems ?? []) {
      out.push({
        orderId,
        catalogObjectId: li.catalogObjectId ?? undefined,
        name: li.name ?? undefined,
        quantity: li.quantity,
      })
    }
  }
  return out
}

/**
 * Verified empirically (sandbox, square@43.2.1): `catalog.object.get` on a
 * missing object ID does not resolve with an empty payload — it *throws* a
 * `SquareError` with `statusCode === 404` and
 * `errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND', detail: ... }]`.
 *
 * That is the ONLY condition this module treats as "does not exist". Any
 * other failure (auth, network, rate limit, an error shape we don't
 * recognise) is re-thrown rather than swallowed, because `catalogObjectExists`
 * is exactly the signal Task 4 uses to decide whether a migration orphaned
 * sales history — a caught-and-hidden failure would read as "the object is
 * gone" when it might mean nothing of the sort.
 */
function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof SquareError)) return false
  if (err.statusCode === 404) return true
  return (err.errors ?? []).some(
    (e) => e.code === 'NOT_FOUND' && e.category === 'INVALID_REQUEST_ERROR',
  )
}

export async function catalogObjectExists(id: string): Promise<boolean> {
  try {
    const res = await square.catalog.object.get({ objectId: id })
    assertNoErrors(res, 'catalog.object.get (catalogObjectExists)')
    return Boolean(res.object?.id)
  } catch (err) {
    if (isNotFoundError(err)) return false
    throw new Error(`catalogObjectExists(${id}): Square call failed unexpectedly`, {
      cause: err,
    })
  }
}

export async function resolveVariationToItem(
  variationId: string,
): Promise<string | undefined> {
  try {
    const res = await square.catalog.object.get({ objectId: variationId })
    assertNoErrors(res, 'catalog.object.get (resolveVariationToItem)')
    return res.object?.itemVariationData?.itemId
  } catch (err) {
    if (isNotFoundError(err)) return undefined
    throw new Error(
      `resolveVariationToItem(${variationId}): Square call failed unexpectedly`,
      { cause: err },
    )
  }
}

export async function itemVariationNames(itemId: string): Promise<string[]> {
  const res = await square.catalog.object.get({ objectId: itemId })
  assertNoErrors(res, 'catalog.object.get (itemVariationNames)')
  return (res.object?.itemData?.variations ?? [])
    .map((v) => v.itemVariationData?.name ?? '')
    .filter(Boolean)
}
