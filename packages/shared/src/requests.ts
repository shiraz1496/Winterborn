import { z } from 'zod'

export const requestStateSchema = z.enum([
  'DRAFT',
  'OPEN',
  'PACKING',
  /// Auto-set by the pack service when every requested unit is on a
  /// non-dispatched box, and reverted to PACKING when a box is
  /// discarded. Doc §9.3 addendum, added 2026-09-02.
  'PACKED',
  'DISPATCHED',
  'ARRIVED',
  'CLOSED',
])
export type RequestState = z.infer<typeof requestStateSchema>

export const requestOriginSchema = z.enum(['THRESHOLD', 'REVIEW', 'MANUAL'])
export type RequestOrigin = z.infer<typeof requestOriginSchema>

export const createRequestLineInputSchema = z.object({
  variationId: z.string().min(1),
  /// Optional: a request line may be raised at family level ("60 gray") and
  /// only resolved to a concrete variant during packing (spec §9.4).
  warehouseVariantId: z.string().min(1).optional(),
  qtyRequested: z.number().int().positive(),
})
export type CreateRequestLineInput = z.infer<typeof createRequestLineInputSchema>

export const createRequestInputSchema = z.object({
  locationId: z.string().min(1),
  createdFrom: requestOriginSchema,
  lines: z.array(createRequestLineInputSchema).min(1),
  /// Where the request should land on creation. Defaults to DRAFT (the
  /// existing manual flow — user drafts, then explicitly hits Submit).
  /// OPEN is used by the Approve-a-suggestion flow so the packing list
  /// enters the warehouse pipeline in one click. The server enforces the
  /// same role gate that DRAFT→OPEN would need, so this is not a way to
  /// bypass permissions.
  initialState: z.enum(['DRAFT', 'OPEN']).optional(),
})
export type CreateRequestInput = z.infer<typeof createRequestInputSchema>

export const updateRequestLineInputSchema = z
  .object({
    qtyRequested: z.number().int().positive().optional(),
    warehouseVariantId: z.string().min(1).optional(),
  })
  .refine((v) => v.qtyRequested !== undefined || v.warehouseVariantId !== undefined, {
    message: 'at least one of qtyRequested or warehouseVariantId is required',
  })
export type UpdateRequestLineInput = z.infer<typeof updateRequestLineInputSchema>

export const transitionRequestInputSchema = z.object({ state: requestStateSchema })
export type TransitionRequestInput = z.infer<typeof transitionRequestInputSchema>

/// Response shapes -- what `RequestsController` actually returns, not the
/// input schemas above. `qtyRequested` round-trips through JSON as a plain
/// number since Prisma's Int maps straight to it.
export const requestLineSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  variationId: z.string(),
  warehouseVariantId: z.string().nullable(),
  qtyRequested: z.number().int(),
})
export type RequestLineDto = z.infer<typeof requestLineSchema>

/// Fields common to every response shape. `transition()` returns exactly
/// this -- Prisma's bare `update()` result, with no `lines` relation loaded
/// -- while create/list/get include `lines` on top (see restockRequestSchema).
export const restockRequestBaseSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  state: requestStateSchema,
  createdFrom: requestOriginSchema,
  createdById: z.string().nullable(),
  createdAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
})
export type RestockRequestBaseDto = z.infer<typeof restockRequestBaseSchema>

export const restockRequestSchema = restockRequestBaseSchema.extend({
  lines: z.array(requestLineSchema),
})
export type RestockRequestDto = z.infer<typeof restockRequestSchema>

/// Doc 3 §3.3 and §3.4 combined into one payload per line -- the read
/// surface `GET /requests/:id/analysis` returns. Nothing here is stored;
/// it is derived on every call from the ledger, the request queue and each
/// location's season calendar.
export const requestLineRecommendationSchema = z.object({
  /// Target-minus-current-onHand, floored at 1 when a positive target
  /// exists. `null` when there is no threshold configured for this
  /// (variation, location) -- the system has no basis to recommend a number
  /// and should not invent one.
  qty: z.number().int().nullable(),
  minLevel: z.number().int().nullable(),
  onHand: z.number().int(),
  weeksRemaining: z.number().int().nullable(),
})
export type RequestLineRecommendation = z.infer<typeof requestLineRecommendationSchema>

