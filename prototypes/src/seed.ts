import { randomUUID } from 'node:crypto'
import { square, RUN_ID, mainLocationId, assertNoErrors } from './client.js'

export type SeededItem = {
  itemId: string
  variationIds: string[]
  orderIds: string[]
}

/** Creates an item whose variations are exactly `variationNames`, returns real IDs. */
async function createItem(
  name: string,
  variationNames: string[],
  priceCents: number,
): Promise<{ itemId: string; variationIds: string[] }> {
  const tempItemId = `#item_${RUN_ID}`
  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      type: 'ITEM',
      id: tempItemId,
      itemData: {
        name: `${name} ${RUN_ID}`,
        variations: variationNames.map((vn, i) => ({
          type: 'ITEM_VARIATION',
          id: `#var_${RUN_ID}_${i}`,
          itemVariationData: {
            itemId: tempItemId,
            name: vn,
            pricingType: 'FIXED_PRICING',
            priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
          },
        })),
      },
    },
  })
  assertNoErrors(res, 'catalog.object.upsert (createItem)')

  const item = res.catalogObject
  if (!item?.id) throw new Error('Item creation returned no id')
  const variationIds = (item.itemData?.variations ?? [])
    .map((v) => v.id!)
    .filter(Boolean)
  if (variationIds.length !== variationNames.length) {
    throw new Error(
      `Expected ${variationNames.length} variations, got ${variationIds.length}`,
    )
  }
  return { itemId: item.id, variationIds }
}

/**
 * Places one order against a specific variation and drives it to a paid,
 * terminal (`COMPLETED`) state.
 *
 * The brief assumed `orders.create` would accept `state: 'COMPLETED'`
 * directly. It does not: the sandbox rejects that with a 400
 * `CONFLICTING_PARAMETERS` ("Due Amount and Settled Amount were not
 * zero-sum") because a freshly created order has no tender to back a
 * completed state. `orders.create` always yields an `OPEN` order
 * regardless of what `state` is requested (verified empirically against
 * sandbox — see task-2-report.md).
 *
 * The working path: create the order `OPEN`, then create a real sandbox
 * payment against it via `payments.create` using the sandbox test nonce
 * `cnon:card-nonce-ok`, with `orderId` set and `autocomplete` left at its
 * default (`true`). That single call both completes the payment AND
 * transitions the linked order to `COMPLETED` — confirmed by re-fetching
 * the order afterward. `orders.pay` is NOT a subsequent required step:
 * calling it after `payments.create` already closed the order fails with
 * 400 "The order is already paid." — so it is never called here.
 */
async function placeOrder(variationId: string, quantity: number): Promise<string> {
  const locationId = await mainLocationId()

  const createRes = await square.orders.create({
    idempotencyKey: randomUUID(),
    order: {
      locationId,
      lineItems: [{ catalogObjectId: variationId, quantity: String(quantity) }],
    },
  })
  assertNoErrors(createRes, 'orders.create')
  const order = createRes.order
  const orderId = order?.id
  if (!orderId) throw new Error('Order creation returned no id')

  const totalMoney = order.totalMoney
  if (!totalMoney?.amount) {
    throw new Error(`Order ${orderId} has no totalMoney to pay`)
  }

  const paymentRes = await square.payments.create({
    idempotencyKey: randomUUID(),
    sourceId: 'cnon:card-nonce-ok',
    orderId,
    locationId,
    amountMoney: totalMoney,
  })
  assertNoErrors(paymentRes, 'payments.create')
  if (paymentRes.payment?.status !== 'COMPLETED') {
    throw new Error(
      `Payment for order ${orderId} did not complete, status: ${paymentRes.payment?.status}`,
    )
  }

  const verifyRes = await square.orders.get({ orderId })
  assertNoErrors(verifyRes, 'orders.get (post-payment verification)')
  if (verifyRes.order?.state !== 'COMPLETED') {
    throw new Error(
      `Order ${orderId} did not reach COMPLETED after payment, state: ${verifyRes.order?.state}`,
    )
  }

  return orderId
}

export async function seedFlatItem(
  name: string,
  priceCents: number,
  orderCount: number,
): Promise<SeededItem> {
  const { itemId, variationIds } = await createItem(name, ['Regular'], priceCents)
  const orderIds: string[] = []
  for (let i = 0; i < orderCount; i++) {
    orderIds.push(await placeOrder(variationIds[0], i + 1))
  }
  return { itemId, variationIds, orderIds }
}

export async function seedSizeItem(
  name: string,
  sizes: string[],
  priceCents: number,
  ordersPerSize: number,
): Promise<SeededItem> {
  const { itemId, variationIds } = await createItem(name, sizes, priceCents)
  const orderIds: string[] = []
  for (const variationId of variationIds) {
    for (let i = 0; i < ordersPerSize; i++) {
      orderIds.push(await placeOrder(variationId, 1))
    }
  }
  return { itemId, variationIds, orderIds }
}
