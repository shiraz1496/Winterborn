import { z } from 'zod'
import { requestStateSchema } from './requests.js'

/// Input to `POST /thresholds/evaluate`: re-derive on-hand for one
/// (variation, location) pair against its Threshold and auto-draft if it
/// has fallen below minLevel. Deliberately narrow -- callers (a poll pass,
/// an operator refresh, a test) name exactly the pair that changed rather
/// than the engine guessing which ledger rows just moved.
export const evaluateThresholdInputSchema = z.object({
  variationId: z.string().min(1),
  locationId: z.string().min(1),
})
export type EvaluateThresholdInput = z.infer<typeof evaluateThresholdInputSchema>

/// `created` is true only the moment a NEW line lands on a request --
/// re-evaluating an already-drafted breach returns `created: false` with
/// the same requestId/lineId, which is the dedupe guarantee spec §9.7
/// requires made visible to the caller.
export const evaluateThresholdResultSchema = z.object({
  breached: z.boolean(),
  onHand: z.number().int(),
  minLevel: z.number().int().nullable(),
  created: z.boolean(),
  requestId: z.string().nullable(),
  lineId: z.string().nullable(),
})
export type EvaluateThresholdResult = z.infer<typeof evaluateThresholdResultSchema>

export const evaluateAllResultSchema = z.object({
  evaluated: z.number().int(),
  breached: z.number().int(),
  drafted: z.number().int(),
})
export type EvaluateAllResult = z.infer<typeof evaluateAllResultSchema>

/// One line of the decision queue (spec §9.9): a THRESHOLD-origin request
/// line still awaiting review, with the numbers that tripped it carried
/// alongside so the dashboard never re-derives them per row.
export const decisionQueueLineSchema = z.object({
  lineId: z.string(),
  variationId: z.string(),
  qtyRequested: z.number().int(),
  onHand: z.number().int(),
  minLevel: z.number().int(),
})
export type DecisionQueueLine = z.infer<typeof decisionQueueLineSchema>

export const decisionQueueRowSchema = z.object({
  requestId: z.string(),
  locationId: z.string(),
  state: requestStateSchema,
  createdAt: z.coerce.date(),
  lines: z.array(decisionQueueLineSchema),
})
export type DecisionQueueRow = z.infer<typeof decisionQueueRowSchema>