export const requestLineAllocationSchema = z.object({
  /// Warehouse on-hand for this line's family (variationId). Family, not
  /// variant, because that is the granularity every open request line
  /// carries -- a variant-only comparison would silently ignore lines that
  /// left warehouseVariantId null.
  warehouseOnHand: z.number().int(),
  /// Sum of qtyRequested across every OPEN/DRAFT request line at any OTHER
  /// location for the same family. This request's own competing lines
  /// (same family, different lines) are excluded and counted separately as
  /// `sameRequestDemand`, so the flag only fires when fulfilling this line
  /// in full would starve someone else.
  otherOpenDemand: z.number().int(),
  sameRequestDemand: z.number().int(),
  wouldStarveOthers: z.boolean(),
  otherLocationCount: z.number().int(),
})
export type RequestLineAllocation = z.infer<typeof requestLineAllocationSchema>

export const requestLineAnalysisSchema = z.object({
  lineId: z.string(),
  variationId: z.string(),
  qtyRequested: z.number().int(),
  recommendation: requestLineRecommendationSchema,
  allocation: requestLineAllocationSchema,
})
export type RequestLineAnalysis = z.infer<typeof requestLineAnalysisSchema>

/// Packing-list suggestion input (POST /requests/generate-suggestion).
///
/// Answers the CEO's ask (voice notes 2026-09-01): given a market, produce
/// a full draft packing list — which products, which colours, how many —
/// that the operator can then approve, edit, or reject before it becomes
/// a real request. This is distinct from RequestLineAnalysis, which
/// evaluates an already-drafted line; this generates the whole draft from
/// last year's sales + current stock.
///
/// Target modes:
///   MATCH_LAST_YEAR:  qty per variation = last year's sales at this market
///   GROW_PCT:         qty per variation = last year's sales * (1 + growthPct/100)
///   CUSTOM_UNITS:     a total unit budget split across variations in proportion
///                     to last year's mix at this market
///   CUSTOM_REVENUE:   a total dollar budget split across variations in
///                     proportion to last year's REVENUE mix (units × price),
///                     then converted back to units using each variation's
///                     current price from the Square catalog cache
///   INITIAL_SHIPMENT: the "kick off the season" mode from CEO voice note 2
///                     — targets a share of current warehouse stock (default
///                     85%) for the candidate variations, distributed
///                     proportionally to last year's mix at this market. No
///                     input required beyond an optional override pct.
export const suggestionTargetModeSchema = z.enum([
  'MATCH_LAST_YEAR',
  'GROW_PCT',
  'CUSTOM_UNITS',
  'CUSTOM_REVENUE',
  'INITIAL_SHIPMENT',
])
export type SuggestionTargetMode = z.infer<typeof suggestionTargetModeSchema>

/// Pack-shape defaults, shared by the API and the UI so the form and the
/// engine can never disagree about what "no override" means.
export const DEFAULT_ROUND_TO_NEAREST = 5
export const DEFAULT_MIN_PACK_QTY = 5

/// Default shelf buffer: none, for every mode. A revenue figure is a
/// SELL-THROUGH goal, so shipping exactly the units that reach it leaves the
/// booth bare at the end, but quietly inflating the operator's number for
/// them is the wrong fix. The control is right there in the form and they
/// set it themselves.
export function defaultShelfBufferPct(_mode: SuggestionTargetMode): number {
  return 0
}

