# Decision: flat-item migration and two-dimension restructure

**Date:** 2026-08-19
**Status:** Accepted
**Evidence:** `prototypes/` test suite, run against Square sandbox (`square@43.2.1`)
**Implements the gate in:** spec §8.3

## Question

Does converting a flat Square item to a variation-structured item orphan its
sales history, and how should items that already carry a size dimension be
restructured?

Behind that question sits the project's headline value: a $2.9M season of sales
history across 14 US market locations, and the year-over-year comparison the
client reads off it. Spec §8.2 names the trap — converting a FLAT item to a
variation-structured item is a restructure, not an edit — and §8.3 makes the
prototype a blocker gate.

**This record closes the sandbox half of that gate, and only that half.** The
data-model question — does the migration orphan sales history — is answered, with
a negative control proving the detector genuinely detects. The reporting question —
does Square's *Item Sales* report still aggregate those lines under the item
afterwards — is **not** answered, could not be answered programmatically in sandbox,
and remains a gate. §8.3 step 5, one live low-volume item, is still outstanding.
Read "What is still unknown" before quoting anything from here.

## What was tested

Six test files, 12 tests, every one hitting the live Square sandbox through
`square@43.2.1`. No mocks anywhere in the suite. Ten of the twelve tests are
genuine round trips through Square's API; the two exceptions are the
`assertSandbox()` guard tests, which mutate an env var locally to exercise the
throw path and make no API call.

| File | Tests | What it asserts |
| --- | --- | --- |
| `prototypes/src/connectivity.test.ts` | 4 | `assertSandbox()` genuinely throws when `SQUARE_ENV` is not `sandbox` and when `SQUARE_APPLICATION_ID` does not start with `sandbox-` (the throw path is exercised, not just the values re-read); a location is listed; the catalog reads back as an array after an explicit `assertNoErrors` check. |
| `prototypes/src/seed.test.ts` | 1 | `seedFlatItem(name, priceCents, orderCount)` creates a real flat ITEM with exactly one variation named `Regular` and drives real orders against it to `COMPLETED`. This is the fixture the gate is measured on — a genuinely flat item with genuine sales. |
| `prototypes/src/verify.test.ts` | 3 | Seeded orders resolve back to their catalog objects; a never-existing object ID reports absent; **the negative control** — a variation that existed, *carried a completed order*, and was then deleted via `catalog.object.delete` reports absent. |
| `prototypes/src/migrate-a.test.ts` | 1 | **The gate.** After `migrateFlatToVariations(itemId, ['Blue','Green','Multi'], 6500)` on a seeded flat item with 3 completed orders: `item_id` unchanged; the legacy variation ID unchanged, still live, still resolving to the same `item_id`; all 3 historical order lines still resolve to a live catalog object; the item now carries `Blue`, `Green`, `Multi` and `Unspecified (pre-2026)` and no longer carries `Regular`; and — fetched **directly by its pre-migration ID**, not via the item's name list — the legacy object itself carries `name: 'Unspecified (pre-2026)'` and `sellable: false`. |
| `prototypes/src/overrides.test.ts` | 1 | A per-location price override ($165.00 base → $177.00 at a second location, mirroring the real Carmel premium on `Cape`) is set on the legacy variation, asserted present **before** the migration, and asserted still present **after** it. Plus the F9 block: every newly created colour variation is read back and asserted to have `locationOverrides` `{}`, `presentAtLocationIds` `undefined`, and `presentAtAllLocations` `true`. |
| `prototypes/src/migrate-b.test.ts` | 2 | Item-per-pattern: 4 items created, `entriesPerItem` **measured from Square's own upsert responses**, each item's variation names equal `['Small','Medium','Large','XL']`, and every new item and variation read back and asserted to carry no location data. In-place expansion: the 4 seeded order lines still bind to their specific seeded variation IDs and those objects are still live, and `entryCount` is measured from Square's response. |

