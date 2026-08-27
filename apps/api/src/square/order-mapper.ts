import type { Square } from 'square'
import { saleKey, type AppendEventInput, type LedgerSource } from '@winterborn/shared'

/**
 * One line (sale or return) that could not be mapped to ledger input: no
 * uid, no catalogObjectId, an unknown catalogObjectId, or a garbage
 * quantity. Recorded, never thrown, never silently dropped -- spec §7.1.
 */
export interface DeadLetter {
  orderId: string
  lineUid: string
  catalogObjectId: string | null
  reason: string
}

export interface MapOrderResult {
  events: AppendEventInput[]
  deadLetters: DeadLetter[]
}

/**
 * Square catalog object ID resolution. Returns both the family Variation and
 * the specific WarehouseVariant when the mapping exists at variant grain
 * (WarehouseVariant.squareVariationId), or just the Variation when only the
 * family-level fallback (Variation.squareVariationId) is available. Callers
 * are expected to try variant-first, family-second, so single-SKU products
 * without per-variant Square IDs still map.
 */
export interface SquareCatalogMatch {
  variationId: string
  warehouseVariantId?: string
}
export type SquareCatalogResolver = (squareVariationId: string) => SquareCatalogMatch | undefined

/** Square location ID -> our Location.id, or undefined if unknown. */
export type LocationResolver = (squareLocationId: string) => string | undefined

function parseQuantity(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Pure mapper: a Square Order becomes ledger `AppendEventInput`s. Shared,
 * unmodified, by both the webhook inbox worker and the reconciliation
 * poll (spec §7.1/§7.2) -- that sharing is what guarantees the two paths
 * build identical idempotency keys for the same sale. See `saleKey`'s
 * docstring in `@winterborn/shared` for why a second implementation here
 * would be the single most likely way this system corrupts its ledger.
 *
 * Sale line items become negative-quantity SALE events keyed
 * `sale:{orderId}:{lineUid}`. Refund/return line items
 * (`order.returns[].returnLineItems`) become positive-quantity SALE
 * events keyed off their own uid -- naturally distinct from the sale
 * line's key because it is a different uid -- per spec §7.1: "write
 * correcting SALE events with positive quantity and a distinct
 * idempotency key."
 *
 * A line with no uid, no catalogObjectId, an unresolvable
 * catalogObjectId, or an unparsable quantity is recorded in
 * `deadLetters` and excluded from `events` -- never thrown, never
 * silently skipped.
 */
export function mapOrderToLedgerInputs(
  order: Square.Order,
  resolveCatalog: SquareCatalogResolver,
  resolveLocationId: LocationResolver,
  source: LedgerSource,
): MapOrderResult {
  const events: AppendEventInput[] = []
  const deadLetters: DeadLetter[] = []

  const orderId = order.id
  if (!orderId) return { events, deadLetters }

  // Only completed orders count as sales. Square POS transitions an order
  // through OPEN before payment; a cashier voiding the cart pre-payment
  // leaves the order in CANCELED / DRAFT with no refunds[] to reverse it
  // — so mapping an OPEN order to SALE events would write a phantom that
  // never gets corrected. Refunds ride in on later `order.updated` events
  // where state is still COMPLETED and `returns[]` is populated, so this
  // guard doesn't block the return path. Applies to both webhook and poll
  // sources because both funnel through this same mapper.
  if (order.state !== 'COMPLETED') return { events, deadLetters }

  // AppendEventInput's occurredAt is typed Date at the z.input level even
  // though the schema uses z.coerce.date() (zod does not widen a coerced
  // schema's static input type), so construct a Date here rather than
  // passing the raw ISO string through.
  const occurredAt = new Date(order.updatedAt ?? order.createdAt ?? Date.now())
  const locationId = resolveLocationId(order.locationId)

  const deadLetterLine = (lineUid: string | null | undefined, catalogObjectId: string | null | undefined, reason: string): void => {
    deadLetters.push({ orderId, lineUid: lineUid ?? '', catalogObjectId: catalogObjectId ?? null, reason })
  }

  if (!locationId) {
    for (const line of order.lineItems ?? []) deadLetterLine(line.uid, line.catalogObjectId, `unknown Square location ${order.locationId}`)
    for (const ret of order.returns ?? []) {
      for (const line of ret.returnLineItems ?? []) deadLetterLine(line.uid, line.catalogObjectId, `unknown Square location ${order.locationId}`)
    }
    return { events, deadLetters }
  }

  for (const line of order.lineItems ?? []) {
    const lineUid = line.uid
    const catalogObjectId = line.catalogObjectId
    if (!lineUid || !catalogObjectId) {
      deadLetterLine(lineUid, catalogObjectId, 'missing uid or catalogObjectId')
      continue
    }
    const match = resolveCatalog(catalogObjectId)
    if (!match) {
      deadLetterLine(lineUid, catalogObjectId, 'unmapped catalogObjectId')
      continue
    }
    const quantity = parseQuantity(line.quantity)
    if (quantity === undefined) {
      deadLetterLine(lineUid, catalogObjectId, `invalid quantity "${line.quantity}"`)
      continue
    }
    events.push({
      type: 'SALE',
      locationId,
      variationId: match.variationId,
      warehouseVariantId: match.warehouseVariantId,
      quantity: -quantity,
      occurredAt,
      source,
      sourceRef: orderId,
      idempotencyKey: saleKey(orderId, lineUid),
    })
  }

  for (const ret of order.returns ?? []) {
    for (const line of ret.returnLineItems ?? []) {
      const lineUid = line.uid
      const catalogObjectId = line.catalogObjectId
      if (!lineUid || !catalogObjectId) {
        deadLetterLine(lineUid, catalogObjectId, 'missing uid or catalogObjectId on return line')
        continue
      }
      const match = resolveCatalog(catalogObjectId)
      if (!match) {
        deadLetterLine(lineUid, catalogObjectId, 'unmapped catalogObjectId on return line')
        continue
      }
      const quantity = parseQuantity(line.quantity)
      if (quantity === undefined) {
        deadLetterLine(lineUid, catalogObjectId, `invalid return quantity "${line.quantity}"`)
        continue
      }
      events.push({
        type: 'SALE',
        locationId,
        variationId: match.variationId,
        warehouseVariantId: match.warehouseVariantId,
        quantity,
        occurredAt,
        source,
        sourceRef: orderId,
        idempotencyKey: saleKey(orderId, lineUid),
      })
    }
  }

  return { events, deadLetters }
}
