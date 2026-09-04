import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import {
  DEFAULT_MIN_PACK_QTY,
  DEFAULT_ROUND_TO_NEAREST,
  defaultShelfBufferPct,
} from '@winterborn/shared'
import type {
  GenerateSuggestionInput,
  GenerateSuggestionResult,
  SuggestionConfidence,
  SuggestionConstraint,
  SuggestionDemandSource,
  SuggestionExplain,
  SuggestionLine,
  SuggestionSourceMarket,
  SuggestionStep,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Generates a full draft packing list for one market location.
 *
 * This is a sibling of `RequestAnalysisService`, not a replacement:
 *   - `RequestAnalysisService` answers "how many of this line should I ask
 *     for?" for lines already drafted on a request.
 *   - This service answers "what should the whole request look like?"
 *     starting from an empty draft.
 *
 * ## Demand ladder
 *
 * The engine never dead-ends. It walks down a ladder of demand signals and
 * uses the first rung that produces anything, recording which rung it landed
 * on so the UI can say so out loud:
 *
 *   1. LOCAL_SALES          this market's sales inside the chosen window
 *   2. LOCAL_SALES_WIDENED  same, over all available history (the chosen
 *                           window was outside the season / before backfill)
 *   3. CROSS_MARKET         other active markets' sales in the window,
 *                           averaged per market (the "new market" case)
 *   4. CROSS_MARKET_WIDENED same, over all available history
 *   5. WAREHOUSE_STOCK      nothing has ever sold in scope; size the list
 *                           from what is physically in the warehouse
 *
 * A date range with no sales in it therefore produces a list plus an
 * explanation, never an empty screen.
 *
 * ## Pack shape
 *
 * Raw arithmetic produces numbers like 21 and 1. Neither is a pack. Every
 * final quantity is rounded to a multiple of `roundToNearest` (default 5)
 * and must clear `minPackQty` (default 5):
 *   - real-but-short demand (it rounds up to at least one pack) is raised
 *     to the minimum when stock allows;
 *   - demand too small to round up to a pack at all is dropped, never
 *     bumped. Otherwise a style selling 3 units across 10 colours would
 *     ship 10 minimum packs;
 *   - budget modes drop the whole sub-minimum tail and redistribute its
 *     budget across the survivors, so the dollar/unit target stays honest;
 *   - a line the warehouse cannot fill to the minimum is dropped and
 *     counted, rather than shipped as a token single unit.
 *
 * ## Shelf buffer
 *
 * A revenue target is a sell-through goal. Shipping exactly the units that
 * reach it leaves an empty table on the last day of the market, so the
 * target is multiplied by `1 + shelfBufferPct/100` before allocation
 * (default 20% on revenue mode, 0 where the operator typed explicit units).
 *
 * ## Warehouse safety
 *
 *   - Hard cap at physical on-hand, per SKU.
 *   - Cross-market fair share: a market's slice of a product's stock is
 *     proportional to its slice of that product's demand, at both family
 *     and colour grain, so the first market to hit Generate can't drain the
 *     warehouse.
 *   - Other markets' DRAFT/OPEN request lines are subtracted first.
 *
 * Every line carries `steps` (the arithmetic in order), `bindingConstraint`
 * (which rule actually set the number) and `confidenceReason`, and the run
 * carries an `explain` block naming the data source, the window actually
 * used, and the specific markets that contributed.
 */
@Injectable()
export class PackingListSuggestionService {
  constructor(private readonly prisma: PrismaService) { }

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

    const shelfBufferPct = input.shelfBufferPct ?? defaultShelfBufferPct(input.targetMode)
    const roundToNearest = input.roundToNearest ?? DEFAULT_ROUND_TO_NEAREST
    const minPackQty = input.minPackQty ?? DEFAULT_MIN_PACK_QTY
    const isBudgetMode =
      input.targetMode === 'CUSTOM_UNITS' ||
      input.targetMode === 'CUSTOM_REVENUE' ||
      input.targetMode === 'INITIAL_SHIPMENT'

    const windowRequested = resolveLastYearWindow(input, location.seasonStart, location.seasonEnd)
    const notes: string[] = []

    // Optional category filter. Walk the tree down from the chosen roots
    // and collect every descendant category. Variations whose ItemGroup is
    // in that descendant set survive; everything else is skipped before we
    // do any target math.
    const allowedVariationIds = await this.resolveCategoryFilter(input.categoryIds)
    if (allowedVariationIds && allowedVariationIds.size === 0) {
      notes.push('No products match the categories you picked, so there is nothing to suggest. Clear the category filter or pick a different group.')
      return emptyResult(input, windowRequested, notes, {
        demandSource: 'WAREHOUSE_STOCK',
        headline: 'No products matched the selected categories.',
        steps: ['The category filter excluded every product in the catalog.'],
        targetSummary: 'No products in scope',
        windowRequested,
        windowUsed: windowRequested,
        windowWidened: false,
        sourceMarkets: [],
        settings: { shelfBufferPct, roundToNearest, minPackQty },
        budget: null,
        droppedBelowMinimum: 0,
      })
    }
    if (allowedVariationIds && input.categoryIds) {
      notes.push(
        `Filtered to ${allowedVariationIds.size} product${allowedVariationIds.size === 1 ? '' : 's'} inside the selected ${input.categoryIds.length} categor${input.categoryIds.length === 1 ? 'y' : 'ies'} (including everything nested underneath).`,
      )
    }

    // ---- Demand ladder ------------------------------------------------
    const demand = await this.resolveDemand({
      locationId: input.locationId,
      warehouseId: warehouse.id,
      windowRequested,
      allowedVariationIds,
    })
    const {
      source,
      windowUsed,
      demandByVariation,
      colourSplitByVariation,
      sourceMarkets,
      marketCount,
    } = demand
    const usedCrossMarket = source === 'CROSS_MARKET' || source === 'CROSS_MARKET_WIDENED'
    const windowWidened =
      windowUsed.start.getTime() !== windowRequested.start.getTime() ||
      windowUsed.end.getTime() !== windowRequested.end.getTime()


    if (demandByVariation.size === 0) {
      notes.push('There is no sales history and no warehouse stock for the selected products, so there is nothing to pack.')
      return emptyResult(input, windowRequested, notes, {
        demandSource: source,
        headline: 'No sales history and no warehouse stock, so there is nothing to suggest.',
        steps: ['Checked this market’s sales, every other market’s sales, and warehouse stock. All three came back empty.'],
        targetSummary: 'Nothing to allocate',
        windowRequested,
        windowUsed,
        windowWidened,
        sourceMarkets,
        settings: { shelfBufferPct, roundToNearest, minPackQty },
        budget: null,
        droppedBelowMinimum: 0,
      })
    }

    // ---- Warehouse cap + competing demand -----------------------------
    const variationIds = [...demandByVariation.keys()]
    const warehouseVariantsForFamilies = await this.prisma.warehouseVariant.findMany({
      where: { variation: { id: { in: variationIds } } },
      select: { id: true, variationId: true, colourVariantId: true, sizeOptionId: true },
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

    // ---- Cross-market fair share --------------------------------------
    // A product that sells everywhere shouldn't be drained by whichever
    // market happens to hit Generate first. Each market competes for a
    // slice of on-hand proportional to its own share of demand, computed
    // at both family and colour grain.
    //
    // Skipped when demand itself came from other markets: this market has
    // no local sales by definition, so its "fair share" would collapse to
    // zero and suppress the whole list.
    const otherMarketDemandByFamily = new Map<string, number>()
    const otherMarketDemandByColour = new Map<string, Map<string, number>>()
    if (!usedCrossMarket && source !== 'WAREHOUSE_STOCK' && variationIds.length > 0) {
      const otherMarketSales = await this.groupSalesByVariation(
        { locationIdNot: input.locationId, kind: 'MARKET', window: windowUsed, allowedVariationIds },
      )
      for (const [vId, sold] of otherMarketSales.entries()) {
        if (sold > 0) otherMarketDemandByFamily.set(vId, sold)
      }
      const otherMarketColourSales = await this.groupSalesByVariantColour(
        { locationIdNot: input.locationId, kind: 'MARKET', window: windowUsed, allowedVariationIds },
      )
      for (const [vId, colourMap] of otherMarketColourSales.entries()) {
        otherMarketDemandByColour.set(vId, colourMap)
      }
    }

    // Price lookup for CUSTOM_REVENUE, from our own catalog, with no
    // Square dependency. Family-level price = mean of the family's priced SKUs.
    const priceCentsByVariation = new Map<string, number>()
    if (input.targetMode === 'CUSTOM_REVENUE') {
      const wvPriced = await this.prisma.warehouseVariant.findMany({
        where: { variationId: { in: variationIds }, unitCostCents: { not: null } },
        select: { variationId: true, unitCostCents: true },
      })
      const bucket = new Map<string, { total: number; count: number }>()
      for (const wv of wvPriced) {
        if (wv.unitCostCents == null) continue
        const b = bucket.get(wv.variationId) ?? { total: 0, count: 0 }
        b.total += wv.unitCostCents
        b.count++
        bucket.set(wv.variationId, b)
      }
      for (const [vId, b] of bucket.entries()) {
        if (b.count > 0) priceCentsByVariation.set(vId, Math.round(b.total / b.count))
      }
    }

    const totalWarehouseCandidateStock = [...onHandByWarehouseVariant.values()].reduce((a, b) => a + b, 0)
    const initialShipmentPct = input.initialShipmentPct ?? 85
    const initialShipmentBudget = Math.floor(totalWarehouseCandidateStock * initialShipmentPct / 100)

    // ---- Target math --------------------------------------------------
    const totalObserved = [...demandByVariation.values()].reduce((a, b) => a + b, 0)
    let totalObservedRevenueCents = 0
    for (const [vId, observed] of demandByVariation.entries()) {
      totalObservedRevenueCents += observed * (priceCentsByVariation.get(vId) ?? 0)
    }
    const bufferMultiplier = 1 + shelfBufferPct / 100
    const targetByVariation = new Map<string, number>()
    // Never recommend more than SANITY_MULTIPLIER × the observed baseline
    // on a growth extrapolation. Guards against "+500%" on a product that
    // sold once.
    const SANITY_MULTIPLIER = 3
    for (const [vId, observed] of demandByVariation.entries()) {
      let target = 0
      switch (input.targetMode) {
        case 'MATCH_LAST_YEAR':
          target = observed
          break
        case 'GROW_PCT': {
          const raw = observed * (1 + (input.growthPct ?? 0) / 100)
          target = Math.min(raw, observed * SANITY_MULTIPLIER)
          break
        }
        case 'CUSTOM_UNITS': {
          const share = totalObserved > 0 ? observed / totalObserved : 0
          target = (input.targetUnits ?? 0) * share
          break
        }
        case 'CUSTOM_REVENUE': {
          // Distribute dollars in proportion to last season's revenue mix
          // (units × price), then convert this product's dollar slice back
          // to units at its own price.
          const price = priceCentsByVariation.get(vId) ?? 0
          if (price === 0 || totalObservedRevenueCents === 0) break
          const revenueShare = (observed * price) / totalObservedRevenueCents
          const targetRevenueCents = (input.targetRevenueDollars ?? 0) * 100
          target = (targetRevenueCents * revenueShare) / price
          break
        }
        case 'INITIAL_SHIPMENT': {
          const share = totalObserved > 0 ? observed / totalObserved : 0
          target = initialShipmentBudget * share
          break
        }
      }
      target *= bufferMultiplier
      if (target > 0) targetByVariation.set(vId, target)
    }

    if (input.targetMode === 'CUSTOM_REVENUE') {
      const withPriceCount = [...demandByVariation.keys()].filter((id) => priceCentsByVariation.has(id)).length
      const missing = demandByVariation.size - withPriceCount
      if (missing > 0) {
        notes.push(
          `${missing} product${missing === 1 ? '' : 's'} had no unit price in the catalog, so they could not be converted from dollars into units and were left out. Set a unit cost on those SKUs to include them.`,
        )
      }
      if (withPriceCount === 0) {
        notes.push(
          'No unit prices are set in the catalog, so a revenue target cannot be converted into units. Set unit costs on your warehouse SKUs first, or use Custom units instead.',
        )
      }
    }
    if (input.targetMode === 'INITIAL_SHIPMENT' && totalWarehouseCandidateStock === 0) {
      notes.push('There is no warehouse stock for the selected categories, so an initial shipment cannot be sized.')
    }

    // ---- Candidate lines (unrounded) ----------------------------------
    const candidates: Candidate[] = []
    for (const [variationId, familyTarget] of targetByVariation.entries()) {
      const wvList = warehouseVariantsByFamily.get(variationId) ?? []
      if (wvList.length === 0) continue // family with no live SKUs

      const colourMix = colourSplitByVariation.get(variationId) ?? new Map<string, number>()
      const mixTotal = [...colourMix.values()].reduce((a, b) => a + b, 0)

      const totalWarehouseOnHandForFamily = wvList.reduce(
        (sum, wv) => sum + (onHandByWarehouseVariant.get(wv.id) ?? 0),
        0,
      )
      const competing = competingByFamily.get(variationId) ?? 0

      const thisMarketDemand = demandByVariation.get(variationId) ?? 0
      const otherMarketDemand = otherMarketDemandByFamily.get(variationId) ?? 0
      const totalMarketDemand = thisMarketDemand + otherMarketDemand
      const fairShare = totalMarketDemand > 0 && otherMarketDemand > 0
        ? thisMarketDemand / totalMarketDemand
        : 1
      const fairAllocation = Math.floor(totalWarehouseOnHandForFamily * fairShare)
      const availableForThisLocation = Math.max(0, fairAllocation - competing)
      const scaleFactor = familyTarget === 0 ? 0 : Math.min(1, availableForThisLocation / familyTarget)

      // Split the family target across colours. When we have a real colour
      // signal (per-SKU sales, or per-SKU stock in the warehouse-only case)
      // use it; otherwise split evenly and say so.
      const perColourRaw = new Map<string, number>()
      const perColourUncapped = new Map<string, number>()
      if (mixTotal > 0) {
        for (const wv of wvList) {
          const mixQty = colourMix.get(wv.id) ?? 0
          perColourUncapped.set(wv.id, familyTarget * (mixQty / mixTotal))
          perColourRaw.set(wv.id, familyTarget * scaleFactor * (mixQty / mixTotal))
        }
      } else {
        for (const wv of wvList) {
          perColourUncapped.set(wv.id, familyTarget / wvList.length)
          perColourRaw.set(wv.id, (familyTarget * scaleFactor) / wvList.length)
        }
      }

      for (const wv of wvList) {
        const raw = perColourRaw.get(wv.id) ?? 0
        const uncapped = perColourUncapped.get(wv.id) ?? 0
        if (uncapped <= 0) continue
        const onHand = onHandByWarehouseVariant.get(wv.id) ?? 0
        const lastYearSoldForColour = Math.round(colourMix.get(wv.id) ?? 0)

        // Per-colour fair share: even when the family total has headroom,
        // one market must not claim 100% of a single popular colour. Use
        // the real per-colour ratio where we have colour-level sales from
        // other markets, so a colour only this market sells isn't
        // throttled by a family average dragged down by its siblings.
        let colourFairShare = fairShare
        if (mixTotal > 0 && fairShare < 1) {
          const otherColourSold = otherMarketDemandByColour.get(variationId)?.get(wv.id) ?? 0
          const colourTotalDemand = lastYearSoldForColour + otherColourSold
          if (colourTotalDemand > 0) colourFairShare = lastYearSoldForColour / colourTotalDemand
        }
        const colourCap = colourFairShare < 1
          ? Math.min(onHand, Math.floor(onHand * colourFairShare))
          : onHand

        candidates.push({
          variationId,
          warehouseVariantId: wv.id,
          natural: raw,
          uncapped,
          cap: colourCap,
          onHand,
          competing,
          fairShare,
          fairAllocation,
          colourFairShare,
          totalWarehouseOnHandForFamily,
          familyObserved: thisMarketDemand,
          lastYearSoldForColour,
          colourSharePct: mixTotal > 0 ? Math.round((lastYearSoldForColour / mixTotal) * 100) : null,
          hasColourMix: mixTotal > 0,
          priceCents: priceCentsByVariation.get(variationId) ?? null,
        })
      }
    }

    // ---- Pack shaping: minimum, budget fill, rounding ------------------
    // A budget mode has to actually hit its budget. The first version scaled
    // the survivors up by one flat factor and then re-capped them, which lost
    // the shortfall twice over: once because the factor was measured in units
    // even when the budget was in dollars, and again because every line that
    // hit its stock cap silently dropped its share with no second pass. A
    // $25,000 goal came out at $18,481. This does a proper water fill
    // instead, so capped lines stay put and the remainder keeps flowing to
    // the lines that still have room.
    const unitValueCents = (c: Candidate): number =>
      input.targetMode === 'CUSTOM_REVENUE' ? (c.priceCents ?? 0) : 1

    // The budget, in whatever unit the fill measures, with the shelf buffer
    // already applied. This is the value we are trying to reach.
    const budgetValue = !isBudgetMode
      ? 0
      : input.targetMode === 'CUSTOM_REVENUE'
        ? (input.targetRevenueDollars ?? 0) * 100 * bufferMultiplier
        : input.targetMode === 'CUSTOM_UNITS'
          ? (input.targetUnits ?? 0) * bufferMultiplier
          : initialShipmentBudget * bufferMultiplier

    // Anything the warehouse cannot fill to a whole minimum pack is out
    // before we start. A picking sheet line for 1 or 2 units is not a pack.
    const consideredCount = candidates.filter((c) => c.uncapped > 0).length
    let survivors = candidates.filter((c) => c.uncapped > 0 && c.cap >= minPackQty)

    let allocation = new Map<string, number>()
    if (isBudgetMode) {
      // Fill, drop whatever still lands under the minimum, then fill again so
      // the dropped tail's budget genuinely reaches the lines that remain.
      for (let round = 0; round < 3; round++) {
        allocation = fillToBudget(survivors, budgetValue, unitValueCents)
        const kept = survivors.filter((c) => (allocation.get(c.warehouseVariantId) ?? 0) >= minPackQty)
        if (kept.length === 0 || kept.length === survivors.length) break
        survivors = kept
      }
    } else {
      for (const c of survivors) {
        allocation.set(c.warehouseVariantId, Math.min(c.natural, c.cap))
      }
    }

    // Round to pack sizes, then close the gap rounding just opened.
    const qtyByVariant = new Map<string, number>()
    for (const c of survivors) {
      const qty = roundPack(allocation.get(c.warehouseVariantId) ?? 0, c.cap, roundToNearest, minPackQty)
      if (qty > 0) qtyByVariant.set(c.warehouseVariantId, qty)
    }
    const finalSurvivors = survivors.filter((c) => qtyByVariant.has(c.warehouseVariantId))
    if (isBudgetMode && budgetValue > 0 && finalSurvivors.length > 0) {
      balanceToBudget({
        list: finalSurvivors,
        qtyByVariant,
        budgetValue,
        unitValue: unitValueCents,
        step: roundToNearest,
        minQty: minPackQty,
      })
    }

    const lines: SuggestionLine[] = []
    for (const c of finalSurvivors) {
      const qty = qtyByVariant.get(c.warehouseVariantId) ?? 0
      if (qty <= 0) continue
      const beforeRounding = allocation.get(c.warehouseVariantId) ?? 0

      const bindingConstraint = decideConstraint({
        candidate: c,
        beforeRounding,
        finalQty: qty,
        isBudgetMode,
        minPackQty,
      })
      const { level, reason } = decideConfidence({
        source,
        observed: c.familyObserved,
        hasColourMix: c.hasColourMix,
        sourceMarketCount: sourceMarkets.length,
        targetMode: input.targetMode,
        growthPct: input.growthPct,
        marketName: location.name,
      })

      lines.push({
        variationId: c.variationId,
        warehouseVariantId: c.warehouseVariantId,
        qtyRecommended: qty,
        lastYearSold: c.lastYearSoldForColour || Math.round(c.familyObserved),
        familyLastYearSold: Math.round(c.familyObserved),
        warehouseOnHand: c.onHand,
        otherLocationDemand: c.competing,
        demandTarget: Math.round(c.uncapped),
        bindingConstraint,
        steps: buildSteps({
          candidate: c,
          source,
          marketName: location.name,
          marketCount,
          sourceMarketCount: sourceMarkets.length,
          targetMode: input.targetMode,
          growthPct: input.growthPct,
          shelfBufferPct,
          beforeRounding,
          finalQty: qty,
          roundToNearest,
          minPackQty,
          targetRevenueDollars: input.targetRevenueDollars,
        }),
        rationale: buildRationale({
          candidate: c,
          source,
          marketName: location.name,
          finalQty: qty,
          bindingConstraint,
        }),
        confidence: level,
        confidenceReason: reason,
      })
    }

    // Highest-demand products lead, then recommended qty, then the
    // bestselling colour inside a family. variationId is the final
    // tiebreaker so identical inputs always produce identical ordering.
    lines.sort((a, b) => {
      if (b.familyLastYearSold !== a.familyLastYearSold) return b.familyLastYearSold - a.familyLastYearSold
      if (b.qtyRecommended !== a.qtyRecommended) return b.qtyRecommended - a.qtyRecommended
      if (b.lastYearSold !== a.lastYearSold) return b.lastYearSold - a.lastYearSold
      return a.variationId.localeCompare(b.variationId)
    })

    const totalRecommended = lines.reduce((sum, l) => sum + l.qtyRecommended, 0)
    const droppedBelowMinimum = Math.max(0, consideredCount - lines.length)


    // What the run actually managed to allocate, in the budget's own
    // currency, so the panel can state the goal, the amount we set out to
    // ship, and the amount we reached as three separate numbers. Reporting
    // only the first and last is what made the shelf buffer confusing.
    let allocatedValue = 0
    for (const l of lines) {
      allocatedValue += l.qtyRecommended *
        (input.targetMode === 'CUSTOM_REVENUE' ? (priceCentsByVariation.get(l.variationId) ?? 0) : 1)
    }
    const bufferSuffix = shelfBufferPct > 0 ? ` (goal + ${shelfBufferPct}% shelf buffer)` : ''
    const shortfallReason = (short: string) =>
      `${short} short. Every remaining item is already at the most the warehouse can spare for this market, so the only way to close the gap is more stock.`

    let budget: SuggestionExplain['budget'] = null
    if (input.targetMode === 'CUSTOM_REVENUE' && input.targetRevenueDollars) {
      const sendCents = input.targetRevenueDollars * 100 * bufferMultiplier
      const gapCents = sendCents - allocatedValue
      budget = {
        label: 'Revenue target',
        targetDisplay: `$${input.targetRevenueDollars.toLocaleString('en-US')} sales goal`,
        sendTargetDisplay: `$${Math.round(sendCents / 100).toLocaleString('en-US')} of stock to send${bufferSuffix}`,
        allocatedDisplay: `$${Math.round(allocatedValue / 100).toLocaleString('en-US')} (${totalRecommended.toLocaleString('en-US')} units)`,
        shortfall: gapCents > sendCents * 0.01
          ? shortfallReason(`$${Math.round(gapCents / 100).toLocaleString('en-US')}`)
          : null,
      }
      notes.push(
        'This is the stock the market needs on hand to sell that much, not a promise that it will.',
      )
    }
    if (input.targetMode === 'CUSTOM_UNITS' && input.targetUnits) {
      const sendUnits = Math.round(input.targetUnits * bufferMultiplier)
      const gap = sendUnits - totalRecommended
      budget = {
        label: 'Unit target',
        targetDisplay: `${input.targetUnits.toLocaleString('en-US')} units`,
        sendTargetDisplay: `${sendUnits.toLocaleString('en-US')} units to send${bufferSuffix}`,
        allocatedDisplay: `${totalRecommended.toLocaleString('en-US')} units`,
        shortfall: gap > Math.max(roundToNearest, sendUnits * 0.01)
          ? shortfallReason(`${gap.toLocaleString('en-US')} units`)
          : null,
      }
    }
    if (input.targetMode === 'INITIAL_SHIPMENT') {
      const sendUnits = Math.round(initialShipmentBudget * bufferMultiplier)
      const gap = sendUnits - totalRecommended
      budget = {
        label: 'Initial shipment',
        targetDisplay: `${initialShipmentPct}% of ${totalWarehouseCandidateStock.toLocaleString('en-US')} units in stock`,
        sendTargetDisplay: `${sendUnits.toLocaleString('en-US')} units to send${bufferSuffix}`,
        allocatedDisplay: `${totalRecommended.toLocaleString('en-US')} units`,
        shortfall: gap > Math.max(roundToNearest, sendUnits * 0.01)
          ? shortfallReason(`${gap.toLocaleString('en-US')} units`)
          : null,
      }
    }

    const explain: SuggestionExplain = {
      demandSource: source,
      headline: buildHeadline({
        source,
        marketName: location.name,
        sourceMarketCount: sourceMarkets.length,
        windowUsed,
        totalRecommended,
        styleCount: new Set(lines.map((l) => l.variationId)).size,
      }),
      steps: buildRunSteps({
        source,
        marketName: location.name,
        marketCount,
        sourceMarkets,
        windowRequested,
        windowUsed,
        windowWidened,
        targetMode: input.targetMode,
        growthPct: input.growthPct,
        targetRevenueDollars: input.targetRevenueDollars,
        shelfBufferPct,
        roundToNearest,
        minPackQty,
        isBudgetMode,
        droppedBelowMinimum,
        totalRecommended,
      }),
      targetSummary: buildTargetSummary({
        targetMode: input.targetMode,
        growthPct: input.growthPct,
        targetUnits: input.targetUnits,
        targetRevenueDollars: input.targetRevenueDollars,
        initialShipmentPct,
      }),
      windowRequested,
      windowUsed,
      windowWidened,
      sourceMarkets,
      settings: { shelfBufferPct, roundToNearest, minPackQty },
      budget,
      droppedBelowMinimum,
    }

    return {
      locationId: input.locationId,
      targetMode: input.targetMode,
      window: windowUsed,
      lines,
      totals: {
        variationsCovered: new Set(lines.map((l) => l.variationId)).size,
        totalRecommendedUnits: totalRecommended,
        totalLastYearUnits: Math.round(totalObserved),
      },
      notes,
      explain,
    }
  }

  /// Walks down the demand ladder and returns the first rung that produces
  /// anything, along with everything the caller needs to explain it.
  private async resolveDemand(args: {
    locationId: string
    warehouseId: string
    windowRequested: { start: Date; end: Date }
    allowedVariationIds?: Set<string>
  }): Promise<{
    source: SuggestionDemandSource
    windowUsed: { start: Date; end: Date }
    demandByVariation: Map<string, number>
    colourSplitByVariation: Map<string, Map<string, number>>
    sourceMarkets: SuggestionSourceMarket[]
    marketCount: number
  }> {
    const { locationId, windowRequested, allowedVariationIds } = args
    const marketCount = await this.countOtherMarkets(locationId)

    const localIn = async (window: { start: Date; end: Date }) => {
      const family = await this.groupSalesByVariation({ locationId, window, allowedVariationIds })
      const positive = new Map<string, number>()
      for (const [vId, sold] of family.entries()) if (sold > 0) positive.set(vId, sold)
      return positive
    }

    // Rung 1: this market's own sales, in the window asked for.
    const local = await localIn(windowRequested)
    if (local.size > 0) {
      return {
        source: 'LOCAL_SALES',
        windowUsed: windowRequested,
        demandByVariation: local,
        colourSplitByVariation: await this.groupSalesByVariantColour({ locationId, window: windowRequested, allowedVariationIds }),
        sourceMarkets: [],
        marketCount,
      }
    }

    // The window the operator picked had nothing in it. Rather than
    // reporting "no sales data found" and stopping, widen to every sale we
    // hold and try the whole ladder again against that.
    const fullWindow = await this.fullHistoryWindow(windowRequested)

    // Rung 2: this market's own sales, over all history.
    if (fullWindow) {
      const localWide = await localIn(fullWindow)
      if (localWide.size > 0) {
        return {
          source: 'LOCAL_SALES_WIDENED',
          windowUsed: fullWindow,
          demandByVariation: localWide,
          colourSplitByVariation: await this.groupSalesByVariantColour({ locationId, window: fullWindow, allowedVariationIds }),
          sourceMarkets: [],
          marketCount,
        }
      }
    }

    // Rungs 3 and 4: other markets' sales, first in the chosen window,
    // then over all history. Divided by the market count so a brand-new
    // market gets a cautious opening list rather than the sum of everyone.
    const crossAttempts: Array<{ window: { start: Date; end: Date }; source: SuggestionDemandSource }> = [
      { window: windowRequested, source: 'CROSS_MARKET' },
      ...(fullWindow ? [{ window: fullWindow, source: 'CROSS_MARKET_WIDENED' as const }] : []),
    ]
    for (const attempt of crossAttempts) {
      const crossSales = await this.groupSalesByVariation({
        locationIdNot: locationId, kind: 'MARKET', window: attempt.window, allowedVariationIds,
      })
      const demandByVariation = new Map<string, number>()
      for (const [vId, sold] of crossSales.entries()) {
        if (sold <= 0) continue
        demandByVariation.set(vId, Math.max(1, sold / Math.max(1, marketCount)))
      }
      if (demandByVariation.size === 0) continue

      const colourRaw = await this.groupSalesByVariantColour({
        locationIdNot: locationId, kind: 'MARKET', window: attempt.window, allowedVariationIds,
      })
      // Scale the colour mix by the same per-market divisor so the family
      // total and the colour split describe the same list.
      const colourSplitByVariation = new Map<string, Map<string, number>>()
      for (const [vId, mix] of colourRaw.entries()) {
        const scaled = new Map<string, number>()
        for (const [wvId, qty] of mix.entries()) scaled.set(wvId, qty / Math.max(1, marketCount))
        colourSplitByVariation.set(vId, scaled)
      }

      return {
        source: attempt.source,
        windowUsed: attempt.window,
        demandByVariation,
        colourSplitByVariation,
        sourceMarkets: await this.sourceMarketsFor(locationId, attempt.window, allowedVariationIds),
        marketCount,
      }
    }

    // Rung 5: nothing has ever sold in scope. Size the list from physical
    // warehouse stock so the operator still gets somewhere to start.
    const stock = await this.warehouseStockAsDemand(args.warehouseId, marketCount, allowedVariationIds)
    return {
      source: 'WAREHOUSE_STOCK',
      windowUsed: fullWindow ?? windowRequested,
      demandByVariation: stock.byVariation,
      colourSplitByVariation: stock.byColour,
      sourceMarkets: [],
      marketCount,
    }
  }

  /// The full span of SALE history we hold, or null when there are no sales
  /// at all (or the span matches what was already asked for). Used as the
  /// widened window when the operator's date range turns up empty.
  private async fullHistoryWindow(
    requested: { start: Date; end: Date },
  ): Promise<{ start: Date; end: Date } | null> {
    const bounds = await this.prisma.ledgerEvent.aggregate({
      where: { type: 'SALE' },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    })
    const min = bounds._min.occurredAt
    const max = bounds._max.occurredAt
    if (!min || !max) return null
    const start = min < requested.start ? min : requested.start
    const end = max > requested.end ? max : requested.end
    if (start.getTime() === requested.start.getTime() && end.getTime() === requested.end.getTime()) return null
    return { start, end }
  }

  /// Named markets (and their units) behind a cross-market inference.
  private async sourceMarketsFor(
    excludeLocationId: string,
    window: { start: Date; end: Date },
    allowedVariationIds?: Set<string>,
  ): Promise<SuggestionSourceMarket[]> {
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['locationId'],
      _sum: { quantity: true },
      where: {
        type: 'SALE',
        occurredAt: { gte: window.start, lte: window.end },
        locationId: { not: excludeLocationId },
        location: { kind: 'MARKET', isActive: true },
        ...(allowedVariationIds ? { variationId: { in: [...allowedVariationIds] } } : {}),
      },
    })
    const withUnits = rows
      .map((r) => ({ locationId: r.locationId, unitsSold: Math.max(0, -(r._sum.quantity ?? 0)) }))
      .filter((r) => r.unitsSold > 0)
    if (withUnits.length === 0) return []
    const names = await this.prisma.location.findMany({
      where: { id: { in: withUnits.map((r) => r.locationId) } },
      select: { id: true, name: true },
    })
    const nameById = new Map(names.map((n) => [n.id, n.name]))
    return withUnits
      .map((r) => ({ locationId: r.locationId, name: nameById.get(r.locationId) ?? 'Unknown market', unitsSold: r.unitsSold }))
      .sort((a, b) => b.unitsSold - a.unitsSold)
  }

  /// Last-resort demand signal: what is physically in the warehouse, used
  /// as a proportional weight so a zero-history catalog still produces a
  /// sensible starting shape instead of an empty screen.
  private async warehouseStockAsDemand(
    warehouseId: string,
    otherMarketCount: number,
    allowedVariationIds?: Set<string>,
  ): Promise<{ byVariation: Map<string, number>; byColour: Map<string, Map<string, number>> }> {
    // Stock is divided evenly between this market and every other active
    // one. With no sales signal at all there is nothing to say this market
    // deserves more than an equal share. Without the divisor a
    // "match last season" run against a zero-history catalog would try to
    // ship the entire warehouse to whoever generated a list first.
    const share = Math.max(1, otherMarketCount + 1)
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['variationId', 'warehouseVariantId'],
      _sum: { quantity: true },
      where: {
        locationId: warehouseId,
        warehouseVariantId: { not: null },
        ...(allowedVariationIds ? { variationId: { in: [...allowedVariationIds] } } : {}),
      },
    })
    const byVariation = new Map<string, number>()
    const byColour = new Map<string, Map<string, number>>()
    for (const row of rows) {
      if (!row.warehouseVariantId) continue
      const qty = Math.max(0, row._sum.quantity ?? 0)
      if (qty === 0) continue
      byVariation.set(row.variationId, (byVariation.get(row.variationId) ?? 0) + qty / share)
      const bucket = byColour.get(row.variationId) ?? new Map<string, number>()
      bucket.set(row.warehouseVariantId, qty / share)
      byColour.set(row.variationId, bucket)
    }
    return { byVariation, byColour }
  }

  /// Expands the operator's chosen categoryIds into the set of every
  /// descendant category, then collects the variationIds whose ItemGroup
  /// belongs to one of those categories. Returns undefined when no filter
  /// was requested (caller treats undefined as "no filter, all variations").
  /// Returns an empty set when the filter matched no variations.
  private async resolveCategoryFilter(
    categoryIds: string[] | undefined,
  ): Promise<Set<string> | undefined> {
    if (!categoryIds || categoryIds.length === 0) return undefined

    const all = await this.prisma.category.findMany({ select: { id: true, parentId: true } })
    const childrenByParent = new Map<string, string[]>()
    for (const c of all) {
      if (!c.parentId) continue
      const bucket = childrenByParent.get(c.parentId) ?? []
      bucket.push(c.id)
      childrenByParent.set(c.parentId, bucket)
    }
    // BFS from each requested root, collecting every descendant.
    const expanded = new Set<string>()
    const queue = [...categoryIds]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (expanded.has(id)) continue
      expanded.add(id)
      for (const child of childrenByParent.get(id) ?? []) queue.push(child)
    }

    const variations = await this.prisma.variation.findMany({
      where: { itemGroup: { categoryId: { in: [...expanded] } } },
      select: { id: true },
    })
    return new Set(variations.map((v) => v.id))
  }

  /// SALE aggregation. `locationId` targets one market; `locationIdNot`
  /// aggregates every other MARKET (used for cross-market inference).
  /// `allowedVariationIds`, when set, restricts to that variation set.
  private async groupSalesByVariation(args: {
    locationId?: string
    locationIdNot?: string
    kind?: 'MARKET'
    window: { start: Date; end: Date }
    allowedVariationIds?: Set<string>
  }): Promise<Map<string, number>> {
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['variationId'],
      _sum: { quantity: true },
      where: {
        type: 'SALE',
        occurredAt: { gte: args.window.start, lte: args.window.end },
        ...(args.locationId ? { locationId: args.locationId } : {}),
        ...(args.locationIdNot ? { locationId: { not: args.locationIdNot } } : {}),
        ...(args.allowedVariationIds
          ? { variationId: { in: [...args.allowedVariationIds] } }
          : {}),
        ...(args.kind
          // isActive: true, because a closed market's historical sales
          // must not keep depressing every remaining market's fair share
          // forever. Matches the isActive filter in countOtherMarkets so
          // the fair-share numerator and denominator stay consistent.
          ? { location: { kind: args.kind, isActive: true } }
          : {}),
      },
    })
    return new Map(rows.map((r) => [r.variationId, Math.max(0, -(r._sum.quantity ?? 0))]))
  }

  /// SALE aggregation at colour grain. Only picks up rows where the SALE
  /// event carries a `warehouseVariantId` (i.e. Square catalog mapping is
  /// per-SKU, not just family level). This is the correct colour signal:
  /// what customers actually bought, in each colour.
  private async groupSalesByVariantColour(args: {
    locationId?: string
    locationIdNot?: string
    kind?: 'MARKET'
    window: { start: Date; end: Date }
    allowedVariationIds?: Set<string>
  }): Promise<Map<string, Map<string, number>>> {
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['variationId', 'warehouseVariantId'],
      _sum: { quantity: true },
      where: {
        type: 'SALE',
        warehouseVariantId: { not: null },
        occurredAt: { gte: args.window.start, lte: args.window.end },
        ...(args.locationId ? { locationId: args.locationId } : {}),
        ...(args.locationIdNot ? { locationId: { not: args.locationIdNot } } : {}),
        ...(args.allowedVariationIds
          ? { variationId: { in: [...args.allowedVariationIds] } }
          : {}),
        ...(args.kind ? { location: { kind: args.kind, isActive: true } } : {}),
      },
    })
    const out = new Map<string, Map<string, number>>()
    for (const row of rows) {
      if (!row.warehouseVariantId) continue
      // SALEs are negative; flip to positive units-sold.
      const qty = Math.max(0, -(row._sum.quantity ?? 0))
      if (qty === 0) continue
      const bucket = out.get(row.variationId) ?? new Map<string, number>()
      bucket.set(row.warehouseVariantId, qty)
      out.set(row.variationId, bucket)
    }
    return out
  }

  private async countOtherMarkets(excludeLocationId: string): Promise<number> {
    return this.prisma.location.count({
      where: { kind: 'MARKET', isActive: true, id: { not: excludeLocationId } },
    })
  }
}