Two facts about the *method* matter as much as the results, because without
them the headline answer would not be trustworthy:

**The detector was proved to detect.** `catalogObjectExists()` is the signal the
gate turns on. If Square returned deleted objects as still existing, the gate's
"history survived" result would have passed whether or not it was true. The
negative control settles it empirically: `catalog.object.get` on a deleted
catalog object **throws a 404 `SquareError`** with
`errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND' }]` — byte-for-byte
identical to an ID that never existed. There is no `isDeleted: true` resolve path
at this API layer. This holds equally for a deleted variation that had a completed
order against it: same 404, no special handling by Square. `catalogObjectExists`
needed no hardening.

**The relabel is bound to the object that carries the history.** An earlier
version of the migration test checked only that `Unspecified (pre-2026)` appeared
*somewhere* in the item's variation-name list. That passes even under the failure
mode this whole approach exists to avoid: rename the legacy variation to `Blue`
and add `Unspecified (pre-2026)` as a fourth, brand-new variation — every
historical sale silently relabelled as blue. The test now fetches the legacy
variation by its pre-migration ID and asserts `name` and `sellable` on that
object. This was verified by mutation: the mislabel bug was reproduced in
`migrate-a.ts`, the new assertion failed against it
(`expected 'Blue' to be 'Unspecified (pre-2026)'`) while all four earlier
assertion groups still passed, and the mutation was then reverted.

## Results

Full suite, run 2026-08-19 immediately before this record was written. Verbatim,
except that the `[harness]` stdout lines have been elided — the per-variation
location-data dump from `migrate-b.test.ts` (reproduced in substance in the table
below) and `connectivity.test.ts`'s `RUN_ID` and sandbox ITEM count of 61. Nothing
failing or contradictory was trimmed:

```
$ cd prototypes && pnpm test

> winterborn-prototypes@ test /Users/mac/Desktop/CurrentProjects/winterborn/prototypes
> vitest run

 RUN  v2.1.9 /Users/mac/Desktop/CurrentProjects/winterborn/prototypes

 ✓ src/migrate-b.test.ts (2 tests) 21015ms
   ✓ Prototype B: two-dimension items > item-per-pattern keeps each till list to the size count 6619ms
   ✓ Prototype B: two-dimension items > expanding in place preserves history but breaches the entry ceiling 14395ms
 ✓ src/overrides.test.ts (1 test) 7029ms
   ✓ Prototype A: per-location price overrides survive migration > keeps the override on the legacy variation after restructure 7028ms
 ✓ src/verify.test.ts (3 tests) 11172ms
   ✓ verification helpers > resolves seeded orders back to their catalog objects 7384ms
   ✓ verification helpers > reports a non-existent catalog object as absent 356ms
   ✓ verification helpers > reports a genuinely deleted catalog object as absent (negative control) 3432ms
 ✓ src/migrate-a.test.ts (1 test) 12822ms
   ✓ Prototype A: flat item to colour variations > preserves item_id, keeps history resolvable, and adds colour variations 12821ms
 ✓ src/connectivity.test.ts (4 tests) 892ms
   ✓ sandbox connectivity > lists at least one location 477ms
   ✓ sandbox connectivity > can read the catalog 413ms
 ✓ src/seed.test.ts (1 test) 8121ms
   ✓ seedFlatItem > creates a flat item with one variation and orders against it 8120ms

 Test Files  6 passed (6)
      Tests  12 passed (12)
   Start at  11:56:28
   Duration  64.82s (transform 54ms, setup 0ms, collect 2.64s, tests 61.05s, environment 0ms, prepare 186ms)
```

Assertion by assertion:

| Assertion | Result | Where |
| --- | --- | --- |
| `item_id` preserved across the migration | **PASS** — `result.itemId === seeded.itemId`. Square never issued a new item ID; the write is a read-modify-write on the existing ITEM object. | `migrate-a.test.ts` |
| Legacy variation preserved, not deleted | **PASS** — `result.legacyVariationId === originalVariationId`, `catalogObjectExists(originalVariationId) === true`, `resolveVariationToItem(originalVariationId) === seeded.itemId`. | `migrate-a.test.ts` |
| Historical order lines still resolve to a live catalog object | **PASS** — all 3 lines re-read after migration, each `catalogObjectExists(line.catalogObjectId) === true`. | `migrate-a.test.ts` |
| Legacy variation honestly relabelled and taken out of sale | **PASS** — on the object fetched by its pre-migration ID: `name === 'Unspecified (pre-2026)'`, `sellable === false`. | `migrate-a.test.ts` |
| The detector genuinely reports a deleted object as absent | **PASS** — a deleted, order-referenced variation 404s. | `verify.test.ts` (negative control) |
| Per-location price override survives on the legacy variation | **PASS** — `{ L1Y8D6MP72WPT: 17700 }` before the migration, `{ L1Y8D6MP72WPT: 17700 }` after. Genuine two-location sandbox: `locations.create` succeeded, so this is a real multi-location result, not a single-location fallback. | `overrides.test.ts` |
| New colour variations carry the override forward | **FAIL — by design, and this is the most consequential finding here.** On every new variation: `itemVariationData.locationOverrides` is **absent** (`undefined` on the wire; the prototype's `getVariationOverrides()` helper normalises that to `{}`, which is a helper artefact, not an API shape — see Consequences item 6 for the real field), `presentAtLocationIds` is `undefined`, `presentAtAllLocations` is `true`. See "Consequences for Plan 3" item 2. | `overrides.test.ts` |
| Item-per-pattern entries per item | **4**, measured from `itemData.variations.length` on each of the 4 upsert responses, with all four per-item counts asserted equal before the figure is returned. Fixture: 4 patterns × 4 sizes. Under the 16 ceiling. | `migrate-b.test.ts` |
| In-place expansion entries per item | **20**, measured from Square's upsert response (`4 original size entries + 4 patterns × 4 sizes`). Over the 16 ceiling. | `migrate-b.test.ts` |
| History survives in-place expansion | **PASS** — all 4 seeded order lines still bind to their specific seeded variation IDs and each of those objects is still live. | `migrate-b.test.ts` |

**One precision point, recorded so it is not over-read.** In the history tests,
the load-bearing check against silent orphaning is
`catalogObjectExists(line.catalogObjectId)`, not
`line.catalogObjectId === seeded.variationIds[i]`. An order line's
`catalogObjectId` is immutable data captured at order-creation time and stored on
the order; it would not change as a side effect of a later catalog mutation
regardless of whether that mutation orphaned anything. The equality check
documents *which* variation each line was seeded against and rules out a
test-setup mix-up; the existence check is what proves the referenced object is
still live afterwards. Both are kept, and the gate rests on the second.

**Extrapolation to the real catalog, stated as arithmetic, not as a measurement.**
The measured fixture was 4 patterns × 4 sizes. The real Footwear case in §8.6 is
12 Sport Sock patterns × 4 sizes. Item-per-pattern measures
`entriesPerItem = sizes.length` independently of pattern count, so 12 patterns
gives 12 tiles of **4 entries each** — still 4, still under 16. In-place expansion
scales as `patterns.length × sizes.length + existing.length`, so 12 patterns gives
**52 entries** on one item. The 12-pattern case was not itself re-run against the
sandbox; 4 and 20 are the measured numbers, 4 and 52 are the projection from the
measured formulas.

## Decisions

1. **Flat to colour variations: read-modify-write the existing ITEM object,
   preserving `item_id`. Never delete the original variation.** `catalog.object.get`
   the item, spread it forward, and `catalog.object.upsert` it back with the same
   `id`. Create-new-and-archive-old is rejected: it was never needed, and it is the
   approach that orphans history.
2. **The legacy variation is relabelled, not reused.** Rename it to
   `Unspecified (pre-2026)`, set `sellable: false`, keep `stockable: true`, and keep
   its ID untouched. Renaming it to a colour would silently mislabel every historical
   sale as that colour, which is worse than orphaning because it looks correct.
   Deleting it orphans every order line that references it — proven by the negative
   control, which shows a deleted variation reads as absent even when an order
   points at it.
3. **Every catalog write is read-modify-write.** Constructing an item or variation
   from scratch drops `locationOverrides` and `present_at_location_ids`. The override
   in the prototype survived precisely because the shallow spread of
   `legacy.itemVariationData` never touches that key. Any code path that builds an
   object literal instead of spreading the fetched one loses whatever it did not
   think to set. This is spec §7.3's highest-consequence rule and the prototype is
   the reason it can be stated as proven rather than assumed.
4. **Two-dimension items: item-per-pattern.** Measured 4 selectable entries per item
   against a measured 20 for in-place expansion, on the same 4 × 4 fixture, against a
   binding ceiling of 16. In-place expansion breaches the ceiling on a fixture
   smaller than the real one and gets worse with every pattern added. Item-per-pattern
   also matches a convention already live in this account — Scarves is already
   item-per-design (`Scarf (Stripes)`, `Scarf (Plaids)`, …). Per §8.6, retain the
   existing `Socks (Sport)` item as the *Standard* pattern so its trading record
   stays intact, and create new items only for the other eleven patterns.
5. **Entry ceiling: selectable entries per item stays at or below 16.** Asserted in
   the suite (`expect(result.entriesPerItem).toBeLessThanOrEqual(16)`), and the
   in-place path is rejected on exactly this rule
   (`expect(result.entryCount).toBeGreaterThan(16)` — 20).
6. **Per-location overrides must be explicitly captured and reapplied to new
   variations.** The migration preserves the override on the legacy row and gives
   the new rows none. This is not a defect to be fixed in the prototype; it is a
   required step in the production script. See "Consequences for Plan 3" item 2 —
   it is the single most consequential line in this document.
7. **The write path is the Catalog API, not a CSV round-trip.** Recorded honestly:
   §8.3 step 4 asked for a comparison of the two paths, and what happened instead is
   that one path was proven and the other was never exercised. The API path is
   proven end-to-end here — per-item, controlled, testable, and the only path that
   can do read-modify-write with field-level preservation. CSV round-trip import was
   not tested by any prototype and no claim is made about it. Do not use it.

## Consequences for Plan 3

Written for someone who cannot see the prototype code and cannot re-run anything.

1. **Migrate flat items by read-modify-write on the existing ITEM object.** Reference
   implementation — as evidence of the shape, not as code to lift; it does not
   typecheck, see item 9: `prototypes/src/migrate-a.ts`, `migrateFlatToVariations()`. Fetch,
   spread, relabel the single existing variation to `Unspecified (pre-2026)` with
   `sellable: false`, append the new variations, upsert with the same item `id`.
   Never `catalog.object.delete` a variation that has ever been sold.

2. **Read every variation's `locationOverrides` and `present_at_location_ids`
   BEFORE the migration, and write them onto the new variations AFTER it. Without
   this step the migration silently charges the wrong price at the till.**

   The prototypes are unambiguous on this, on both code paths, CI-asserted:
   - `migrate-a` (flat → colours): every new colour variation comes back with no
     `itemVariationData.locationOverrides` at all, `presentAtLocationIds` `undefined`,
     and `presentAtAllLocations` `true`. The override is preserved — on the
     now-unsellable legacy row, where no customer will ever hit it.
   - `migrate-b` (item-per-pattern): every new pattern item and every one of its
     variations comes back the same way — `locationOverrides` absent,
     `presentAtLocationIds` `undefined`, `presentAtAllLocations` `true`. This path is
     **sharper**: a new pattern item has no legacy row at all, so there is nowhere for
     the premium to survive even inertly.

   **Do not write this step from the prototype helper's return type.**
   `getVariationOverrides()` in `prototypes/src/locations.ts` returns a flattened
   `{ locationId: cents }` map purely so tests can assert on it, and an empty result
   reads as `{}` there. The real field is an array, and an absent one is `undefined`,
   not `{}`. The wire shape you must both read and write is in item 6 below — nobody
   can construct an override from a flattened map.

   The real catalog carries per-location overrides on **47 of 85 active rows**
   (spec §8.1, §7.3) — a systematic Carmel premium across most of the catalog plus a
   separate Boston (Snowport) set and two Denver anomalies, from a $2 uplift on socks
   to **$750 → $800 on `Cape (100% Baby Alpaca)`**. Migrating those rows without
   reapplying the overrides means customers at Carmel and Boston are rung up at the
   base price on exactly the variations they buy, on more than half the catalog,
   across all 14 markets, with nothing visibly wrong anywhere until someone reconciles
   takings. `catalog:verify` (§8.4) must re-read every migrated variation and assert
   the override map matches what was captured pre-migration, and the run must fail if
   it does not.

3. **Decide `present_at_location_ids` explicitly on every new variation.** Square's
   default for a from-scratch object is `presentAtAllLocations: true` — measured, not
   assumed. The real catalog's enablement is not uniform: 37 rows at all 14 locations,
   9 at 12, 3 at 13, 14 at exactly one location, and 8 at zero (§7.3). Inheriting
   "everywhere" by default will switch on items that are deliberately off, including
   the eight dead entries §8.5 intends to archive.

4. **Check `res.errors` after every Square call.** The SDK reports API-level failures
   in `res.errors` on a structurally successful response **without throwing**. Code
   that reads a field off such a response sees `undefined` and reports a misleading
   downstream error. The prototypes use a shared `assertNoErrors(res, context)` helper
   (`prototypes/src/client.ts`) after every single Square call and Plan 3 should carry
   the same discipline. This is not stylistic: without it, an auth or permissions
   failure inside `catalogObjectExists()` would have been indistinguishable from "the
   object was deleted", i.e. from the exact answer the gate exists to produce.

5. **Genuine HTTP errors throw, and they throw a different shape.** A 4xx from
   Catalog, Orders or Payments surfaces as a thrown `SquareError`, not as a populated
   `res.errors`. So both paths must be handled: `assertNoErrors` for the soft case,
   try/catch for the hard case. A missing catalog object is
   `statusCode === 404` with `errors[].code === 'NOT_FOUND'` and
   `category === 'INVALID_REQUEST_ERROR'` — and *only* that shape should ever be read
   as "absent". Everything else (auth, 429, timeout) must propagate.

6. **API surface facts, so they are not rediscovered:**
   - SDK: `square@43.2.1` (installed from `^43.0.0`). `SquareClient` and
     `SquareEnvironment` are named exports.
   - **Response-field asymmetry:** `catalog.object.get` returns the object at
     `res.object`; `catalog.object.upsert` returns it at `res.catalogObject`. Different
     field names for the same thing, on adjacent calls. `catalog.list` returns a `Page`
     exposing `res.data`, a different wrapper type from the `HttpResponsePromise` the
     other calls return.
   - **`Money.amount` is `bigint`**, on both request and response. Pass `BigInt(cents)`,
     never a plain `number`. `JSON.stringify` on any object containing one throws
     `TypeError: Do not know how to serialize a BigInt` — so debug logging of Square
     responses needs a replacer. This bites in logging code, not in the API call.
   - **`locationOverrides` is an array on `itemVariationData`**, not on the item and not
     at catalog-object level. Each entry is
     `{ locationId, priceMoney: { amount: bigint, currency: 'USD' }, pricingType: 'FIXED_PRICING' }`.
     **`pricingType` is required on each entry** — an override that omits it is not a
     fixed per-location price. When a variation has no overrides the field is **absent
     (`undefined`)**, not an empty array and not `{}`. Reapplying an override means
     writing this array back onto the new variation, preserving any entries for other
     locations: read the current array, filter out the entry for the location you are
     setting, append the new entry, upsert the whole array. That is what
     `setVariationOverride()` in `prototypes/src/locations.ts` does and it is the only
     safe pattern, because the upsert replaces the array wholesale.
   - **New objects are created with client-supplied temporary IDs, and this is the
     mechanic Plan 3 will use most.** Any object being created in an upsert must carry
     an `id` beginning with `#` (the prototypes use `#item_${RUN_ID}`,
     `#var_${RUN_ID}_${i}`, `#new_${RUN_ID}_${i}`, `#pat_${RUN_ID}_${p}_${i}`).
     A child variation references its not-yet-created parent by that same temp ID in
     `itemVariationData.itemId`, and Square resolves the reference server-side. Existing
     objects keep their real IDs — which is exactly how a read-modify-write migration
     preserves `item_id` and the legacy variation ID while adding new rows in the same
     call. On the response, `res.catalogObject` carries the persisted objects with their
     real server IDs (this is how every prototype recovers them), and the response also
     carries an `idMappings` array of temp-ID → server-ID pairs; the prototypes read the
     IDs off `catalogObject` rather than from `idMappings`, so `idMappings` is reported
     here as an SDK-typed field, not as something these tests exercised.
   - `ListCatalogRequest.types` is a comma-separated `string` (e.g. `'ITEM'`), not an
     array.
   - Order line items reference the **variation** ID in `catalogObjectId`, not the item
     ID. The item is reached via `itemVariationData.itemId`.
   - **Item IDs are not in the CSV export** (§8.1: the `Token` column is
     variation-level). They must be fetched via `ListCatalogObjects` /
     `SearchCatalogObjects` with `type=ITEM`.

7. **Orders cannot be created `COMPLETED`.** `orders.create` with
   `state: 'COMPLETED'` returns a 400 `CONFLICTING_PARAMETERS`
   ("Due Amount and Settled Amount were not zero-sum"). The working sequence is
   `orders.create` (omit `state`; it lands `OPEN`) → `payments.create`
   (`sourceId: 'cnon:card-nonce-ok'` in sandbox, default `autocomplete: true`), which
   both captures the payment and transitions the order to `COMPLETED` → optionally
   `orders.get` to confirm. Do **not** call `orders.pay` afterwards; it returns
   `BAD_REQUEST` "The order is already paid." Only relevant to test fixtures, but it
   cost time to discover and will cost it again otherwise.

8. **`migrateFlatToVariations` assumes exactly one existing variation and throws
   otherwise.** That is correct for the 14 flat Scarves items and every other single-
   `Regular` row, but the real catalog also holds already-structured items (Mittens
   styles, Beanie colours, Matched Set components). Plan 3 needs an explicit branch for
   those, and it is not covered by any prototype.

9. **The prototypes do not typecheck, so read them as evidence, not as a starting
   codebase.** `tsc --noEmit` fails on `seed.ts`, `verify.ts` and `migrate-a.ts`: the
   SDK's `CatalogObject` is a discriminated union on `type`, and the prototype code
   accesses `.itemData` / `.itemVariationData` without narrowing it first. There is no
   typecheck gate in `prototypes/package.json` — vitest transpiles with esbuild and
   never typechecks — so this was never surfaced by a passing run. Production code will
   be strict-mode, so every port of this logic needs explicit `type === 'ITEM'` /
   `type === 'ITEM_VARIATION'` guards that the prototypes never wrote.

10. **Use deterministic idempotency keys, not `randomUUID()`.** The prototypes generate a
   fresh UUID per upsert, which is fine for a throwaway run but defeats §8.4's
   requirement that `catalog:apply` be idempotent and resumable — a re-run after a
   partial failure would re-issue every write under new keys. This is a design note,
   not a measured finding: no prototype tested resumability.

11. **Verify Item Sales reporting on one live low-volume item before the bulk run**, per
    §8.3 step 5. See "What is still unknown" — this is the first thing Plan 3 does, not
    the last.

12. **Bulk-run order is unchanged** (§8.3 step 6): Scarves (29% of revenue) first, then
    Mittens, Socks, Stuffies, Capes/Wraps. Every apply preceded by a `catalog:plan` dry
    run whose diff has been read.

## What is still unknown

Each of these is something a prototype could not answer. None is a guess dressed as a
finding.

1. **Whether Square's Item Sales report still aggregates historical lines under the
   item once the legacy variation is `sellable: false`. This is the primary open
   risk and the first thing to verify in Plan 3.**

   What the prototypes prove is the **data-model** linkage: order lines still reference
   a live catalog object, that object still resolves to the same `item_id`, and the
   `item_id` never changed. What they do **not** prove is that Square's *reporting*
   layer — Item Sales, and any year-over-year export drawn from it — still attributes
   those lines to that item afterwards. That reporting layer is where the client's
   $2.9M year-over-year figure is actually read from, and §8.3 step 3 lists
   "Item Sales reports still aggregate correctly" as a required verification. It is
   Dashboard-only, so it could not be asserted programmatically without breaking this
   plan's own "assert programmatically, never visually" constraint, and no assertion in
   the suite touches it.

   **Confirmation plan:** at the start of Plan 3, once Joel's production token exists,
   migrate one live low-volume item and read the Item Sales report before and after.
   `Socks (Tech)` is the recommended subject — three sizes, currently enabled at zero
   locations (§8.1), so a mistake costs nothing. Do not begin the bulk run until this
   is confirmed and signed off. If it fails, the correct move is to design a different
   migration approach, not to proceed with a known-broken one.

2. **Whether `present_at_location_ids` survives a migration on the legacy row.** Only
   `locationOverrides` was asserted to survive. The seeded sandbox items were present at
   all locations, so there was never a non-default `presentAtLocationIds` on a legacy
   variation for the migration to preserve or drop. The same spread mechanism should
   carry it — but "should" is the honest word, and §7.3 requires preserving it. Assert
   it explicitly on the live-item test.

3. **Whether the new variations sell correctly on a real POS device**, and whether a
   `sellable: false` legacy row is genuinely hidden from the till grid rather than
   merely un-purchasable. §8.3 step 3 requires this; it is a physical-device check and
   no prototype can stand in for it.

4. **CSV round-trip import.** Never exercised. §8.3 step 4 asked for a comparison; what
   exists is proof for one path and silence on the other.

5. **Behaviour at scale.** Every prototype write is a single-object
   `catalog.object.upsert`. `BatchUpsertCatalogObjects` — which §7.3 names as the
   production call — was never used. No run hit a rate limit, so the 429 /
   `retry-after` backoff path in §7.3 is entirely untested. The sandbox merchant has 2
   locations, not 14, and the largest fixture was 4 items × 4 variations.

6. **The real catalog's shape.** Everything was measured on synthetic items seeded by
   the prototypes. No production or export-derived item was migrated. In particular the
   assumption that the 14 flat Scarves rows each carry exactly one variation is taken
   from the §8.1 export analysis, not from a migration attempt.

7. **The 12-pattern Footwear case itself.** Measured at 4 patterns × 4 sizes; the
   12-pattern figures in "Results" are projected from the measured formulas, not re-run.

8. **Interaction with tax rates, archived items, and the residual inventory cells**
   (§8.5). No prototype touched any of them. In particular, nothing here says what
   happens to the 17 non-zero `Current Quantity` cells (including negatives) when a
   variation is relabelled and taken out of sale.
