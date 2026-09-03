import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type {
  GenerateSuggestionInput,
  GenerateSuggestionResult,
  SuggestionConfidence,
  SuggestionLine,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Generates a full draft packing list for one market location, given a
 * target mode. Answers the CEO's ask from voice notes on 2026-09-01 (and
 * the extension on 2026-09-03 covering category filter + new-market
 * inference + reliability guardrails).
 *
 * This is a sibling of `RequestAnalysisService`, not a replacement:
 *   - `RequestAnalysisService` answers "how many of this line should I ask
 *     for?" for lines already drafted on a request.
 *   - This service answers "what should the whole request look like?"
 *     starting from an empty draft.
 *
 * Algorithm — three layered demand paths, tried in order:
 *   A. LOCAL SALES         (highest confidence)
 *      Aggregate Square SALE events at the selected market in the window.
 *   B. LOCAL DISPATCHES    (medium confidence — proxy for what sold)
 *      When SALE data is thin, fall back to what we shipped to this market
 *      in the same window. Markets order what they can sell, so dispatch
 *      history is a fair proxy — noisier, but honest.
 *   C. CROSS-MARKET AGGREGATE (low confidence — the "new market" case)
 *      When A and B are both empty (fresh market, or the market opened
 *      after our data starts), aggregate demand across every OTHER market
 *      in the window. Every line's rationale calls this out explicitly so
 *      nobody mistakes the guess for measured local data.
 *
 * Then:
 *   4. Query current warehouse on-hand per warehouseVariant. Hard cap.
 *   5. Query competing demand: DRAFT + OPEN request lines at OTHER
 *      locations, grouped by variation.
 *   6. Compute per-variation target qty per mode.
 *   7. Split each variation's qty across colours in proportion to the
 *      dispatch mix at this market (or all markets if we're inferring).
 *   8. Cap each colour at its warehouseVariant on-hand.
 *   9. Discount for cross-location competing demand (proportional).
 *   10. Emit per-line confidence flag so a reviewer sees which lines to
 *       eyeball more carefully.
 *
 * Optional category filter:
 *   The operator can pass `categoryIds` to restrict the suggestion to
 *   variations whose ItemGroup is in one of those categories OR any
 *   descendant (the tree is walked top-down). Filter applies before the
 *   target math so a filtered rerun is cheap.
 *
 * Reliability guardrails:
 *   - Sanity cap: qty per line never exceeds 3× the local baseline unless
 *     the operator explicitly asked for it via CUSTOM_UNITS.
 *   - Confidence per line: HIGH / MEDIUM / LOW based on which demand path
 *     produced the number.
 *   - Never returns 0 — a line either has a positive qty or is omitted
 *     entirely. The UI only shows things the engine believes in.
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

    const window = resolveLastYearWindow(input, location.seasonStart, location.seasonEnd)
    const notes: string[] = []

    // Optional category filter — walk the tree down from the chosen roots
    // and collect every descendant category. Variations whose ItemGroup is
    // in that descendant set survive; everything else is skipped before we
    // do any target math.
    const allowedVariationIds = await this.resolveCategoryFilter(input.categoryIds)
    if (allowedVariationIds && allowedVariationIds.size === 0) {
      notes.push('No variations match the selected categories.')
      return emptyResult(input, window, notes)
    }
    if (allowedVariationIds && input.categoryIds) {
      notes.push(
        `Filtered to ${allowedVariationIds.size} variation(s) inside the selected ${input.categoryIds.length} categor${input.categoryIds.length === 1 ? 'y' : 'ies'} (walking the tree down to children).`,
      )
    }

    // ---- LOCAL SALES — the ONLY demand signal ------------------------
    // Family-level SALEs at this location. Sales are stored as negative
    // quantity (a sale removes stock); we flip sign to expose units sold.
    const localSalesByVariation = await this.groupSalesByVariation(
      { locationId: input.locationId, window, allowedVariationIds },
    )

    // Per-colour SALEs — used to split family targets across colours.
    // Only picks up SALE rows that carry `warehouseVariantId`, i.e.
    // Square catalog mapped per-SKU. Families mapped at family level
    // only have no per-colour signal and fall back to even split.
    const localSalesByColour = await this.groupSalesByVariantColour(
      { locationId: input.locationId, window, allowedVariationIds },
    )

    // Family-level demand map — SALES ONLY. No dispatch fallback. A
    // variation that never sold at this market gets no line (or picks
    // up cross-market inference below if the WHOLE market is empty).
    const demandByVariation = new Map<string, number>()
    for (const [vId, sold] of localSalesByVariation.entries()) {
      if (sold > 0) demandByVariation.set(vId, sold)
    }

    // ---- CROSS-MARKET INFERENCE (the "new market" case) --------------
    // Kicks in ONLY when this market has no local SALES for anything.
    // Uses sales from other markets — no dispatch fallback. Undershoots
    // by dividing by market count so a new market gets a cautious
    // opening list, not the sum of every other market's demand.
    let usedCrossMarket = false
    let crossMarketSalesByColour: Map<string, Map<string, number>> = new Map()
    if (demandByVariation.size === 0) {
      const crossSales = await this.groupSalesByVariation(
        { locationIdNot: input.locationId, kind: 'MARKET', window, allowedVariationIds },
      )
      crossMarketSalesByColour = await this.groupSalesByVariantColour(
        { locationIdNot: input.locationId, kind: 'MARKET', window, allowedVariationIds },
      )
      if (crossSales.size > 0) {
        const marketCount = await this.countOtherMarkets(input.locationId)
        for (const [vId, sold] of crossSales.entries()) {
          if (sold <= 0) continue
          const perMarket = Math.max(1, Math.round(sold / Math.max(1, marketCount)))
          demandByVariation.set(vId, perMarket)
        }
      }
      usedCrossMarket = demandByVariation.size > 0
      if (usedCrossMarket) {
        notes.push(
          `${location.name} has no local sales in this window. Estimated demand from other markets' average — treat every line as a starting point, not a prediction. Every line is marked LOW confidence.`,
        )
      }
    }

    if (demandByVariation.size === 0) {
      notes.push(
        `No sales data anywhere in the window ${window.start.toISOString().slice(0, 10)} → ${window.end.toISOString().slice(0, 10)}. If Square history has not been backfilled, run the backfill CLI first.`,
      )
      return emptyResult(input, window, notes)
    }

    // Colour split source — sales only, priority chain per family:
    //   1. Local per-colour SALES     (best — what customers bought)
    //   2. Cross-market per-colour SALES (new-market case only)
    //   3. Even split across colours (in the line-build loop below)
    //
    // No dispatch fallback anywhere — the operator asked for a pure
    // sales-based recommendation. Families whose Square catalog is
    // mapped at family level (no per-colour SALE granularity) fall to
    // even split, which is honest about the missing data.
    const colourSplitSourceByVariation = new Map<string, Map<string, number>>()
    const colourSplitProvenance = new Map<string, 'LOCAL_SALES' | 'CROSS_SALES'>()
    const variationIdsForSplit = new Set<string>([
      ...localSalesByColour.keys(),
      ...(usedCrossMarket ? crossMarketSalesByColour.keys() : []),
    ])
    for (const vId of variationIdsForSplit) {
      if (!usedCrossMarket && localSalesByColour.has(vId)) {
        colourSplitSourceByVariation.set(vId, localSalesByColour.get(vId)!)
        colourSplitProvenance.set(vId, 'LOCAL_SALES')
      } else if (usedCrossMarket && crossMarketSalesByColour.has(vId)) {
        colourSplitSourceByVariation.set(vId, crossMarketSalesByColour.get(vId)!)
        colourSplitProvenance.set(vId, 'CROSS_SALES')
      }
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

    // ---- Cross-market fair-share -------------------------------------
    // Per-family sales at OTHER markets in the same window. Used to
    // compute this market's fair share of warehouse stock: a product
    // that sells everywhere shouldn't have the first market to generate
    // drain the warehouse. Instead each market's demand competes for a
    // slice of on-hand proportional to its own demand.
    //
    // Skipped in the cross-market-inference case (usedCrossMarket=true):
    // this market has no local sales by definition, so its "fair share"
    // would collapse to 0. Leave the allocation alone — the whole line
    // is already marked LOW confidence.
    const otherMarketDemandByFamily = new Map<string, number>()
    // Per-COLOUR sales at other markets, same window — lets the per-SKU
    // cap below use a real per-colour fair share instead of applying the
    // family-wide average to every colour uniformly. Without this, a
    // colour that ONLY this market ever sells would be needlessly
    // throttled by a family average dragged down by other colours that
    // are popular elsewhere; conversely a colour that's a bestseller at
    // every market wouldn't be restrained enough by the family average
    // alone. See the per-colour cap below for how this is used.
    const otherMarketDemandByColour = new Map<string, Map<string, number>>()
    if (!usedCrossMarket && variationIds.length > 0) {
      const otherMarketSales = await this.groupSalesByVariation(
        { locationIdNot: input.locationId, kind: 'MARKET', window, allowedVariationIds },
      )
      for (const [vId, sold] of otherMarketSales.entries()) {
        if (sold > 0) otherMarketDemandByFamily.set(vId, sold)
      }
      const otherMarketColourSales = await this.groupSalesByVariantColour(
        { locationIdNot: input.locationId, kind: 'MARKET', window, allowedVariationIds },
      )
      for (const [vId, colourMap] of otherMarketColourSales.entries()) {
        otherMarketDemandByColour.set(vId, colourMap)
      }
    }

    // Price lookup for CUSTOM_REVENUE. Uses `WarehouseVariant.unitCostCents`
    // from our own catalog — no Square dependency, no reliance on a
    // Square mapping being in place. Family-level price = average of the
    // family's warehouse variants that have a price set (colours in the
    // same family typically share the same cost, but averaging tolerates
    // per-colour price differences without any one colour dominating).
    const priceCentsByVariation = new Map<string, number>()
    if (input.targetMode === 'CUSTOM_REVENUE') {
      // We already loaded warehouseVariantsForFamilies for the on-hand
      // + cap logic below. Reuse the same result to derive prices —
      // saves an extra round-trip.
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

    // Total warehouse stock across candidate variations — used by
    // INITIAL_SHIPMENT to size the "80–90% of stock" budget.
    const totalWarehouseCandidateStock = [...onHandByWarehouseVariant.values()].reduce((a, b) => a + b, 0)
    const initialShipmentPct = input.initialShipmentPct ?? 85
    const initialShipmentBudget = Math.floor(totalWarehouseCandidateStock * initialShipmentPct / 100)

    // ---- Target math -----------------------------------------------------
    // CUSTOM_UNITS shares the budget across variations in proportion to
    // their observed mix — a small item does not steal the whole packing
    // list from a bestseller.
    const totalObserved = [...demandByVariation.values()].reduce((a, b) => a + b, 0)
    // Revenue-mix total in cents = Σ (observed × price). Used by
    // CUSTOM_REVENUE to allocate dollars proportionally to what actually
    // drove revenue last year (bestselling low-priced items don't dominate).
    let totalObservedRevenueCents = 0
    for (const [vId, observed] of demandByVariation.entries()) {
      const price = priceCentsByVariation.get(vId) ?? 0
      totalObservedRevenueCents += observed * price
    }
    const targetByVariation = new Map<string, number>()
    // Sanity cap: never recommend more than SANITY_MULTIPLIER × observed
    // baseline unless the operator explicitly asked for a custom budget.
    // Protects against edge cases where growthPct=500 combines with a
    // spike that would produce nonsense.
    const SANITY_MULTIPLIER = 3
    for (const [vId, observed] of demandByVariation.entries()) {
      let target = 0
      switch (input.targetMode) {
        case 'MATCH_LAST_YEAR':
          target = observed
          break
        case 'GROW_PCT': {
          const raw = Math.round(observed * (1 + (input.growthPct ?? 0) / 100))
          target = Math.min(raw, Math.round(observed * SANITY_MULTIPLIER))
          break
        }
        case 'CUSTOM_UNITS': {
          const share = totalObserved > 0 ? observed / totalObserved : 0
          target = Math.round((input.targetUnits ?? 0) * share)
          break
        }
        case 'CUSTOM_REVENUE': {
          // Distribute dollars proportionally to last year's revenue mix
          // (units × price). Then convert this variation's dollar share
          // back to units using its own price.
          const price = priceCentsByVariation.get(vId) ?? 0
          if (price === 0 || totalObservedRevenueCents === 0) {
            target = 0
            break
          }
          const revenueShare = (observed * price) / totalObservedRevenueCents
          const targetRevenueCents = (input.targetRevenueDollars ?? 0) * 100
          const dollarsForThis = targetRevenueCents * revenueShare
          target = Math.round(dollarsForThis / price)
          break
        }
        case 'INITIAL_SHIPMENT': {
          // Distribute the budget by last year's mix. If a market has no
          // history for a variation but the variation has warehouse stock,
          // it still gets a share via the cross-market inference tier
          // that already populated demandByVariation.
          const share = totalObserved > 0 ? observed / totalObserved : 0
          target = Math.round(initialShipmentBudget * share)
          break
        }
      }
      if (target > 0) targetByVariation.set(vId, target)
    }

    // Surface caveats when a mode ran into missing data.
    if (input.targetMode === 'CUSTOM_REVENUE') {
      const withPriceCount = [...demandByVariation.keys()].filter((id) => priceCentsByVariation.has(id)).length
      const missing = demandByVariation.size - withPriceCount
      if (missing > 0) {
        notes.push(
          `${missing} variation(s) had no unit price set on their warehouse SKUs and were excluded from the revenue calculation. Fill in "unit cost" on those SKUs in the catalog to include them.`,
        )
      }
      if (withPriceCount === 0) {
        notes.push(
          `No unit prices set in the catalog — revenue-target mode cannot allocate. Set unitCostCents on your warehouse variants first.`,
        )
      }
    }
    if (input.targetMode === 'INITIAL_SHIPMENT' && totalWarehouseCandidateStock === 0) {
      notes.push('No warehouse stock available for the selected categories — nothing to ship.')
    }

    // ---- Build lines -----------------------------------------------------
    const lines: SuggestionLine[] = []
    for (const [variationId, familyTarget] of targetByVariation.entries()) {
      const wvList = warehouseVariantsByFamily.get(variationId) ?? []
      if (wvList.length === 0) continue // family with no live SKUs — skip

      const colourMix = colourSplitSourceByVariation.get(variationId) ?? new Map<string, number>()
      const mixTotal = [...colourMix.values()].reduce((a, b) => a + b, 0)
      const colourProv = colourSplitProvenance.get(variationId)

      const totalWarehouseOnHandForFamily = wvList.reduce(
        (sum, wv) => sum + (onHandByWarehouseVariant.get(wv.id) ?? 0),
        0,
      )
      const competing = competingByFamily.get(variationId) ?? 0

      // Cross-market fair share: this market's slice of warehouse stock
      // is proportional to its share of demand across every market that
      // sold this family last season. If a product is popular
      // everywhere, no one market drains the warehouse — each gets a
      // proportional cut and there is still stock left when the next
      // market runs Generate. When this is the only market with demand
      // (or cross-market inference is active), the share is 1 and
      // behavior falls back to the existing "cap at what warehouse has"
      // logic.
      const thisMarketDemand = demandByVariation.get(variationId) ?? 0
      const otherMarketDemand = otherMarketDemandByFamily.get(variationId) ?? 0
      const totalMarketDemand = thisMarketDemand + otherMarketDemand
      const fairShare = totalMarketDemand > 0 && !usedCrossMarket
        ? thisMarketDemand / totalMarketDemand
        : 1
      const fairAllocation = Math.floor(totalWarehouseOnHandForFamily * fairShare)
      const availableForThisLocation = Math.max(0, fairAllocation - competing)
      const scaleFactor = familyTarget === 0 ? 0 : Math.min(1, availableForThisLocation / familyTarget)
      const scaledTarget = Math.floor(familyTarget * scaleFactor)
      if (scaledTarget === 0) continue

      const perColourRaw = new Map<string, number>()
      // Aspirational per-colour target before warehouse/competing caps —
      // only populated in the direct-colour path so buildRationale can
      // show "growth target X, capped by warehouse stock" when relevant.
      const perColourGrownTarget = new Map<string, number>()
      // MATCH_LAST_YEAR and GROW_PCT compute at the colour level DIRECTLY
      // when per-colour SALES exist, instead of "family target × colour
      // mix". Direct per-colour math matches the operator's mental model:
      // "Black sold 8 last season → suggest 8 Black". The family-then-
      // split indirection stays for the budget modes (Custom units,
      // Custom revenue, Initial shipment) where a total pot has to be
      // distributed proportionally.
      const useDirectColourSales =
        (input.targetMode === 'MATCH_LAST_YEAR' || input.targetMode === 'GROW_PCT') &&
        colourProv === 'LOCAL_SALES' &&
        mixTotal > 0
      if (useDirectColourSales) {
        // Family-wide scaleFactor still applies here — if the warehouse
        // can't cover the family's total demand for this line's variants,
        // each colour's raw ask gets scaled down proportionally.
        for (const wv of wvList) {
          const colourSold = colourMix.get(wv.id) ?? 0
          let colourTarget = 0
          if (input.targetMode === 'MATCH_LAST_YEAR') {
            colourTarget = colourSold
          } else {
            // GROW_PCT — apply growth to each colour's own baseline;
            // sanity cap at 3× that colour's baseline to catch runaway
            // "+500%" inputs on a colour that only sold once.
            const raw = Math.round(colourSold * (1 + (input.growthPct ?? 0) / 100))
            colourTarget = Math.min(raw, Math.round(colourSold * SANITY_MULTIPLIER))
          }
          perColourRaw.set(wv.id, colourTarget * scaleFactor)
          perColourGrownTarget.set(wv.id, colourTarget)
        }
      } else if (mixTotal > 0) {
        // Budget-mode path: distribute the family scaledTarget across
        // colours proportionally to the per-colour sales mix (local, or
        // cross-market when this is a new-market call).
        for (const wv of wvList) {
          const mixQty = colourMix.get(wv.id) ?? 0
          perColourRaw.set(wv.id, scaledTarget * (mixQty / mixTotal))
        }
      } else {
        // No colour signal at all — split evenly.
        const even = scaledTarget / wvList.length
        for (const wv of wvList) perColourRaw.set(wv.id, even)
      }

      for (const wv of wvList) {
        const raw = perColourRaw.get(wv.id) ?? 0
        const onHand = onHandByWarehouseVariant.get(wv.id) ?? 0
        const lastYearSoldForColour = colourMix.get(wv.id) ?? 0

        // Per-colour fair-share cap: this market's slice of THIS SPECIFIC
        // colour's on-hand, not just the family aggregate. Without this, a
        // market whose family-level ask already fits under its fair share
        // (scaleFactor === 1, i.e. no family-level discount applied) could
        // still claim 100% of one popular colour's physical stock — fully
        // draining that SKU for every other market even though the family
        // rationale claims only a modest fair share.
        //
        // Prefer a REAL per-colour ratio (this market's colour sales vs.
        // every other market's colour sales for the same SKU) over the
        // family-wide average whenever we actually have that signal
        // (mixTotal > 0, i.e. local per-colour SALE data exists). This
        // matters in both directions: a colour that ONLY this market
        // ever sells shouldn't be throttled by a family average dragged
        // down by sibling colours that are popular elsewhere (nobody
        // else needs it, so there's nothing to protect); a colour that's
        // a bestseller at every market shouldn't be under-restrained
        // just because the family average looks generous. Falls back to
        // the family-level ratio when there's no colour-level signal to
        // trust (mixTotal === 0, or no cross-market data for this SKU).
        let colourFairShare = fairShare
        if (mixTotal > 0 && fairShare < 1) {
          const otherColourSold = otherMarketDemandByColour.get(variationId)?.get(wv.id) ?? 0
          const colourTotalDemand = lastYearSoldForColour + otherColourSold
          if (colourTotalDemand > 0) {
            colourFairShare = lastYearSoldForColour / colourTotalDemand
          }
        }
        // Floored at 1 unit (when there's real demand and real stock) so
        // a low fair-share percentage doesn't round a genuinely-selling
        // colour down to zero.
        const perColourFairCap = colourFairShare < 1
          ? Math.min(onHand, Math.max(raw > 0 && onHand > 0 ? 1 : 0, Math.floor(onHand * colourFairShare)))
          : onHand
        const qty = Math.round(Math.min(raw, perColourFairCap))
        if (qty <= 0) continue

        const confidence = decideConfidence({
          usedCrossMarket,
          observed: demandByVariation.get(variationId) ?? 0,
          hasColourMix: mixTotal > 0,
          targetMode: input.targetMode,
          growthPct: input.growthPct,
        })

        lines.push({
          variationId,
          warehouseVariantId: wv.id,
          qtyRecommended: qty,
          lastYearSold: lastYearSoldForColour || Math.round(demandByVariation.get(variationId) ?? 0),
          familyLastYearSold: Math.round(demandByVariation.get(variationId) ?? 0),
          warehouseOnHand: onHand,
          otherLocationDemand: competing,
          rationale: buildRationale({
            lastYearSoldForColour,
            colourSharePct: mixTotal > 0 ? Math.round((lastYearSoldForColour / mixTotal) * 100) : null,
            colourSource: colourProv ?? null,
            familyObserved: demandByVariation.get(variationId) ?? 0,
            onHand,
            competing,
            targetMode: input.targetMode,
            growthPct: input.growthPct,
            wasCrossMarket: usedCrossMarket,
            marketName: location.name,
            fairSharePct: fairShare < 1 ? Math.round(fairShare * 100) : null,
            fairAllocation: fairShare < 1 ? fairAllocation : null,
            totalWarehouseOnHandForFamily,
            grownTargetQty: perColourGrownTarget.get(wv.id),
            recommendedQty: qty,
            colourFairCap: colourFairShare < 1 && perColourFairCap < onHand ? perColourFairCap : null,
            colourFairSharePct: colourFairShare < 1 ? Math.round(colourFairShare * 100) : null,
          }),
          confidence,
        })
      }
    }

    // Sort by real market demand first — highest-selling PRODUCTS lead
    // regardless of target mode. Then by recommended qty as a tie-breaker
    // (Custom-revenue can flip qty ordering relative to demand when
    // prices differ; family demand is the honest priority). Finally by
    // colour qty within a family, so the UI shows a family's bestselling
    // colours near the top when expanded. Includes variationId as the
    // final tiebreaker for deterministic ordering across identical inputs.
    lines.sort((a, b) => {
      if (b.familyLastYearSold !== a.familyLastYearSold) return b.familyLastYearSold - a.familyLastYearSold
      if (b.qtyRecommended !== a.qtyRecommended) return b.qtyRecommended - a.qtyRecommended
      if (b.lastYearSold !== a.lastYearSold) return b.lastYearSold - a.lastYearSold
      return a.variationId.localeCompare(b.variationId)
    })

    const totalRecommended = lines.reduce((sum, l) => sum + l.qtyRecommended, 0)
    if (input.targetMode === 'CUSTOM_UNITS' && input.targetUnits && totalRecommended < input.targetUnits) {
      notes.push(
        `Target was ${input.targetUnits} units but only ${totalRecommended} could be allocated — warehouse stock is the bottleneck.`,
      )
    }
    if (input.targetMode === 'INITIAL_SHIPMENT') {
      notes.push(
        `Initial shipment sized as ${initialShipmentPct}% of warehouse stock (${initialShipmentBudget} of ${totalWarehouseCandidateStock} units). Ships ${totalRecommended} units after applying cross-market allocation and stock caps.`,
      )
    }
    if (input.targetMode === 'CUSTOM_REVENUE' && input.targetRevenueDollars) {
      // Compute recovered revenue so the operator can see how close we
      // got to their dollar target.
      let recoveredCents = 0
      for (const l of lines) {
        const price = priceCentsByVariation.get(l.variationId) ?? 0
        recoveredCents += l.qtyRecommended * price
      }
      const recoveredDollars = Math.round(recoveredCents / 100)
      notes.push(
        `Revenue target $${input.targetRevenueDollars} → allocated approximately $${recoveredDollars} at your catalog unit prices.`,
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
        totalLastYearUnits: totalObserved,
      },
      notes,
    }
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
          // isActive: true — a closed/retired market's historical sales
          // must not keep depressing every remaining market's fair share
          // forever. Matches the isActive filter in countOtherMarkets so
          // the fair-share numerator and denominator stay consistent.
          ? { location: { kind: args.kind, isActive: true } }
          : {}),
      },
    })
    return new Map(rows.map((r) => [r.variationId, Math.max(0, -(r._sum.quantity ?? 0))]))
  }

  /// SALE aggregation at colour grain — only picks up rows where the
  /// SALE event carries a `warehouseVariantId` (i.e., Square catalog
  /// mapping is at the per-SKU level, not just family level). This is
  /// the CORRECT colour signal: what customers actually bought at this
  /// market, in each colour. Preferred over dispatch mix because
  /// dispatches tell us what we sent, not what sold.
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