/// One (product, colour) pair mid-calculation, before pack shaping. Carries
/// everything the explanation builders need so the arithmetic can be
/// replayed for the operator without re-querying anything.
export interface Candidate {
  variationId: string
  warehouseVariantId: string
  /// Target for this colour after the family-level fair-share scale.
  natural: number
  /// Target for this colour before any warehouse or fair-share cap: the
  /// honest "what this market wants" number.
  uncapped: number
  /// Hard ceiling for this colour: its on-hand, narrowed by its fair share.
  cap: number
  onHand: number
  competing: number
  fairShare: number
  fairAllocation: number
  colourFairShare: number
  totalWarehouseOnHandForFamily: number
  familyObserved: number
  lastYearSoldForColour: number
  colourSharePct: number | null
  hasColourMix: boolean
  priceCents: number | null
}

/// Rounds a quantity into a real pack size: a multiple of `step`, never
/// below `minQty`, never above what the warehouse can supply. Returns 0 when
/// the cap cannot support a whole minimum pack, so the caller drops the line
/// rather than shipping a token unit or two.
/// Water fill. Scales every line's target by a common factor, re-caps, and
/// repeats. Lines pinned at their stock cap stay pinned while the rest keep
/// absorbing what is left of the budget, so the money freed by a capped or
/// dropped line actually lands somewhere instead of evaporating.
///
/// `unitValue` is what one unit of a line is worth in the budget's own
/// currency: cents for a revenue target, 1 for a unit target. Measuring the
/// fill in units when the budget is in dollars is precisely what made a
/// $25,000 goal come out at $18,481.
export function fillToBudget(
  list: Candidate[],
  budgetValue: number,
  unitValue: (c: Candidate) => number,
): Map<string, number> {
  const out = new Map<string, number>()
  let scale = 1
  for (let i = 0; i < 30; i++) {
    let spent = 0
    let hasHeadroom = false
    for (const c of list) {
      const qty = Math.min(c.natural * scale, c.cap)
      out.set(c.warehouseVariantId, qty)
      spent += qty * unitValue(c)
      if (qty < c.cap - 1e-9) hasHeadroom = true
    }
    // Done when the budget is met, when every line is pinned at its cap
    // (genuinely stock-limited), or when there is nothing to scale.
    if (budgetValue <= 0 || spent <= 0 || !hasHeadroom) break
    if (spent >= budgetValue * 0.999) break
    scale *= budgetValue / spent
  }
  return out
}

