# Plan 4 — Square Sync: Implementation Report

Plan: `docs/superpowers/plans/2026-08-21-square-sync.md`
Branch: `plan-04-square-sync`

## 1. Task status

All three tasks are complete, committed separately, and green against `pnpm typecheck && pnpm build && pnpm test` at the root.

| Task | Commit | Status |
| --- | --- | --- |
| 1. Webhook receiver and inbox worker | `4324948` | Done |
| 2. Reconciliation poll | `eac99a5` | Done |
| 3. Season replay harness | `8308457` | Done |

Root-level `pnpm typecheck && pnpm build && pnpm test` was run after all three commits and passed clean: 4 packages, 54 API tests + 8 shared-package tests, no failures. The sole-writer CI guard (`grep` for `prisma.ledgerEvent.*` outside `ledger.service.ts`) was re-checked after each commit and after the final state — clean every time.

## 2. Webhook signature verification

`apps/api/src/square/webhook.controller.ts` exports `verifySquareSignature(rawBody, header, key, notificationUrl)`: HMAC-SHA256 over `notificationUrl + rawBody`, base64, compared with `crypto.timingSafeEqual`.

Proven end to end over real HTTP against a real `NestApplication` (`apps/api/test/square-ingest.spec.ts`, `describe('POST /square/webhook')`):

- A correctly signed payload → `200`, exactly one `SquareInboxEvent` row, zero ledger rows (webhook does nothing but verify + insert + return). **PASS.**
- A tampered body (same valid signature, different bytes actually sent) → `401`, zero rows written. **PASS.**
- Re-delivering the identical `event_id` three times → still exactly one row (unique-constraint catch, not an error). **PASS.**

This required getting the raw-body wiring right first, per the plan's warning: `main.ts` now boots Nest with `{ rawBody: true }`, which exposes `req.rawBody` (the exact bytes Square sent) alongside the normal JSON-parsed `req.body`. The controller signs off `req.rawBody`, never a re-serialised object.

## 3. Self-heal proof (the number that matters)

`apps/api/test/square-poll.spec.ts`, `'ten sales already ingested by the webhook path, then a poll covering all thirty, yields thirty events and thirty rows'`:

- Ten orders appended directly with `source: 'WEBHOOK'` and `saleKey(orderId, lineUid)`, standing in for `InboxWorker` having already processed them.
- One `pollLocation()` pass, fed a fake `SearchOrders` response covering all **thirty** orders (the ten already-ingested plus twenty new).
- Result: **`ingested: 20`, `deduped: 10`.**
- Ledger after the pass: **30 rows, 30 distinct idempotency keys.**

This is the load-bearing property: the poll and the webhook path both call the same `mapOrderToLedgerInputs`, so they build byte-identical `saleKey`s for the same sale, and the poll's blind re-scan of the whole window costs nothing beyond ten wasted (correctly deduped) writes. A separate test in the same file proves the cursor semantics: a searcher that throws mid-pagination leaves `SquareSyncCursor` untouched (no row created), and the retry's `since` filter is byte-identical to the failed attempt's — confirming a mid-pagination failure re-scans rather than skipping.

## 4. Season replay — real 2025 data