export const generateSuggestionInputSchema = z
  .object({
    locationId: z.string().min(1),
    targetMode: suggestionTargetModeSchema,
    /// Required when targetMode = GROW_PCT. Integer percent (10 = +10%).
    /// Negative is allowed (a market shrinking after a slow season).
    growthPct: z.number().int().min(-100).max(500).optional(),
    /// Required when targetMode = CUSTOM_UNITS.
    targetUnits: z.number().int().positive().optional(),
    /// Required when targetMode = CUSTOM_REVENUE. Dollars (not cents) so
    /// the operator types "50000" not "5000000" — the service converts
    /// to cents internally to match Square's priceCents convention.
    targetRevenueDollars: z.number().int().positive().optional(),
    /// Used only when targetMode = INITIAL_SHIPMENT. Defaults to 85 (the
    /// CEO's "80-90% of stock" language, rounded to the midpoint). Cap
    /// at 100 so we never try to ship more than the warehouse has.
    initialShipmentPct: z.number().int().min(1).max(100).optional(),
    /// Optional explicit window for "last year". Defaults to the same season
    /// window one year ago (from Location.seasonStart/seasonEnd) when set,
    /// otherwise trailing 12 months ending one year before today.
    lastYearStart: z.coerce.date().optional(),
    lastYearEnd: z.coerce.date().optional(),
    /// Optional filter — restrict the suggestion to variations whose
    /// ItemGroup belongs to any of the given categories, OR any descendant
    /// of them. Empty / omitted means no filter (all variations
    /// considered). The IDs can be at any level of the tree; the service
    /// walks the tree down to include children. Matches the CEO's ask
    /// "high-level products, top category" — the UI presents roots only,
    /// but the backend accepts any category and walks the tree.
    categoryIds: z.array(z.string().min(1)).optional(),
    /// Shelf buffer: extra stock shipped ON TOP of the units the target
    /// implies, so the booth still looks full while things sell. The CEO's
    /// question was "on meeting the revenue, on the booth shelf there
    /// should be some in stock". A revenue target is a SELL-THROUGH goal,
    /// so shipping exactly the units that hit it leaves an empty table on
    /// the last day. Defaults per mode (see `defaultShelfBufferPct`):
    /// 20% for the goal-shaped modes (revenue), 0% for the modes where
    /// the operator already typed an explicit number of units.
    shelfBufferPct: z.number().int().min(0).max(200).optional(),
    /// Pack rounding. Nobody packs 21 of something, so quantities are
    /// rounded to a multiple of this (default 5) so the picking list reads
    /// like a real packing list. Rounding never pushes a line above what
    /// the warehouse can actually supply.
    roundToNearest: z.number().int().min(1).max(50).optional(),
    /// Minimum units per item line (default 5). A single unit of a colour
    /// is not a pack, it's noise on a picking sheet. Lines that can't
    /// reach this are either bumped up to it (demand modes) or dropped and
    /// their budget redistributed (budget modes), never left at 1.
    minPackQty: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.targetMode === 'GROW_PCT' && v.growthPct === undefined) {
      ctx.addIssue({ code: 'custom', path: ['growthPct'], message: 'growthPct required for GROW_PCT mode' })
    }
    if (v.targetMode === 'CUSTOM_UNITS' && v.targetUnits === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetUnits'], message: 'targetUnits required for CUSTOM_UNITS mode' })
    }
    if (v.targetMode === 'CUSTOM_REVENUE' && v.targetRevenueDollars === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetRevenueDollars'],
        message: 'targetRevenueDollars required for CUSTOM_REVENUE mode',
      })
    }
  })
export type GenerateSuggestionInput = z.infer<typeof generateSuggestionInputSchema>

/// One recommended line in the generated packing list. Each row is one
/// (variation, warehouseVariant) pair the operator can accept as-is,
/// edit the qty on, or drop.
/// How confident the engine is in one line's number.
///   HIGH   = real data at this market, enough signal to trust
///   MEDIUM = real data but sparse, or the target mode extrapolates
///            beyond the observed range
///   LOW    = fell back to cross-market inference or dispatch history —
///            the number is an educated guess, not a measured fact
export const suggestionConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW'])
export type SuggestionConfidence = z.infer<typeof suggestionConfidenceSchema>