/// Closes the gap that pack rounding opens. Rounding each line to a multiple
/// of the step can leave the run either side of the budget; this adds or
/// removes whole packs until it sits on the target, and never trims below it.
/// Top-ups go to the highest-demand lines with room left, so closing the gap
/// does not distort the mix towards whatever happens to be deepest in stock.
export function balanceToBudget(args: {
  list: Candidate[]
  qtyByVariant: Map<string, number>
  budgetValue: number
  unitValue: (c: Candidate) => number
  step: number
  minQty: number
}): void {
  const { list, qtyByVariant, budgetValue, unitValue, step, minQty } = args
  let value = list.reduce((sum, c) => sum + (qtyByVariant.get(c.warehouseVariantId) ?? 0) * unitValue(c), 0)

  const byDemand = [...list].sort((a, b) => b.natural - a.natural)
  let guard = 0
  while (value < budgetValue && guard++ < 500) {
    let progressed = false
    for (const c of byDemand) {
      const qty = qtyByVariant.get(c.warehouseVariantId) ?? 0
      const maxQty = Math.floor(c.cap / step) * step
      if (qty + step > maxQty) continue
      qtyByVariant.set(c.warehouseVariantId, qty + step)
      value += step * unitValue(c)
      progressed = true
      if (value >= budgetValue) break
    }
    if (!progressed) break // every line is at its cap: stock is the limit
  }

  const byQty = [...list].sort(
    (a, b) => (qtyByVariant.get(b.warehouseVariantId) ?? 0) - (qtyByVariant.get(a.warehouseVariantId) ?? 0),
  )
  guard = 0
  while (guard++ < 500) {
    let progressed = false
    for (const c of byQty) {
      const qty = qtyByVariant.get(c.warehouseVariantId) ?? 0
      const packValue = step * unitValue(c)
      if (packValue <= 0) continue
      if (value - packValue < budgetValue) continue // would drop under target
      if (qty - step < minQty) continue
      qtyByVariant.set(c.warehouseVariantId, qty - step)
      value -= packValue
      progressed = true
    }
    if (!progressed) break
  }
}

