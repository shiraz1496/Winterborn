# Square Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Ingest Square sales into the ledger in near real time, with a reconciliation poll that makes the webhook non-load-bearing, then prove the whole path at production volume by replaying all 41,226 real 2025 orders.

**Architecture:** Webhook endpoint verifies the signature, writes the raw payload to `SquareInboxEvent`, returns 200, and does nothing else. A worker drains the inbox and writes `SALE` events through `LedgerService`. A cron poll re-scans Orders per location on a cursor with overlap, producing *identical* idempotency keys, so re-ingestion is a no-op and a week of dropped webhooks self-heals on one pass.

**Tech Stack:** NestJS, Prisma, `square` SDK (sandbox only), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md` §7.

## Global Constraints

- **The poll is the source of truth; webhooks are only the low-latency trigger.** Both paths must produce identical idempotency keys for the same sale. Use the builders in `@winterborn/shared`; never construct a key inline.
- **The webhook endpoint does three things only:** verify signature, insert raw event, return 200. No parsing, no ledger write, no Square API call inline. Target under 50ms.
- **`LedgerService` remains the sole writer to `ledger_event`.** The worker calls it; it does not insert.
- **Sales carry no `warehouseVariantId`.** Square reports at colour-family level.
- **Sandbox only.** No production token. Signature verification is tested against the sandbox signature key.
- **Every Square call checks `res.errors`.** The SDK reports API failures in the body without throwing.
- **Client data never leaves the machine.** `data/` is gitignored; no real figures in committed files.
- Node 20+, pnpm, money in integer cents.

## Testing Policy

Test the ingest path, idempotency across both paths, and the replay. Do not re-test the SDK, Prisma, or Nest wiring.

---

### Task 1: Webhook receiver and inbox worker

**Files:** `apps/api/src/square/{square.module.ts,square-client.ts,webhook.controller.ts,inbox.worker.ts,order-mapper.ts}`, `apps/api/test/square-ingest.spec.ts`, modify `apps/api/src/main.ts`

**Produces:**
- `verifySquareSignature(rawBody: string, header: string, key: string, notificationUrl: string): boolean`
- `POST /square/webhook` → 200, inserts `SquareInboxEvent`
- `InboxWorker.processOne(): Promise<{ processed: number; failed: number }>`
- `mapOrderToLedgerInputs(order): AppendEventInput[]`

**Steps:**

- [ ] **1.** `main.ts` must expose the **raw request body** for the webhook route. Signature verification is HMAC-SHA256 over `notificationUrl + rawBody`, and a re-serialised JSON body will not match. Use `express.raw({ type: 'application/json' })` scoped to that path, or Nest's `rawBody: true` option. Get this right first; it is the single most common cause of "signature always invalid".

- [ ] **2.** Write `apps/api/test/square-ingest.spec.ts` covering:
  - a correctly signed payload returns 200 and writes exactly one `SquareInboxEvent`
  - a payload with a tampered body returns 401 and writes nothing
  - re-delivering the same `event_id` writes one row, not two
  - the worker maps a two-line order to two `SALE` events with negative quantities, keyed by `saleKey(orderId, lineUid)`
  - a line item whose `catalogObjectId` matches no known `Variation` is recorded as a dead letter and does **not** throw or silently vanish
  - a refund line produces a positive correcting event, not a skipped one

  Build order fixtures by hand. Compare signatures with `crypto.timingSafeEqual`.

- [ ] **3.** Implement. The controller inserts `{ squareEventId, eventType, payload }` and returns. `InboxWorker` claims unprocessed rows, maps, calls `LedgerService.append`, stamps `processedAt`, or records `error` and leaves the row for retry. Unmapped variation IDs go to a dead-letter list surfaced on the health endpoint, never dropped.

- [ ] **4.** `pnpm --filter @winterborn/api test -- square-ingest`, then commit `feat(api): Square webhook receiver and inbox worker`.

---

### Task 2: Reconciliation poll

**Files:** `apps/api/src/square/poll.service.ts`, `apps/api/src/cli/poll-orders.ts`, `apps/api/test/square-poll.spec.ts`

**Produces:** `PollService.pollLocation(locationId): Promise<{ ingested: number; deduped: number }>`, `pollAll()`, `cli:poll-orders`

**Steps:**

- [ ] **1.** Write the test. The one that matters: ingest ten orders by the webhook path, then poll a window covering all thirty, and assert the ledger holds thirty events and thirty rows. That is the self-heal property from spec §7.2, and it only works because both paths build keys identically.

  Also assert the cursor advances only after a full successful pass, so a mid-pagination failure re-scans rather than skipping.

- [ ] **2.** Implement. Per active market location, `SearchOrders` filtered on `updated_at` since `SquareSyncCursor.cursor`, **re-scanning a 60-minute overlap window** so nothing is lost at a boundary. Paginate to exhaustion. Map through the same `mapOrderToLedgerInputs` the worker uses — not a copy.

- [ ] **3.** Commit `feat(api): reconciliation poll with overlap window`.

---

### Task 3: Season replay at production volume

**Files:** `apps/api/src/cli/replay-season.ts`, `apps/api/test/season-replay.spec.ts`

**Produces:** `cli:replay-season --dir data/square-2025/item-detail`

This is the payoff: 52,343 real item lines across 14 locations pushed through the real ingest pipeline, so the system meets its peak volume in August rather than on opening day.

**Know the limitation and state it in the report:** the 2025 exports carry no catalog IDs (SKU is blank on all 52,278 sold lines — it is one of the audit's headline findings). So the replay maps by item name plus price-point name, not by `squareVariationId`. It therefore validates the **ledger, idempotency, derivation and poll paths at volume**, not the Square ID mapping, which needs sandbox or production data. Do not claim otherwise.

**Steps:**

- [ ] **1.** Write `season-replay.spec.ts` against a small hand-built fixture, not the real files: replaying the same window twice produces the same counts and no duplicate rows.

- [ ] **2.** Implement. Stream the nine weekly CSVs, group lines into synthetic orders by `Transaction ID`, resolve each to a `Variation` by name, and push through `LedgerService.append` with `saleKey(transactionId, lineIndex)`. Unresolved names are counted and reported, not fabricated.

- [ ] **3.** Run it against the real files. Report: lines read, resolved, unresolved, ledger rows written, wall-clock, and the derived on-hand for the top three locations. Then **run it a second time and confirm zero new rows**.

- [ ] **4.** Commit `feat(api): season replay harness`.

---

## Definition of Done

`pnpm typecheck && pnpm build && pnpm test` green, and:

1. A tampered webhook payload is rejected; a valid one lands in the inbox and nothing else happens inline.
2. Ten webhook sales followed by a thirty-order poll yields thirty events and thirty rows.
3. Unmapped variation IDs are dead-lettered, never dropped.
4. The full 2025 season replays through the real ingest path, and replaying twice writes nothing the second time.
