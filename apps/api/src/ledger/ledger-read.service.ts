import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { StockLevel } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Derives stock. Never stores it.
 *
 * on_hand(variation, location) = SUM(quantity) over ledger_event
 *
 * Signed quantities mean one SUM answers every stock question, and because
 * nothing is cached there is no second source of truth that can silently
 * disagree with the ledger. Spec §5.6 defers a rollup table to Stage 2, and
 * only if measurement demands it.
 */
@Injectable()
export class LedgerReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Family level. Valid everywhere, including live markets. */
  async onHandByFamily(locationId?: string): Promise<StockLevel[]> {
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['variationId', 'locationId'],
      _sum: { quantity: true },
      where: locationId ? { locationId } : undefined,
    })
    return rows.map((r) => ({
      variationId: r.variationId,
      warehouseVariantId: null,
      locationId: r.locationId,
      onHand: r._sum.quantity ?? 0,
    }))
  }

  /**
   * Variant level. Exact at the warehouse. At a market this reads
   * "sent, not yet reconciled", because sales carry no variant.
   */
  async onHandByVariant(locationId?: string): Promise<StockLevel[]> {
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['warehouseVariantId', 'variationId', 'locationId'],
      _sum: { quantity: true },
      where: {
        warehouseVariantId: { not: null },
        ...(locationId ? { locationId } : {}),
      },
    })
    return rows.map((r) => ({
      variationId: r.variationId,
      warehouseVariantId: r.warehouseVariantId,
      locationId: r.locationId,
      onHand: r._sum.quantity ?? 0,
    }))
  }

  async onHandFor(variationId: string, locationId: string): Promise<number> {
    const agg = await this.prisma.ledgerEvent.aggregate({
      _sum: { quantity: true },
      where: { variationId, locationId },
    })
    return agg._sum.quantity ?? 0
  }

  /**
   * Recomputes every balance from the raw event stream, deliberately via a
   * different code path than onHandByFamily: hand-written SQL against the
   * table rather than Prisma's groupBy.
   *
   * Two independently-coded aggregations that must always agree is the
   * point. If they diverge, one of the two has a derivation-logic bug — a
   * wrong WHERE clause, the wrong GROUP BY columns, an aggregation mistake —
   * and the mismatch catches it. Both queries read the same table at the
   * same instant, so agreement here says nothing about who wrote the rows
   * or whether a row was later mutated in place; it cannot detect either.
   * The no-permanent-drift guarantee comes from the schema itself storing no
   * balance anywhere, not from this comparison — see the append-only
   * constraint on LedgerEvent for what actually rules out in-place mutation.
   */
  async recompute(locationId?: string): Promise<StockLevel[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ variationId: string; locationId: string; onHand: bigint }>
    >`
      SELECT "variationId", "locationId", SUM("quantity")::bigint AS "onHand"
      FROM "LedgerEvent"
      ${locationId ? Prisma.sql`WHERE "locationId" = ${locationId}` : Prisma.empty}
      GROUP BY "variationId", "locationId"
    `
    return rows.map((r) => ({
      variationId: r.variationId,
      warehouseVariantId: null,
      locationId: r.locationId,
      onHand: Number(r.onHand),
    }))
  }

  /**
   * Variant-level counterpart to recompute(). Hand-written SQL against the
   * table, so it and onHandByVariant() are two independent implementations
   * that must always agree. Same reasoning as recompute(): a derivation-logic
   * bug in either is caught by their disagreement.
   */
  async recomputeByVariant(locationId?: string): Promise<StockLevel[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ warehouseVariantId: string; variationId: string; locationId: string; onHand: bigint }>
    >`
      SELECT "warehouseVariantId", "variationId", "locationId", SUM("quantity")::bigint AS "onHand"
      FROM "LedgerEvent"
      WHERE "warehouseVariantId" IS NOT NULL
      ${locationId ? Prisma.sql`AND "locationId" = ${locationId}` : Prisma.empty}
      GROUP BY "warehouseVariantId", "variationId", "locationId"
    `
    return rows.map((r) => ({
      variationId: r.variationId,
      warehouseVariantId: r.warehouseVariantId,
      locationId: r.locationId,
      onHand: Number(r.onHand),
    }))
  }
}