export function roundPack(qty: number, cap: number, step: number, minQty: number): number {
  if (qty <= 0 || cap <= 0) return 0
  let rounded = Math.round(qty / step) * step
  // Demand that doesn't even round up to a single pack is dropped, never
  // bumped. Bumping here would be actively wrong: a style that sold 3 units
  // split across 10 colours would become 10 × the minimum, shipping fifty
  // units of something that sells three.
  if (rounded <= 0) return 0
  if (rounded < minQty) rounded = minQty
  if (rounded > cap) rounded = Math.floor(cap / step) * step
  if (rounded < minQty) return cap >= minQty ? minQty : 0
  return rounded
}

function decideConstraint(args: {
  candidate: Candidate
  beforeRounding: number
  finalQty: number
  isBudgetMode: boolean
  minPackQty: number
}): SuggestionConstraint {
  const c = args.candidate
  const wasCapped = c.natural > c.cap + 0.001 || c.uncapped > c.cap + 0.001
  if (wasCapped) {
    // Which ceiling actually bit: physical stock, other markets' open
    // requests, or the fair-share split.
    if (c.cap >= c.onHand) return 'WAREHOUSE_STOCK'
    if (c.competing > 0 && c.fairAllocation - c.competing < c.uncapped) return 'OTHER_REQUESTS'
    return 'FAIR_SHARE'
  }
  if (args.finalQty === args.minPackQty && args.beforeRounding < args.minPackQty) return 'MIN_PACK'
  if (Math.abs(args.finalQty - args.beforeRounding) > 0.001 && args.isBudgetMode) return 'PACK_ROUNDING'
  return args.isBudgetMode ? 'BUDGET' : 'DEMAND'
}