function emptyResult(
  input: GenerateSuggestionInput,
  window: { start: Date; end: Date },
  notes: string[],
): GenerateSuggestionResult {
  return {
    locationId: input.locationId,
    targetMode: input.targetMode,
    window,
    lines: [],
    totals: { variationsCovered: 0, totalRecommendedUnits: 0, totalLastYearUnits: 0 },
    notes,
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

function decideConfidence(args: {
  usedCrossMarket: boolean
  observed: number
  hasColourMix: boolean
  targetMode: GenerateSuggestionInput['targetMode']
  growthPct?: number
}): SuggestionConfidence {
  // Cross-market inference is always LOW — the whole line is a guess.
  if (args.usedCrossMarket) return 'LOW'
  // Local sales but very sparse observation → MEDIUM.
  if (args.observed < 5) return 'MEDIUM'
  // Growth extrapolations beyond ±50% → MEDIUM (we know the number is
  // being pushed further than the data supports on its own).
  if (args.targetMode === 'GROW_PCT' && Math.abs(args.growthPct ?? 0) > 50) return 'MEDIUM'
  // No per-item sales mix — colours split evenly. Honest MEDIUM.
  if (!args.hasColourMix) return 'MEDIUM'
  return 'HIGH'
}

function buildRationale(args: {
  lastYearSoldForColour: number
  colourSharePct: number | null
  colourSource: 'LOCAL_SALES' | 'CROSS_SALES' | null
  familyObserved: number
  onHand: number
  competing: number
  targetMode: GenerateSuggestionInput['targetMode']
  growthPct?: number
  wasCrossMarket: boolean
  marketName: string
  /** Percent of family warehouse stock allocated to this market, or null
   *  when this market has ~all the demand (fairShare = 1). */
  fairSharePct: number | null
  /** Absolute floor of the fair-share allocation (units the market can pull
   *  from warehouse for this family), or null when the share is 100%. */
  fairAllocation: number | null
  /** Warehouse-side family total (across all colours) — the number the
   *  fair-share percentage is applied to. */
  totalWarehouseOnHandForFamily: number
  /** Aspirational per-colour target before any warehouse/competing caps.
   *  Only present for MATCH_LAST_YEAR / GROW_PCT with local per-colour sales. */
  grownTargetQty?: number
  /** Final recommended quantity after all caps — used to detect when the
   *  warehouse is suppressing the growth target. */
  recommendedQty?: number
  /** This colour's fair-share cap (colourFairShare × this colour's
   *  on-hand), set only when it's below on-hand and therefore the actual
   *  binding constraint — i.e. the recommendation stopped short of fully
   *  draining this SKU so other markets still have some to claim. */
  colourFairCap: number | null
  /** The real per-colour fair-share percentage actually used for
   *  colourFairCap — may differ from fairSharePct (the family average)
   *  when other markets' colour-level sales data lets us be precise
   *  about THIS specific SKU rather than the family as a whole. */
  colourFairSharePct: number | null
}): string {
  const parts: string[] = []
  if (args.wasCrossMarket) {
    parts.push(`No local sales at ${args.marketName} — estimated from other markets' sales`)
  } else if (args.lastYearSoldForColour > 0 && args.colourSource === 'LOCAL_SALES') {
    // Suppress the percentage-of-family framing for MATCH / GROW modes
    // (they compute per-item directly, so the "% of style's sales"
    // language would suggest an intermediate step that isn't happening).
    const isDirectColour = args.targetMode === 'MATCH_LAST_YEAR' || args.targetMode === 'GROW_PCT'
    const share = isDirectColour || args.colourSharePct == null
      ? ''
      : ` (${args.colourSharePct}% of this style's item sales)`
    parts.push(`Sold ${args.lastYearSoldForColour} of this item last season${share}`)
  } else if (args.familyObserved > 0) {
    parts.push(`Style sold ${args.familyObserved} last season (item mix estimated evenly — Square records this style's sales at family level only)`)
  }
  if (args.targetMode === 'GROW_PCT' && args.growthPct) {
    const label = args.growthPct >= 0
      ? `growing target by ${args.growthPct}%`
      : `shrinking target by ${Math.abs(args.growthPct)}%`
    const isCapped =
      args.grownTargetQty !== undefined &&
      args.recommendedQty !== undefined &&
      args.grownTargetQty > args.recommendedQty
    parts.push(
      isCapped
        ? `${label} — warehouse has enough for ${args.recommendedQty} units (growth target is ${args.grownTargetQty}; add stock to ship the full amount)`
        : label,
    )
  }
  if (args.targetMode === 'CUSTOM_UNITS') {
    parts.push('scaled to fit your custom unit budget')
  }
  if (args.targetMode === 'CUSTOM_REVENUE') {
    parts.push('scaled to hit your revenue target')
  }
  if (args.targetMode === 'INITIAL_SHIPMENT') {
    parts.push('sized as a share of current warehouse stock (initial shipment)')
  }
  if (args.competing > 0) {
    parts.push(`${args.competing} units already requested by other markets`)
  }
  if (args.fairSharePct != null && args.fairAllocation != null) {
    parts.push(
      `capped to ${args.marketName}'s fair share of warehouse stock (${args.fairSharePct}% × ${args.totalWarehouseOnHandForFamily} = ${args.fairAllocation}) so other markets aren't starved`,
    )
  }
  if (args.colourFairCap != null) {
    // This is the SKU-level guardrail: even when the family-level fair
    // share above has headroom, this market can't claim more than its
    // fair-share slice of THIS specific colour's stock either — otherwise
    // one market could fully drain a popular colour while the family
    // numbers still looked fine. Uses the real per-colour percentage
    // (based on what other markets actually sold of this exact colour)
    // when available, which can differ from the family-wide percentage
    // above — e.g. a colour only this market sells gets a much higher
    // share than the family average, since nobody else needs it.
    parts.push(
      `kept to ${args.colourFairSharePct}% of this colour's ${args.onHand}-unit stock (${args.colourFairCap} units) so it isn't fully drained`,
    )
  } else {
    parts.push(`warehouse has ${args.onHand} of this item available`)
  }
  return parts.join('; ') + '.'
}
