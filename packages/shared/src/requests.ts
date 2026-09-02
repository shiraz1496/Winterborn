import { z } from 'zod'

export const requestStateSchema = z.enum(['DRAFT', 'OPEN', 'PACKING', 'DISPATCHED', 'ARRIVED', 'CLOSED'])
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
///   MATCH_LAST_YEAR: qty per variation = last year's sales at this market
///   GROW_PCT:        qty per variation = last year's sales * (1 + growthPct/100)
///   CUSTOM_UNITS:    a total unit budget split across variations in proportion
///                    to last year's mix at this market
export const suggestionTargetModeSchema = z.enum(['MATCH_LAST_YEAR', 'GROW_PCT', 'CUSTOM_UNITS'])
export type SuggestionTargetMode = z.infer<typeof suggestionTargetModeSchema>

export const generateSuggestionInputSchema = z
  .object({
    locationId: z.string().min(1),
    targetMode: suggestionTargetModeSchema,
    /// Required when targetMode = GROW_PCT. Integer percent (10 = +10%).
    /// Negative is allowed (a market shrinking after a slow season).
    growthPct: z.number().int().min(-100).max(500).optional(),
    /// Required when targetMode = CUSTOM_UNITS.
    targetUnits: z.number().int().positive().optional(),
    /// Optional explicit window for "last year". Defaults to the same season
    /// window one year ago (from Location.seasonStart/seasonEnd) when set,
    /// otherwise trailing 12 months ending one year before today.
    lastYearStart: z.coerce.date().optional(),
    lastYearEnd: z.coerce.date().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.targetMode === 'GROW_PCT' && v.growthPct === undefined) {
      ctx.addIssue({ code: 'custom', path: ['growthPct'], message: 'growthPct required for GROW_PCT mode' })
    }
    if (v.targetMode === 'CUSTOM_UNITS' && v.targetUnits === undefined) {
      ctx.addIssue({ code: 'custom', path: ['targetUnits'], message: 'targetUnits required for CUSTOM_UNITS mode' })
    }
  })
export type GenerateSuggestionInput = z.infer<typeof generateSuggestionInputSchema>

/// One recommended line in the generated packing list. Each row is one
/// (variation, warehouseVariant) pair the operator can accept as-is,
/// edit the qty on, or drop.
export const suggestionLineSchema = z.object({
  variationId: z.string(),
  warehouseVariantId: z.string().nullable(),
  qtyRecommended: z.number().int().nonnegative(),
  /// Signal breakdown so the UI can show the operator *why* this number
  /// exists — the "6 W's" answer for recommendations.
  lastYearSold: z.number().int().nonnegative(),
  warehouseOnHand: z.number().int().nonnegative(),
  otherLocationDemand: z.number().int().nonnegative(),
  /// Short human sentence explaining the number in plain English.
  /// e.g. "Sold 42 last year at Denver; warehouse has 30 available."
  rationale: z.string(),
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
})
export type GenerateSuggestionResult = z.infer<typeof generateSuggestionResultSchema>