function decideConfidence(args: {
  source: SuggestionDemandSource
  observed: number
  hasColourMix: boolean
  sourceMarketCount: number
  targetMode: GenerateSuggestionInput['targetMode']
  growthPct?: number
  marketName: string
}): { level: SuggestionConfidence; reason: string } {
  if (args.source === 'WAREHOUSE_STOCK') {
    return {
      level: 'LOW',
      reason: 'No sales history exists for this product anywhere, so the number comes from warehouse stock alone.',
    }
  }
  if (args.source === 'CROSS_MARKET' || args.source === 'CROSS_MARKET_WIDENED') {
    // A guess built on many markets and real volume is a better guess than
    // one built on a single market's handful of sales, so grade it
    // instead of stamping every new-market line LOW.
    if (args.sourceMarketCount >= 3 && args.observed >= 20) {
      return {
        level: 'MEDIUM',
        reason: `Estimated from ${args.sourceMarketCount} other markets with solid volume. A reasonable opening guess for ${args.marketName}, but not measured here.`,
      }
    }
    return {
      level: 'LOW',
      reason: `Estimated from ${args.sourceMarketCount} other market${args.sourceMarketCount === 1 ? '' : 's'} with thin volume. ${args.marketName} has no sales of its own yet, so treat this as a starting point.`,
    }
  }
  if (args.source === 'LOCAL_SALES_WIDENED') {
    return {
      level: 'MEDIUM',
      reason: 'Based on this market’s real sales, but they fall outside the date range you picked, so the window was widened to find them.',
    }
  }
  if (args.observed < 5) {
    return {
      level: 'MEDIUM',
      reason: `Only ${Math.round(args.observed)} unit${Math.round(args.observed) === 1 ? '' : 's'} of this style sold here in the window. Real data, but too thin to lean on hard.`,
    }
  }
  if (args.targetMode === 'GROW_PCT' && Math.abs(args.growthPct ?? 0) > 50) {
    return {
      level: 'MEDIUM',
      reason: `Based on solid local sales, but a ${args.growthPct}% change pushes the number well past what the history alone supports.`,
    }
  }
  if (!args.hasColourMix) {
    return {
      level: 'MEDIUM',
      reason: 'This style’s sales are recorded at product level only, so the split across colours is an even guess. Map the SKUs in Square for colour-level accuracy.',
    }
  }
  return {
    level: 'HIGH',
    reason: 'Based on this market’s own sales of this exact colour, in the window you chose.',
  }
}

