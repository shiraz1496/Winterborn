import { Injectable, NotFoundException } from '@nestjs/common'
import type { RequestLineAnalysis } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'

/// Doc 3 §3.3 recommendation + §3.4 overallocation guard, produced together
/// for one request. The two features share the same "what's in the warehouse
/// and what's already claimed against it" data, so one endpoint is one
/// round-trip and one consistent snapshot -- the UI never renders a
/// recommendation from moment T against an allocation flag from T+300ms.
///
/// Both figures are derived. Nothing here writes. Recommendation is style-
/// level only (§3.3): the underlying Threshold.minLevel is already computed
/// per (variation, location) at style granularity, and last season's colour
/// data is too thin to break down further this season.
///
/// TARGET_WEEKS caps how far ahead the recommendation reaches. Aim to cover
/// the next replenishment window -- not the whole remaining season -- so the
/// number is the "smallest practical shipment that provides sufficient
/// inventory until the next reasonable replenishment opportunity" the CEO
/// transcript §23 calls for, and matches Doc 3 §3.3's "not a new prediction
/// engine". A location whose season ends sooner than that reaches the season
/// end instead.
const TARGET_WEEKS = 2

const OPEN_STATES = ['DRAFT', 'OPEN'] as const

@Injectable()
export class RequestAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerRead: LedgerReadService,
  ) {}

  async analyse(requestId: string): Promise<RequestLineAnalysis[]> {
    const request = await this.prisma.restockRequest.findUnique({
      where: { id: requestId },
      include: { lines: true, location: true },
    })
    if (!request) throw new NotFoundException(`request ${requestId} not found`)

    if (request.lines.length === 0) return []

    const variationIds = [...new Set(request.lines.map((l) => l.variationId))]

    // One-shot bulk reads keep this O(bulk) even on a large request. The
    // ledger holds 40k+ rows; a per-line onHandFor() call would be one
    // aggregate query per line -- what plan-06 hardened against.
    const [warehouse, thresholds, warehouseStock, requestingStock, competingLines] = await Promise.all([
      this.prisma.location.findFirst({ where: { kind: 'WAREHOUSE' }, select: { id: true } }),
      this.prisma.threshold.findMany({
        where: { locationId: request.locationId, variationId: { in: variationIds } },
        select: { variationId: true, minLevel: true },
      }),
      this.warehouseStockFor(variationIds),
      this.stockFor(request.locationId, variationIds),
      this.competingOpenDemand(variationIds, requestId),
    ])

    if (!warehouse) throw new NotFoundException('no WAREHOUSE location configured')

    const minLevelBy = new Map(thresholds.map((t) => [t.variationId, t.minLevel]))
    const warehouseOnHandBy = warehouseStock
    const locationOnHandBy = requestingStock

    const weeksRemaining = computeWeeksRemaining(request.location.seasonEnd)

    // Sum this request's own lines per variation, so a request with two
    // lines of the same family reads its own competition correctly.
    const sameRequestByVariation = new Map<string, number>()
    for (const line of request.lines) {
      sameRequestByVariation.set(
        line.variationId,
        (sameRequestByVariation.get(line.variationId) ?? 0) + line.qtyRequested,
      )
    }

    return request.lines.map((line) => {
      const minLevel = minLevelBy.get(line.variationId) ?? null
      const onHand = locationOnHandBy.get(line.variationId) ?? 0
      const recommendedQty = computeRecommended(minLevel, onHand, weeksRemaining)

      const warehouseOnHand = warehouseOnHandBy.get(line.variationId) ?? 0
      const competing = competingLines.get(line.variationId) ?? { totalQty: 0, locations: new Set<string>() }
      const sameRequestDemand =
        (sameRequestByVariation.get(line.variationId) ?? 0) - line.qtyRequested
      const wouldStarveOthers =
        competing.totalQty > 0 &&
        warehouseOnHand - line.qtyRequested - sameRequestDemand < competing.totalQty

      return {
        lineId: line.id,
        variationId: line.variationId,
        qtyRequested: line.qtyRequested,
        recommendation: {
          qty: recommendedQty,
          minLevel,
          onHand,
          weeksRemaining,
        },
        allocation: {
          warehouseOnHand,
          otherOpenDemand: competing.totalQty,
          sameRequestDemand,
          wouldStarveOthers,
          otherLocationCount: competing.locations.size,
        },
      }
    })
  }

  private async warehouseStockFor(variationIds: string[]): Promise<Map<string, number>> {
    const warehouse = await this.prisma.location.findFirst({
      where: { kind: 'WAREHOUSE' },
      select: { id: true },
    })
    if (!warehouse) return new Map()
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['variationId'],
      _sum: { quantity: true },
      where: { locationId: warehouse.id, variationId: { in: variationIds } },
    })
    return new Map(rows.map((r) => [r.variationId, r._sum.quantity ?? 0]))
  }

  private async stockFor(locationId: string, variationIds: string[]): Promise<Map<string, number>> {
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['variationId'],
      _sum: { quantity: true },
      where: { locationId, variationId: { in: variationIds } },
    })
    return new Map(rows.map((r) => [r.variationId, r._sum.quantity ?? 0]))
  }

  private async competingOpenDemand(
    variationIds: string[],
    excludeRequestId: string,
  ): Promise<Map<string, { totalQty: number; locations: Set<string> }>> {
    const lines = await this.prisma.restockRequestLine.findMany({
      where: {
        variationId: { in: variationIds },
        request: {
          state: { in: [...OPEN_STATES] },
          id: { not: excludeRequestId },
        },
      },
      select: {
        variationId: true,
        qtyRequested: true,
        request: { select: { locationId: true } },
      },
    })
    const out = new Map<string, { totalQty: number; locations: Set<string> }>()
    for (const line of lines) {
      const bucket = out.get(line.variationId) ?? { totalQty: 0, locations: new Set<string>() }
      bucket.totalQty += line.qtyRequested
      bucket.locations.add(line.request.locationId)
      out.set(line.variationId, bucket)
    }
    return out
  }
}

function computeWeeksRemaining(seasonEnd: Date | null): number | null {
  if (!seasonEnd) return null
  const msRemaining = seasonEnd.getTime() - Date.now()
  if (msRemaining <= 0) return 0
  return Math.max(1, Math.ceil(msRemaining / (7 * 24 * 60 * 60 * 1000)))
}

function computeRecommended(
  minLevel: number | null,
  onHand: number,
  weeksRemaining: number | null,
): number | null {
  if (minLevel == null || minLevel <= 0) return null
  if (weeksRemaining === 0) return 0
  const targetWeeks = weeksRemaining == null ? TARGET_WEEKS : Math.min(TARGET_WEEKS, weeksRemaining)
  const target = minLevel * targetWeeks
  const needed = target - onHand
  if (needed <= 0) return 0
  return Math.max(1, needed)
}
