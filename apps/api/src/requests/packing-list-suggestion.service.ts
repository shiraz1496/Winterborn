import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type {
  GenerateSuggestionInput,
  GenerateSuggestionResult,
  SuggestionLine,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Generates a full draft packing list for one market location, given a
 * target mode. Answers the CEO's ask from voice notes on 2026-09-01:
 * instead of a person deciding which products to send, the system proposes
 * a list based on last year's sales at that market, current warehouse
 * stock, and cross-location competing demand.
 *
 * This is a sibling of `RequestAnalysisService`, not a replacement:
 *   - `RequestAnalysisService` answers "how many of this line should I ask
 *     for?" for lines already drafted on a request.
 *   - This service answers "what should the whole request look like?"
 *     starting from an empty draft.
 *
 * Algorithm:
 *   1. Resolve the "last year" window (season-based when available,
 *      otherwise trailing 12 months ending one year ago).
 *   2. Aggregate Square SALE events at this location in that window,
 *      grouped by variation (family). This is the demand signal — actual
 *      customers buying, uncontaminated by our own request history.
 *   3. Aggregate DISPATCH events at this location in the same window,
 *      grouped by (variation, warehouseVariant). Since Square SALE rows
 *      are family-level only (see `LedgerEvent` schema note), dispatches
 *      are the only history that carries colour. We use them as the
 *      colour-split proxy — markets order what they can sell, so what got
 *      shipped is a fair signal of the market's colour preference.
 *   4. Query current warehouse on-hand per warehouseVariant. This is the
 *      hard cap — we cannot recommend what does not exist.
 *   5. Query competing demand: DRAFT + OPEN request lines at OTHER
 *      locations, grouped by variation. Warehouse stock is finite; if two
 *      markets both want 40, both cannot get 40.
 *   6. Compute per-variation target quantities per the target mode.
 *   7. Split each variation's qty across colours in proportion to the
 *      last-year dispatch mix.
 *   8. Cap each colour at its warehouseVariant on-hand.
 *   9. Discount for cross-location competing demand (proportional).
 *
 * If a location has no sales history yet (fresh market, or the historical
 * Square backfill has not been run) the service returns an empty list
 * with a note explaining what to do about it — never a bogus guess.
 */
@Injectable()
export class PackingListSuggestionService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(input: GenerateSuggestionInput): Promise<GenerateSuggestionResult> {
    const location = await this.prisma.location.findUnique({
      where: { id: input.locationId },
      select: { id: true, name: true, kind: true, seasonStart: true, seasonEnd: true },
    })
    if (!location) throw new NotFoundException(`location ${input.locationId} not found`)
    if (location.kind !== 'MARKET') {
      throw new BadRequestException(`packing lists are only generated for MARKET locations (got ${location.kind})`)
    }

    const warehouse = await this.prisma.location.findFirst({
      where: { kind: 'WAREHOUSE' },
      select: { id: true, name: true },
    })
    if (!warehouse) throw new NotFoundException('no WAREHOUSE location configured')

    const window = resolveLastYearWindow(input, location.seasonStart, location.seasonEnd)
    const notes: string[] = []

    // Signal 1: last year's SALEs at this location, grouped by variation.
    // Sales are negative on-ledger (a sale removes stock from that market).
    // We flip sign to expose "units sold" as a positive number.
    const salesByVariation = await this.prisma.ledgerEvent
      .groupBy({
        by: ['variationId'],
        _sum: { quantity: true },
        where: {
          locationId: input.locationId,
          type: 'SALE',
          occurredAt: { gte: window.start, lte: window.end },
        },
      })
      .then((rows) =>
        new Map(
          rows.map((r) => [r.variationId, Math.max(0, -(r._sum.quantity ?? 0))]),
        ),
      )

    // Signal 2: last year's DISPATCHes to this location, grouped by
    // (variation, warehouseVariant). The colour proxy. DISPATCH rows write
    // negative at the warehouse and positive at the destination — we look
    // at the destination side (positive) so `quantity > 0` here means
    // "arrived at this market."
    const dispatchesRaw = await this.prisma.ledgerEvent.groupBy({
      by: ['variationId', 'warehouseVariantId'],
      _sum: { quantity: true },
      where: {
        locationId: input.locationId,
        type: 'DISPATCH',
        warehouseVariantId: { not: null },
        occurredAt: { gte: window.start, lte: window.end },
      },
    })
    const dispatchByFamily = new Map<string, Map<string, number>>()
    for (const row of dispatchesRaw) {
      if (!row.warehouseVariantId) continue
      const qty = Math.max(0, row._sum.quantity ?? 0)
      if (qty === 0) continue
      const colourMap = dispatchByFamily.get(row.variationId) ?? new Map<string, number>()
      colourMap.set(row.warehouseVariantId, qty)
      dispatchByFamily.set(row.variationId, colourMap)
    }

    // Fallback signal: if sales are thin, dispatches at the family level
    // stand in. Same shape as `salesByVariation`.
    const dispatchTotalsByVariation = new Map<string, number>()
    for (const [vId, colours] of dispatchByFamily.entries()) {
      let sum = 0
      for (const q of colours.values()) sum += q
      dispatchTotalsByVariation.set(vId, sum)
    }

    // Merge the two demand signals: prefer sales when we have them, fall
    // back to dispatches. Never mix within one variation — that would
    // double-count.
    const demandByVariation = new Map<string, number>()
    let usedFallback = false
    const variationIdSet = new Set<string>([
      ...salesByVariation.keys(),
      ...dispatchTotalsByVariation.keys(),
    ])
    for (const vId of variationIdSet) {
      const sold = salesByVariation.get(vId) ?? 0
      const shipped = dispatchTotalsByVariation.get(vId) ?? 0
      if (sold > 0) {
        demandByVariation.set(vId, sold)
      } else if (shipped > 0) {
        demandByVariation.set(vId, shipped)
        usedFallback = true
      }
    }

    if (demandByVariation.size === 0) {
      notes.push(
        `No sales or dispatch history for ${location.name} between ${window.start.toISOString().slice(0, 10)} and ${window.end.toISOString().slice(0, 10)}. If Square history has not been backfilled, run \`pnpm --filter api cli:backfill-square-sales\` first.`,
      )
      return {
        locationId: input.locationId,
        targetMode: input.targetMode,
        window,
        lines: [],
        totals: { variationsCovered: 0, totalRecommendedUnits: 0, totalLastYearUnits: 0 },
        notes,
      }
    }

    if (usedFallback) {
      notes.push(
        `Some variations had no Square SALE data in the window — historical dispatches to ${location.name} were used as a demand proxy for those. Numbers are noisier for those items.`,
      )
    }

    // Signal 3: current warehouse on-hand per warehouseVariant. Hard cap.
    const variationIds = [...demandByVariation.keys()]
    const warehouseVariantsForFamilies = await this.prisma.warehouseVariant.findMany({
      where: { variation: { id: { in: variationIds } } },
      select: {
        id: true,
        variationId: true,
        colourVariantId: true,
        sizeOptionId: true,
      },
    })
    const warehouseVariantsByFamily = new Map<string, Array<(typeof warehouseVariantsForFamilies)[number]>>()
    for (const wv of warehouseVariantsForFamilies) {
      const list = warehouseVariantsByFamily.get(wv.variationId) ?? []
      list.push(wv)
      warehouseVariantsByFamily.set(wv.variationId, list)
    }
    const warehouseVariantIds = warehouseVariantsForFamilies.map((wv) => wv.id)

    const onHandRows = warehouseVariantIds.length
      ? await this.prisma.ledgerEvent.groupBy({
          by: ['warehouseVariantId'],
          _sum: { quantity: true },
          where: {
            locationId: warehouse.id,
            warehouseVariantId: { in: warehouseVariantIds },
          },
        })
      : []
    const onHandByWarehouseVariant = new Map<string, number>()
    for (const row of onHandRows) {
      if (!row.warehouseVariantId) continue
      onHandByWarehouseVariant.set(row.warehouseVariantId, Math.max(0, row._sum.quantity ?? 0))
    }

    // Signal 4: cross-location competing demand. Sum of qtyRequested on
    // DRAFT + OPEN lines at OTHER MARKET locations, grouped by variation.
    // This is what would starve someone else if we allocated everything
    // here.
    const competingLines = await this.prisma.restockRequestLine.findMany({
      where: {
        variationId: { in: variationIds },
        request: {
          state: { in: ['DRAFT', 'OPEN'] },
          locationId: { not: input.locationId },
        },
      },
      select: { variationId: true, qtyRequested: true },
    })
    const competingByFamily = new Map<string, number>()
    for (const line of competingLines) {
      competingByFamily.set(line.variationId, (competingByFamily.get(line.variationId) ?? 0) + line.qtyRequested)
    }

    // Compute per-variation target qty per mode. CUSTOM_UNITS shares the
    // budget across variations in proportion to their last-year mix — a
    // small item does not steal the whole packing list from a bestseller.
    const totalLastYear = [...demandByVariation.values()].reduce((a, b) => a + b, 0)
    const targetByVariation = new Map<string, number>()
    for (const [vId, sold] of demandByVariation.entries()) {
      let target = 0
      switch (input.targetMode) {
        case 'MATCH_LAST_YEAR':
          target = sold
          break
        case 'GROW_PCT':
          target = Math.round(sold * (1 + (input.growthPct ?? 0) / 100))
          break
        case 'CUSTOM_UNITS': {
          const share = totalLastYear > 0 ? sold / totalLastYear : 0
          target = Math.round((input.targetUnits ?? 0) * share)
          break
        }
      }
      if (target > 0) targetByVariation.set(vId, target)
    }

    const lines: SuggestionLine[] = []

    for (const [variationId, familyTarget] of targetByVariation.entries()) {
      const wvList = warehouseVariantsByFamily.get(variationId) ?? []
      if (wvList.length === 0) {
        // Family has no warehouse variants in stock catalog — skip. This
        // is what happens for families that only existed last season and
        // have been retired.
        continue
      }

      const colourMix = dispatchByFamily.get(variationId) ?? new Map<string, number>()
      const mixTotal = [...colourMix.values()].reduce((a, b) => a + b, 0)

      // Cross-location scaling: if two markets both want more than the
      // warehouse can supply, scale each down proportionally rather than
      // first-come-first-served.
      const totalWarehouseOnHandForFamily = wvList.reduce(
        (sum, wv) => sum + (onHandByWarehouseVariant.get(wv.id) ?? 0),
        0,
      )
      const competing = competingByFamily.get(variationId) ?? 0
      const availableForThisLocation = Math.max(0, totalWarehouseOnHandForFamily - competing)
      const scaleFactor = familyTarget === 0
        ? 0
        : Math.min(1, availableForThisLocation / familyTarget)
      const scaledTarget = Math.floor(familyTarget * scaleFactor)

      if (scaledTarget === 0) {
        // Nothing to allocate — either no stock or fully claimed by other
        // markets. Skip; we do not emit zero-qty suggestion lines.
        continue
      }

      // Split scaledTarget across colours by last-year dispatch mix. If we
      // have no dispatch history for this family, split evenly across
      // available warehouse variants (better than dropping the family).
      const perColourRaw = new Map<string, number>()
      if (mixTotal > 0) {
        for (const wv of wvList) {
          const mixQty = colourMix.get(wv.id) ?? 0
          const share = mixQty / mixTotal
          perColourRaw.set(wv.id, scaledTarget * share)
        }
      } else {
        const even = scaledTarget / wvList.length
        for (const wv of wvList) perColourRaw.set(wv.id, even)
      }

      // Cap each colour at its own warehouse on-hand, then round.
      for (const wv of wvList) {
        const raw = perColourRaw.get(wv.id) ?? 0
        const onHand = onHandByWarehouseVariant.get(wv.id) ?? 0
        const capped = Math.min(raw, onHand)
        const qty = Math.round(capped)
        if (qty <= 0) continue

        const lastYearSoldForColour = colourMix.get(wv.id) ?? 0
        lines.push({
          variationId,
          warehouseVariantId: wv.id,
          qtyRecommended: qty,
          lastYearSold: lastYearSoldForColour || Math.round(demandByVariation.get(variationId) ?? 0),
          warehouseOnHand: onHand,
          otherLocationDemand: competing,
          rationale: buildRationale({
            lastYearSoldForColour,
            familyLastYear: demandByVariation.get(variationId) ?? 0,
            onHand,
            competing,
            targetMode: input.targetMode,
            growthPct: input.growthPct,
            wasFallback: !salesByVariation.get(variationId) && (dispatchTotalsByVariation.get(variationId) ?? 0) > 0,
          }),
        })
      }
    }

    // Deterministic ordering: highest recommended qty first. Makes the
    // draft easy to skim — bestsellers up top, tail below.
    lines.sort((a, b) => b.qtyRecommended - a.qtyRecommended)

    const totalRecommended = lines.reduce((sum, l) => sum + l.qtyRecommended, 0)
    if (input.targetMode === 'CUSTOM_UNITS' && input.targetUnits && totalRecommended < input.targetUnits) {
      notes.push(
        `Target was ${input.targetUnits} units but only ${totalRecommended} could be allocated — warehouse stock is the bottleneck.`,
      )
    }

    return {
      locationId: input.locationId,
      targetMode: input.targetMode,
      window,
      lines,
      totals: {
        variationsCovered: new Set(lines.map((l) => l.variationId)).size,
        totalRecommendedUnits: totalRecommended,
        totalLastYearUnits: totalLastYear,
      },
      notes,
    }
  }
}