/// The per-line arithmetic, in the order it was applied. Every number the
/// operator sees on screen should be traceable to one of these lines.
function buildSteps(args: {
  candidate: Candidate
  source: SuggestionDemandSource
  marketName: string
  marketCount: number
  sourceMarketCount: number
  targetMode: GenerateSuggestionInput['targetMode']
  growthPct?: number
  shelfBufferPct: number
  beforeRounding: number
  finalQty: number
  roundToNearest: number
  minPackQty: number
  targetRevenueDollars?: number
}): SuggestionStep[] {
  const c = args.candidate
  const steps: SuggestionStep[] = []

  // 1. Where the demand number came from.
  if (args.source === 'WAREHOUSE_STOCK') {
    steps.push({
      label: 'Starting point',
      detail: `No sales history anywhere, so we started from the ${c.onHand} units of this colour in the warehouse, split evenly across ${args.marketCount + 1} markets at about ${Math.round(c.lastYearSoldForColour)} each.`,
    })
  } else if (args.source === 'CROSS_MARKET' || args.source === 'CROSS_MARKET_WIDENED') {
    steps.push({
      label: 'Starting point',
      detail: `${args.marketName} has no sales of its own. Across ${args.sourceMarketCount} other market${args.sourceMarketCount === 1 ? '' : 's'} this colour sold about ${Math.round(c.lastYearSoldForColour * Math.max(1, args.marketCount))} units, which divided by ${args.marketCount} market${args.marketCount === 1 ? '' : 's'} gives roughly ${Math.round(c.lastYearSoldForColour)} as a per-market average.`,
    })
  } else if (c.hasColourMix) {
    steps.push({
      label: 'Starting point',
      detail: `Sold ${c.lastYearSoldForColour} of this colour at ${args.marketName} in the window${c.colourSharePct != null ? `, ${c.colourSharePct}% of this style's sales here` : ''}.`,
    })
  } else {
    steps.push({
      label: 'Starting point',
      detail: `This style sold ${Math.round(c.familyObserved)} units at ${args.marketName}, but Square records it at product level, so the total was split evenly across its colours.`,
    })
  }

  // 2. What the chosen target did to it.
  switch (args.targetMode) {
    case 'MATCH_LAST_YEAR':
      steps.push({ label: 'Target', detail: 'Match last season, so the target is that same figure.' })
      break
    case 'GROW_PCT':
      steps.push({
        label: 'Target',
        detail: `${(args.growthPct ?? 0) >= 0 ? 'Grown' : 'Shrunk'} by ${Math.abs(args.growthPct ?? 0)}%, capped at 3× last season so an aggressive percentage can't run away.`,
      })
      break
    case 'CUSTOM_UNITS':
      steps.push({ label: 'Target', detail: 'Your total unit budget, split across products in proportion to what sells.' })
      break
    case 'CUSTOM_REVENUE':
      steps.push({
        label: 'Target',
        detail: `Your $${(args.targetRevenueDollars ?? 0).toLocaleString('en-US')} target was split by each product's share of revenue, and this product's slice converted back into units at ${c.priceCents != null ? `$${(c.priceCents / 100).toFixed(2)}` : 'its'} each.`,
      })
      break
    case 'INITIAL_SHIPMENT':
      steps.push({ label: 'Target', detail: 'A share of current warehouse stock, split across products in proportion to what sells.' })
      break
  }

  if (args.shelfBufferPct > 0) {
    steps.push({
      label: 'Shelf buffer',
      detail: `+${args.shelfBufferPct}% on top, so the booth still has stock on the shelf once the target's worth has sold.`,
    })
  }

  steps.push({
    label: 'Market needs',
    detail: `${Math.round(c.uncapped)} units before any warehouse limits.`,
  })

  // 3. What limited it.
  if (c.competing > 0) {
    steps.push({
      label: 'Other markets',
      detail: `${c.competing} units of this style are already on other markets' open or draft requests, so they were taken off the table first.`,
    })
  }
  if (c.fairShare < 1) {
    steps.push({
      label: 'Fair share',
      detail: `${args.marketName} accounts for ${Math.round(c.fairShare * 100)}% of demand for this style across all markets, so it can draw ${c.fairAllocation} of the ${c.totalWarehouseOnHandForFamily} units in stock. The rest stays for the others.`,
    })
  }
  if (c.colourFairShare < 1 && c.cap < c.onHand) {
    steps.push({
      label: 'Colour cap',
      detail: `Held to ${Math.round(c.colourFairShare * 100)}% of this colour's ${c.onHand} units (${c.cap}) so one market can't empty a single popular colour.`,
    })
  } else {
    steps.push({ label: 'In stock', detail: `${c.onHand} units of this colour available in the warehouse.` })
  }

  // 4. Pack shaping.
  const preRound = Math.round(args.beforeRounding)
  if (preRound !== args.finalQty) {
    steps.push({
      label: 'Pack rounding',
      detail: args.finalQty === args.minPackQty && args.beforeRounding < args.minPackQty
        ? `${preRound} isn't a pack, so it was raised to the ${args.minPackQty}-unit minimum.`
        : `${preRound} rounded to ${args.finalQty}, the nearest multiple of ${args.roundToNearest} the warehouse can cover.`,
    })
  }
  steps.push({ label: 'Packing', detail: `${args.finalQty} units.` })
  return steps
}