/// Where the demand numbers in this run actually came from. Surfaced to
/// the operator verbatim. The #1 complaint about the old engine was that
/// it never said which data it used, so a new market's list looked like it
/// had been invented.
///   LOCAL_SALES           this market's own sales inside the chosen window
///   LOCAL_SALES_WIDENED   this market's own sales, window widened to all
///                         available history because the chosen one was empty
///   CROSS_MARKET          other markets' sales in the chosen window,
///                         averaged per market (the "new market" case)
///   CROSS_MARKET_WIDENED  same, with the window widened to all history
///   WAREHOUSE_STOCK       nothing has ever sold anywhere in scope, so the
///                         list is sized from what's in the warehouse and
///                         the operator still gets a usable starting point
export const suggestionDemandSourceSchema = z.enum([
  'LOCAL_SALES',
  'LOCAL_SALES_WIDENED',
  'CROSS_MARKET',
  'CROSS_MARKET_WIDENED',
  'WAREHOUSE_STOCK',
])
export type SuggestionDemandSource = z.infer<typeof suggestionDemandSourceSchema>

/// Which rule actually decided a line's final number. The UI shows this as
/// a one-word tag so an operator can see at a glance whether a small number
/// means "it doesn't sell" or "we're out of stock", two very different
/// problems that used to look identical on screen.
export const suggestionConstraintSchema = z.enum([
  'DEMAND',
  'BUDGET',
  'WAREHOUSE_STOCK',
  'FAIR_SHARE',
  'OTHER_REQUESTS',
  'PACK_ROUNDING',
  'MIN_PACK',
])
export type SuggestionConstraint = z.infer<typeof suggestionConstraintSchema>

/// One step in a line's arithmetic, in the order it was applied. Rendered
/// as a "show the math" list under each item so the number is never a
/// black box: label is the operation, detail is the plain-English result.
export const suggestionStepSchema = z.object({
  label: z.string(),
  detail: z.string(),
})
export type SuggestionStep = z.infer<typeof suggestionStepSchema>

/// A market that contributed sales to a cross-market inference, with the
/// units it contributed. Answers the CEO's "which markets' data did it
/// use?" directly, by name and by number.
export const suggestionSourceMarketSchema = z.object({
  locationId: z.string(),
  name: z.string(),
  unitsSold: z.number().int().nonnegative(),
})
export type SuggestionSourceMarket = z.infer<typeof suggestionSourceMarketSchema>

/// Run-level explanation of the whole list: what data it used, over what
/// window, with which settings, and what the resulting totals mean.
export const suggestionExplainSchema = z.object({
  demandSource: suggestionDemandSourceSchema,
  /// One sentence the operator can read and immediately understand.
  headline: z.string(),
  /// Ordered plain-English description of the mechanism, one line per stage.
  /// Secondary detail: the panel keeps this behind a "Full working" toggle
  /// so the default view stays short.
  steps: z.array(z.string()),
  /// One short phrase naming the target that was applied, e.g. "Match last
  /// season" or "$30,000 revenue goal". Lets the compact summary state the
  /// target for every mode, not just the budget ones.
  targetSummary: z.string(),
  /// The window the operator asked for vs. the one actually used. They
  /// differ when the requested window contained no sales and the engine
  /// widened it rather than returning an empty list.
  windowRequested: z.object({ start: z.coerce.date(), end: z.coerce.date() }),
  windowUsed: z.object({ start: z.coerce.date(), end: z.coerce.date() }),
  windowWidened: z.boolean(),
  /// Populated for the cross-market paths: named markets and their units.
  sourceMarkets: z.array(suggestionSourceMarketSchema),
  /// Settings actually in force for this run (after defaults were applied),
  /// so the panel can state them rather than making the operator guess.
  settings: z.object({
    shelfBufferPct: z.number().int().nonnegative(),
    roundToNearest: z.number().int().positive(),
    minPackQty: z.number().int().positive(),
  }),
  /// Budget-mode accounting: what was asked for, what got allocated, and
  /// the units that implies. Null for the demand-driven modes.
  budget: z
    .object({
      label: z.string(),
      /// The goal the operator typed, e.g. "$25,000 sales goal".
      targetDisplay: z.string(),
      /// What the engine actually tries to ship: the goal plus the shelf
      /// buffer. Stated separately because conflating the two is exactly
      /// what made the buffer hard to understand.
      sendTargetDisplay: z.string(),
      /// What it managed to allocate.
      allocatedDisplay: z.string(),
      /// Set only when the send target could not be reached, saying why.
      shortfall: z.string().nullable(),
    })
    .nullable(),
  /// Styles the engine considered but dropped, and why. This is the tail that
  /// used to silently vanish or show up as a nonsense "1".
  droppedBelowMinimum: z.number().int().nonnegative(),
})
export type SuggestionExplain = z.infer<typeof suggestionExplainSchema>