Run via `pnpm --filter @winterborn/api cli:replay-season -- --dir ../../data/square-2025/item-detail`, against the real nine weekly CSVs (52,343 lines, matches the plan's stated volume exactly).

**Honest limitation, restated per the plan's instruction — do not read past this:** the 2025 export carries no catalog IDs (SKU is blank on every sold line). The replay resolves each line to a `Variation` by **name** — `Item` → `ItemGroup.name`, then `Price Point Name` → `ColourFamily`/`SizeOption` within that group — reusing the token-overlap fuzzy matcher already proven in `square-join.ts` for the identical Sortly-vs-Square naming mismatch, rather than building a second one. **This validates the ledger, idempotency, derivation, and poll paths at real volume. It does not validate the Square catalog-ID mapping** — that needs sandbox/production catalog IDs, which this export does not have.

### First run

| Metric | Value |
| --- | --- |
| Lines read | 52,343 |
| Resolved | 42,705 (81.6%) |
| Unresolved | 9,638 (18.4%) |
| Ledger rows created | 42,705 |
| Deduped (already present) | 0 |
| Wall clock | 47.7s |

### Second run (same directory, no changes)

| Metric | Value |
| --- | --- |
| Lines read | 52,343 (identical) |
| Resolved / unresolved | identical to first run |
| Ledger rows **created** | **0** |
| Deduped (already present) | 42,705 |
| Wall clock | 83.6s |

Confirmed directly against the database, not just the CLI's own counters:

```
 ledger_rows | distinct_keys | locations
-------------+---------------+-----------
       42705 |         42705 |        14
```

42,705 rows, 42,705 distinct idempotency keys, zero duplicates after two full-volume runs.

### Derived on-hand, top 3 locations by sales volume (most negative = most sold; sale-only ledger, no intake recorded in this exercise)

| Location | On-hand |
| --- | --- |
| Chicago (Daley Plaza) | −6,519 |
| Denver | −5,092 |
| Boston (Snowport) | −4,418 |

### Largest unresolved buckets

| Count | Item | Price Point Name |
| --- | --- | --- |
| 4,189 | Scarf (Stripes) | Regular |
| 1,787 | Headband | Regular |
| 838 | Handmade Alpaca Yarn Toy | Regular |
| 588 | Cape | Regular |
| 557 | Wrap | Regular |
| 393 | Slippers | Regular |
| ~700 (combined) | Matched Set (3 variants) | Just Arm-Warmers / Just Hat / Just Scarf / Whole Set |
| 144 | Socks (Dress) | XL |
| ~200 (combined) | Hat (Russian Style) | Beige/Tan / White / Brown |

The single largest bucket, "Scarf (Stripes)"/"Regular" (4,189 lines, ~44% of all unresolved lines), is a genuine cross-category name collision, not a code defect: the warehouse catalog contains both `Standard Scarves | Stripes` and `Sport Socks | Stripes`, and the matcher (no stemming, token-overlap only) ties between them on the shared token "stripes" — "Scarf" and "Scarves"/"Socks" share no tokens to break the tie. Investigated directly rather than assumed; see Concerns below.

## 5. Deviations

- **Added `unplugin-swc` + `@swc/core` as API devDependencies, wired into `apps/api/vitest.config.ts`.** Not in the plan's file list. Required because NestJS's DI resolves constructor dependencies from `emitDecoratorMetadata` output, which esbuild (Vitest's default TS transform) does not emit — booting a real `NestApplication` under test (needed to prove the raw-body/signature wiring end to end, not just unit-test the pure signature function) silently failed to resolve *any* provider with a dependency. This is NestJS's own documented fix for testing under Vitest, not a workaround specific to this code.
- **Added a `SQUARE_WEBHOOK_NOTIFICATION_URL` env var** (falls back to `http://localhost:${API_PORT}/square/webhook`). Not in the plan's or `.env`'s listed Square vars, but the HMAC signature is computed over the *registered* notification URL, which has to come from somewhere. Production deployment needs this set to the real public webhook URL.
- **Refund/return lines map to `type: 'SALE'` with positive quantity**, not `CORRECTION`, per spec §7.1's literal wording ("write correcting SALE events with positive quantity and a distinct idempotency key"). The plan prose alone ("a positive correcting event") could be read as `CORRECTION`; I followed the more specific spec text.
- **Season replay upserts `Location` rows by exact name** (kind `MARKET`, placeholder timezone `America/New_York`) the first time each market name is seen in the CSVs. The database had **zero** `Location` rows before this work at all — not a byproduct of the "no catalog IDs" gap, just that no prior plan had seeded markets yet. A real seed step with correct per-market timezones/season dates (spec's per-market calendar) should replace this before treating these rows as authoritative.
- **Did not re-run `cli:assign-families` / `cli:generate-skus`** when reconstructing the real catalog after the test suite's `TRUNCATE` (see below). Neither touches `Variation.colourFamilyId`/`sizeOptionId` — only `ColourVariant` (warehouse tier) and SKU strings — which is what the replay's name resolution actually depends on, so skipping them doesn't affect the replay's resolution rate. `cli:assign-families` also hit a pre-existing, unrelated idempotency bug (unique-constraint violation) when re-run against a freshly-reimported DB; not investigated further, out of this plan's scope.
- **`InboxWorker.processOne()` marks a row `processedAt` even when some of its lines dead-letter**, recording the dead-letter detail as JSON in the row's `error` column, rather than leaving the whole row permanently unprocessed. Reasoning: the mappable lines are already safely in the ledger, and retrying can't invent a `Variation` that doesn't exist — so "leave it in the retry queue forever" would just retry a no-op forever. This is a judgment call beyond the plan's literal text; documented in the code.

## 6. Concerns

- **Season replay resolves 81.6% of lines.** The dominant unresolved cause (see §4) is a genuine cross-category name collision the reused matcher cannot break without stemming ("Scarf" vs "Scarves"/"Socks"). A second, smaller pattern: several item groups' unresolved lines all carry Square's generic `"Regular"` price-point name against a warehouse catalog that has *multiple* size/colour variations for that item group — a many-to-one relationship no name-only match can resolve. Both are exactly the kind of gap the plan anticipates without real catalog IDs, but they're real and worth a human's attention before this number is treated as more than a volume/idempotency proof.
- **The database's current state is the season-replay's state**, not a "tests plus replay coexisting" state. `seedDevCatalog`'s `TRUNCATE` runs on every `vitest` invocation; running `pnpm test` again now would wipe the 42,705 replayed ledger rows and the 14 just-created `Location` rows. This is documented, expected behaviour per the plan, not a bug — flagging it so it isn't a surprise to whoever opens the DB next.
- **`InboxWorker`/`PollService` re-query every `Variation`/`Location` with a non-null Square ID on each `processOne()`/`pollLocation()` call**, no caching across calls. Fine at the current catalog size (96 variations, 14 locations); worth revisiting if either grows substantially, since it's a full-table scan per poll tick.
- **Locations exist now only because the replay CLI created them.** Their timezones are a placeholder (`America/New_York` for all 14), not the real per-market values spec §1 describes (Boston opens Nov 7, Denver closes Dec 24, etc.). Anything downstream that reads `Location.timezone` or `seasonStart`/`seasonEnd` should not trust these rows yet.

## 7. Test summary

54 API tests (9 spec files) + 8 shared-package tests, all passing. New this plan: `square-ingest.spec.ts` (8 tests: pure mapper ×3, `InboxWorker.processOne` ×2, webhook HTTP ×3), `square-poll.spec.ts` (3 tests: self-heal, cursor-advance semantics, `pollAll`), `season-replay.spec.ts` (2 tests: idempotent double-run on a hand-built fixture, refund sign/source assertions).