function resolveLastYearWindow(
  input: GenerateSuggestionInput,
  seasonStart: Date | null,
  seasonEnd: Date | null,
): { start: Date; end: Date } {
  if (input.lastYearStart && input.lastYearEnd) {
    return { start: input.lastYearStart, end: input.lastYearEnd }
  }
  // Prefer the season-aligned window (Nov 7 → Dec 24 last year to plan for
  // the same season this year) — that's what the CEO described.
  if (seasonStart && seasonEnd) {
    return { start: shiftYears(seasonStart, -1), end: shiftYears(seasonEnd, -1) }
  }
  // Fallback: trailing 12 months ending one year ago from today, i.e.,
  // the "same 12-month window one year back".
  const now = new Date()
  const end = shiftYears(now, -1)
  const start = shiftYears(end, -1)
  return { start, end }
}

function shiftYears(d: Date, years: number): Date {
  const out = new Date(d)
  out.setFullYear(out.getFullYear() + years)
  return out
}

function buildRationale(args: {
  lastYearSoldForColour: number
  familyLastYear: number
  onHand: number
  competing: number
  targetMode: GenerateSuggestionInput['targetMode']
  growthPct?: number
  wasFallback: boolean
}): string {
  const parts: string[] = []
  if (args.lastYearSoldForColour > 0) {
    parts.push(`Sold ${args.lastYearSoldForColour} last season`)
  } else if (args.familyLastYear > 0) {
    parts.push(`Style sold ${args.familyLastYear} last season (colour mix estimated)`)
  }
  if (args.wasFallback) {
    parts.push('using dispatch history as a proxy for sales')
  }
  if (args.targetMode === 'GROW_PCT' && args.growthPct) {
    const label = args.growthPct >= 0 ? `growing target by ${args.growthPct}%` : `shrinking target by ${Math.abs(args.growthPct)}%`
    parts.push(label)
  }
  if (args.targetMode === 'CUSTOM_UNITS') {
    parts.push('scaled to fit your custom unit budget')
  }
  if (args.competing > 0) {
    parts.push(`${args.competing} units also requested by other markets`)
  }
  parts.push(`warehouse has ${args.onHand} available`)
  return parts.join('; ') + '.'
}