export const suggestionLineSchema = z.object({
  variationId: z.string(),
  warehouseVariantId: z.string().nullable(),
  qtyRecommended: z.number().int().nonnegative(),
  /// Signal breakdown so the UI can show the operator *why* this number
  /// exists — the "6 W's" answer for recommendations.
  lastYearSold: z.number().int().nonnegative(),
  /// Family-level total units sold at this market last season. Used to
  /// sort the results so highest-demand *products* lead — not just
  /// highest-recommended-qty, which can diverge from demand in Custom-
  /// revenue or Grow-% modes. Identical across every line in the same
  /// family (they all belong to the same variation).
  familyLastYearSold: z.number().int().nonnegative(),
  warehouseOnHand: z.number().int().nonnegative(),
  otherLocationDemand: z.number().int().nonnegative(),
  /// Short human sentence explaining the number in plain English.
  /// e.g. "Sold 42 last year at Denver; warehouse has 30 available."
  rationale: z.string(),
  /// Confidence in this specific line's number. Surfaced in the UI as a
  /// small badge so a reviewer knows which lines to eyeball more closely.
  confidence: suggestionConfidenceSchema,
  /// Why the line carries that confidence, in one short sentence. Confidence
  /// describes the DATA behind the suggestion, not the quantity the operator
  /// ends up choosing. The UI says so explicitly, because "I changed the
  /// number and the badge didn't move" was a real point of confusion.
  confidenceReason: z.string(),
  /// The unconstrained ask before warehouse stock, fair share and other
  /// markets' open requests were applied. Shown next to the recommendation
  /// so a suppressed number is visibly suppressed rather than just small.
  demandTarget: z.number().int().nonnegative(),
  /// The rule that actually set the final number.
  bindingConstraint: suggestionConstraintSchema,
  /// Ordered arithmetic behind `qtyRecommended`.
  steps: z.array(suggestionStepSchema),
})
export type SuggestionLine = z.infer<typeof suggestionLineSchema>

export const generateSuggestionResultSchema = z.object({
  locationId: z.string(),
  targetMode: suggestionTargetModeSchema,
  window: z.object({
    start: z.coerce.date(),
    end: z.coerce.date(),
  }),
  lines: z.array(suggestionLineSchema),
  totals: z.object({
    variationsCovered: z.number().int().nonnegative(),
    totalRecommendedUnits: z.number().int().nonnegative(),
    totalLastYearUnits: z.number().int().nonnegative(),
  }),
  /// Human-readable caveats surfaced to the operator: which data source
  /// was used, why the answer might be low-confidence, etc.
  notes: z.array(z.string()),
  /// Structured "why did it do this" payload backing the explanation panel.
  explain: suggestionExplainSchema,
})
export type GenerateSuggestionResult = z.infer<typeof generateSuggestionResultSchema>
