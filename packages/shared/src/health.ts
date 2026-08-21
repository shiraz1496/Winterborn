import { z } from 'zod'

/// One market's freshness reading inside `GET /health`. `lastPolledAt` null
/// means the reconciliation poll has never completed a pass for this
/// location -- distinct from "polled a long time ago", which is a stale
/// timestamp, not a missing one.
export const locationPollHealthSchema = z.object({
  locationId: z.string(),
  locationName: z.string(),
  lastPolledAt: z.coerce.date().nullable(),
  minutesSincePoll: z.number().nullable(),
})
export type LocationPollHealth = z.infer<typeof locationPollHealthSchema>

/// `GET /health`. Not `{status:'ok'}` -- spec §10.2 and the brief are
/// explicit that a literal ok tells the one-person support desk nothing at
/// 2am. Every field here answers a specific "is Square sync still alive"
/// question: per-location poll freshness, how deep the inbox backlog is,
/// how old the oldest stuck row is, how many rows have been dead-lettered,
/// and whether the database itself is reachable at all.
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.coerce.date(),
  database: z.object({
    connected: z.boolean(),
    error: z.string().nullable(),
  }),
  polling: z.object({
    locations: z.array(locationPollHealthSchema),
  }),
  inbox: z.object({
    /// Rows with processedAt still null -- Square events received but not
    /// yet ingested into the ledger.
    backlogDepth: z.number().int(),
    /// receivedAt of the oldest unprocessed row, or null if the backlog is empty.
    oldestUnprocessedAt: z.coerce.date().nullable(),
    /// Rows marked processed but carrying a non-null error: lines the
    /// mapper could not resolve to a known Variation, still visible rather
    /// than silently dropped (see InboxWorker's docstring).
    deadLetterCount: z.number().int(),
  }),
})
export type HealthResponse = z.infer<typeof healthResponseSchema>
