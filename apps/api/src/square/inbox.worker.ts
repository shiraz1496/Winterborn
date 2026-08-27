import { Injectable, Inject, Logger } from '@nestjs/common'
import type { Square } from 'square'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { mapOrderToLedgerInputs, type DeadLetter } from './order-mapper.js'

export type OrderFetcher = (orderId: string) => Promise<Square.Order>

export const ORDER_FETCHER = Symbol('ORDER_FETCHER')

/** Square webhook payload shapes we care about, just enough to find the order id. */
interface WebhookPayload {
  data?: {
    id?: string
    type?: string
    object?: {
      order?: { id?: string }
      payment?: { order_id?: string }
    }
  }
}

function extractOrderId(payload: unknown): string | undefined {
  const p = payload as WebhookPayload | undefined
  // Order events (order.created, order.updated, order.fulfillment.updated)
  // put the order id at `data.id` and use snake_case `data.type` values
  // like `order_created`, `order_updated`, `order_fulfillment_updated`.
  // Payment events keep the order id under `data.object.payment.order_id`.
  return (
    p?.data?.object?.order?.id ??
    p?.data?.object?.payment?.order_id ??
    (p?.data?.type?.startsWith('order_') && p?.data?.id ? p.data.id : undefined)
  )
}

/**
 * Drains `SquareInboxEvent`. For each unprocessed row: resolve the order
 * id from the raw payload, fetch the canonical order (webhook payloads
 * may be partial -- spec §7.1), map it through the same
 * `mapOrderToLedgerInputs` the reconciliation poll uses, and append every
 * resulting event through `LedgerService` -- never `prisma.ledgerEvent`
 * directly (sole-writer invariant, enforced in CI).
 *
 * A catalogObjectId that resolves to no known Variation is dead-lettered:
 * the row is still marked processed (its mappable lines are safely in the
 * ledger, and no amount of retrying invents a Variation that doesn't
 * exist), but `error` carries the dead-letter detail as JSON so it stays
 * visible rather than vanishing. A row that fails outright (bad payload,
 * Square API error) is left with `processedAt` unset so the next
 * `processOne()` retries it.
 */
@Injectable()
export class InboxWorker {
  private readonly logger = new Logger(InboxWorker.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(ORDER_FETCHER) private readonly fetchOrder: OrderFetcher,
  ) {}

  async processOne(): Promise<{ processed: number; failed: number; deadLettered: number }> {
    const rows = await this.prisma.squareInboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { receivedAt: 'asc' },
    })

    let processed = 0
    let failed = 0
    let deadLettered = 0

    // Two indexes: warehouse variants for per-SKU mappings (Earmuffs / Black),
    // and family variations as a fallback for single-SKU products where only
    // Variation.squareVariationId is set. resolveCatalog() below tries variant
    // first so variant-mapped items land on the specific WarehouseVariant.
    const [warehouseVariants, variations, locations] = await Promise.all([
      this.prisma.warehouseVariant.findMany({
        where: { squareVariationId: { not: null } },
        select: { id: true, variationId: true, squareVariationId: true },
      }),
      this.prisma.variation.findMany({
        where: { squareVariationId: { not: null } },
        select: { id: true, squareVariationId: true },
      }),
      this.prisma.location.findMany({
        where: { squareLocationId: { not: null } },
        select: { id: true, squareLocationId: true },
      }),
    ])
    const warehouseVariantIndex = new Map(
      warehouseVariants.map((wv) => [
        wv.squareVariationId as string,
        { variationId: wv.variationId, warehouseVariantId: wv.id },
      ]),
    )
    const variationIndex = new Map(variations.map((v) => [v.squareVariationId as string, { variationId: v.id }]))
    const locationIndex = new Map(locations.map((l) => [l.squareLocationId as string, l.id]))
    const resolveCatalog = (id: string) => warehouseVariantIndex.get(id) ?? variationIndex.get(id)

    for (const row of rows) {
      const orderId = extractOrderId(row.payload)
      if (!orderId) {
        await this.prisma.squareInboxEvent.update({ where: { id: row.id }, data: { error: 'no order id found in payload' } })
        failed++
        continue
      }

      try {
        const order = await this.fetchOrder(orderId)
        const { events, deadLetters } = mapOrderToLedgerInputs(
          order,
          resolveCatalog,
          (id) => locationIndex.get(id),
          'WEBHOOK',
        )

        for (const event of events) {
          await this.ledger.append(event)
        }

        if (deadLetters.length > 0) {
          deadLettered += deadLetters.length
          this.logger.warn(`dead-lettered ${deadLetters.length} line(s) on order ${orderId}: ${summarise(deadLetters)}`)
        }

        await this.prisma.squareInboxEvent.update({
          where: { id: row.id },
          data: {
            processedAt: new Date(),
            error: deadLetters.length > 0 ? JSON.stringify(deadLetters) : null,
          },
        })
        processed++
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : String(err)
        this.logger.error(`failed to process inbox row ${row.id} (order ${orderId}): ${message}`)
        await this.prisma.squareInboxEvent.update({ where: { id: row.id }, data: { error: message } })
      }
    }

    return { processed, failed, deadLettered }
  }
}

function summarise(deadLetters: DeadLetter[]): string {
  return deadLetters.map((d) => `${d.lineUid || '(no uid)'}: ${d.reason}`).join('; ')
}
