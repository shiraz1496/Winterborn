import { Injectable, Inject, Logger } from '@nestjs/common'
import type { Square } from 'square'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { mapOrderToLedgerInputs } from './order-mapper.js'

export type OrderSearcher = (request: Square.SearchOrdersRequest) => Promise<Square.SearchOrdersResponse>

export const ORDER_SEARCHER = Symbol('ORDER_SEARCHER')

/**
 * Re-scanned every pass regardless of how recently the location was last
 * polled, so nothing is lost right at a cursor boundary (spec §7.2).
 */
const OVERLAP_MINUTES = 60

export interface PollResult {
  /** Ledger rows actually created this pass. */
  ingested: number
  /** Events that resolved to an idempotency key already in the ledger -- the self-heal path doing nothing, correctly. */
  deduped: number
}

/**
 * The reconciliation poll: the source of truth. The webhook (Task 1) is
 * only the low-latency trigger; this is what a week of dropped webhooks
 * self-heals against, on one pass, because it maps through the exact same
 * `mapOrderToLedgerInputs` the inbox worker uses and therefore produces
 * identical idempotency keys for the same sale (spec §7.2).
 */
@Injectable()
export class PollService {
  private readonly logger = new Logger(PollService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(ORDER_SEARCHER) private readonly searchOrders: OrderSearcher,
  ) {}

  /**
   * Polls one market location to exhaustion (paginating until Square stops
   * returning a cursor), then advances that location's watermark -- but
   * only once every page of this pass has succeeded. If any page throws,
   * `SquareSyncCursor.lastPolledAt` is left untouched, so the next call
   * derives the same `since` (with the same 60-minute overlap) and
   * re-scans from there rather than silently skipping whatever failed.
   */
  async pollLocation(locationId: string): Promise<PollResult> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } })
    if (!location.squareLocationId) {
      throw new Error(`Location ${locationId} (${location.name}) has no squareLocationId; cannot poll`)
    }

    const cursorRow = await this.prisma.squareSyncCursor.findUnique({ where: { locationId } })
    const passStartedAt = new Date()
    const since = cursorRow?.lastPolledAt
      ? new Date(cursorRow.lastPolledAt.getTime() - OVERLAP_MINUTES * 60_000)
      : (location.seasonStart ?? new Date(0))

    // Two indexes, same shape as the inbox worker's: variant-first, family
    // fallback. Kept in lockstep with inbox.worker.ts so both paths produce
    // identical resolver behaviour — that shared behaviour is what the
    // idempotency guarantee ultimately depends on.
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

    let ingested = 0
    let deduped = 0
    let squareCursor: string | undefined

    do {
      const res = await this.searchOrders({
        locationIds: [location.squareLocationId],
        cursor: squareCursor,
        query: {
          filter: { dateTimeFilter: { updatedAt: { startAt: since.toISOString() } } },
          // Square requires the sort field to match the DateTimeFilter field.
          sort: { sortField: 'UPDATED_AT', sortOrder: 'ASC' },
        },
      })

      for (const order of res.orders ?? []) {
        // Same mapper the inbox worker uses (order-mapper.ts) -- not a
        // copy -- so a sale ingested first by the webhook and again here
        // produces the identical idempotencyKey and dedupes instead of
        // double-counting.
        const { events, deadLetters } = mapOrderToLedgerInputs(
          order,
          resolveCatalog,
          (id) => locationIndex.get(id),
          'POLL',
        )
        if (deadLetters.length > 0) {
          this.logger.warn(`poll dead-lettered ${deadLetters.length} line(s) on order ${order.id ?? '(no id)'}`)
        }
        for (const event of events) {
          const { created } = await this.ledger.append(event)
          if (created) ingested++
          else deduped++
        }
      }

      squareCursor = res.cursor
    } while (squareCursor)

    await this.prisma.squareSyncCursor.upsert({
      where: { locationId },
      create: { locationId, lastPolledAt: passStartedAt, cursor: null },
      update: { lastPolledAt: passStartedAt, cursor: null },
    })

    return { ingested, deduped }
  }

  /** Polls every active market location. One location's failure does not block the others. */
  async pollAll(): Promise<Array<{ locationId: string; result?: PollResult; error?: string }>> {
    const marketLocations = await this.prisma.location.findMany({
      where: { kind: 'MARKET', isActive: true, squareLocationId: { not: null } },
    })

    const results: Array<{ locationId: string; result?: PollResult; error?: string }> = []
    for (const location of marketLocations) {
      try {
        const result = await this.pollLocation(location.id)
        results.push({ locationId: location.id, result })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.logger.error(`poll failed for location ${location.id} (${location.name}): ${message}`)
        results.push({ locationId: location.id, error: message })
      }
    }
    return results
  }
}