/// One-sentence version of the same story, shown inline under each colour.
function buildRationale(args: {
  candidate: Candidate
  source: SuggestionDemandSource
  marketName: string
  finalQty: number
  bindingConstraint: SuggestionConstraint
}): string {
  const c = args.candidate
  const parts: string[] = []

  if (args.source === 'WAREHOUSE_STOCK') {
    parts.push(`No sales history anywhere, so this is an even share of the ${c.onHand} in stock`)
  } else if (args.source === 'CROSS_MARKET' || args.source === 'CROSS_MARKET_WIDENED') {
    parts.push(`No sales at ${args.marketName} yet, and other markets average about ${Math.round(c.lastYearSoldForColour)} of this colour each`)
  } else if (c.hasColourMix && c.lastYearSoldForColour > 0) {
    parts.push(`Sold ${c.lastYearSoldForColour} of this colour here${args.source === 'LOCAL_SALES_WIDENED' ? ' (found outside your date range)' : ''}`)
  } else {
    parts.push(`This style sold ${Math.round(c.familyObserved)} here; colours split evenly (Square records it at product level)`)
  }

  switch (args.bindingConstraint) {
    case 'WAREHOUSE_STOCK':
      parts.push(`packing ${args.finalQty}, which is all the warehouse has`)
      break
    case 'FAIR_SHARE':
      parts.push(`packing ${args.finalQty}, held to this market's share of the ${c.onHand} in stock so other markets aren't starved`)
      break
    case 'OTHER_REQUESTS':
      parts.push(`packing ${args.finalQty}, because ${c.competing} units are already claimed by other markets' open requests`)
      break
    case 'MIN_PACK':
      parts.push(`packing ${args.finalQty}, the minimum that counts as a pack`)
      break
    case 'BUDGET':
    case 'PACK_ROUNDING':
      parts.push(`packing ${args.finalQty} to fit your target, rounded to a clean pack size`)
      break
    default:
      parts.push(`packing ${args.finalQty}`)
  }
  return parts.join('; ') + '.'
}

function buildHeadline(args: {
  source: SuggestionDemandSource
  marketName: string
  sourceMarketCount: number
  windowUsed: { start: Date; end: Date }
  totalRecommended: number
  styleCount: number
}): string {
  const scale = `${args.totalRecommended.toLocaleString('en-US')} units across ${args.styleCount} style${args.styleCount === 1 ? '' : 's'}`
  switch (args.source) {
    case 'LOCAL_SALES':
      return `${scale}, built from ${args.marketName}'s own sales between ${fmtRange(args.windowUsed)}.`
    case 'LOCAL_SALES_WIDENED':
      return `${scale}. Your date range had no sales in it, so this uses all of ${args.marketName}'s history (${fmtRange(args.windowUsed)}).`
    case 'CROSS_MARKET':
    case 'CROSS_MARKET_WIDENED':
      return `${scale}. ${args.marketName} is new, so this is an opening list estimated from ${args.sourceMarketCount} other market${args.sourceMarketCount === 1 ? '' : 's'}.`
    case 'WAREHOUSE_STOCK':
      return `${scale}, sized from warehouse stock because there is no sales history to work from.`
  }
}

/// The run-level mechanism, one plain sentence per stage. This is what the
/// "How this list was built" panel renders top to bottom.
function buildRunSteps(args: {
  source: SuggestionDemandSource
  marketName: string
  marketCount: number
  sourceMarkets: SuggestionSourceMarket[]
  windowRequested: { start: Date; end: Date }
  windowUsed: { start: Date; end: Date }
  windowWidened: boolean
  targetMode: GenerateSuggestionInput['targetMode']
  growthPct?: number
  targetRevenueDollars?: number
  shelfBufferPct: number
  roundToNearest: number
  minPackQty: number
  isBudgetMode: boolean
  droppedBelowMinimum: number
  totalRecommended: number
}): string[] {
  const steps: string[] = []

  if (args.windowWidened) {
    steps.push(`Your dates held no sales, so the search widened to ${fmtRange(args.windowUsed)}.`)
  }

  switch (args.source) {
    case 'LOCAL_SALES':
    case 'LOCAL_SALES_WIDENED':
      steps.push(`Measured what ${args.marketName} sold, colour by colour, over ${fmtRange(args.windowUsed)}.`)
      break
    case 'CROSS_MARKET':
    case 'CROSS_MARKET_WIDENED':
      steps.push(
        `${args.marketName} has no sales yet, so each product's total across the other markets was divided by ${args.marketCount} for a per-market average. Deliberately cautious: a new market should open light.`,
      )
      break
    case 'WAREHOUSE_STOCK':
      steps.push(
        `Nothing has sold anywhere, so stock was split evenly across all ${args.marketCount + 1} markets. With no demand signal, no market has a claim to more than an equal share.`,
      )
      break
  }

  if (args.targetMode === 'CUSTOM_REVENUE') {
    steps.push(
      `Split $${(args.targetRevenueDollars ?? 0).toLocaleString('en-US')} by each product's share of revenue, then converted back to units at its own price. That is why a cheap fast-seller and a pricey slow-seller land on very different counts.`,
    )
  } else if (args.targetMode === 'GROW_PCT') {
    steps.push(
      `Moved each product by ${args.growthPct ?? 0}%, capped at 3x so a big percentage on a one-off sale cannot run away.`,
    )
  }

  if (args.shelfBufferPct > 0) {
    steps.push(
      `Added ${args.shelfBufferPct}% on top. A target is what you expect to sell, so the shelf needs stock while it sells.`,
    )
  }

  steps.push(
    'Capped each line at warehouse stock, minus what other markets have already requested, then applied fair share at product and colour level so no one market can drain a popular item.',
  )

  if (args.droppedBelowMinimum > 0) {
    steps.push(
      args.isBudgetMode
        ? `Dropped ${args.droppedBelowMinimum} item${args.droppedBelowMinimum === 1 ? '' : 's'} below ${args.minPackQty} units and spread their share across the rest.`
        : `Dropped ${args.droppedBelowMinimum} item${args.droppedBelowMinimum === 1 ? '' : 's'} the warehouse cannot fill to a full ${args.minPackQty}-unit pack.`,
    )
  }
  steps.push(
    `Rounded to the nearest ${args.roundToNearest}, giving ${args.totalRecommended.toLocaleString('en-US')} units. Every number below is editable.`,
  )
  return steps
}

/// Short phrase naming the target that was applied. Lets the compact summary
/// state the target for every mode, including the ones with no dollar or
/// unit budget to report.
function buildTargetSummary(args: {
  targetMode: GenerateSuggestionInput['targetMode']
  growthPct?: number
  targetUnits?: number
  targetRevenueDollars?: number
  initialShipmentPct: number
}): string {
  switch (args.targetMode) {
    case 'MATCH_LAST_YEAR':
      return 'Match what sold last season'
    case 'GROW_PCT': {
      const pct = args.growthPct ?? 0
      return `${pct >= 0 ? 'Grow' : 'Shrink'} last season by ${Math.abs(pct)}%`
    }
    case 'CUSTOM_UNITS':
      return `${(args.targetUnits ?? 0).toLocaleString('en-US')} units in total`
    case 'CUSTOM_REVENUE':
      return `$${(args.targetRevenueDollars ?? 0).toLocaleString('en-US')} sales goal`
    case 'INITIAL_SHIPMENT':
      return `${args.initialShipmentPct}% of warehouse stock`
  }
}

function emptyResult(
  input: GenerateSuggestionInput,
  window: { start: Date; end: Date },
  notes: string[],
  explain: SuggestionExplain,
): GenerateSuggestionResult {
  return {
    locationId: input.locationId,
    targetMode: input.targetMode,
    window,
    lines: [],
    totals: { variationsCovered: 0, totalRecommendedUnits: 0, totalLastYearUnits: 0 },
    notes,
    explain,
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
  if (seasonStart && seasonEnd) {
    return { start: shiftYears(seasonStart, -1), end: shiftYears(seasonEnd, -1) }
  }
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

function fmtRange(w: { start: Date; end: Date }): string {
  return `${w.start.toISOString().slice(0, 10)} and ${w.end.toISOString().slice(0, 10)}`
}
