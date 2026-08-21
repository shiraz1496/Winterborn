# Catalog write-path guards -- report

**Branch:** `catalog-write-guards` (off `master`)
**Scope:** six safety guards around the existing plan → apply → verify Square
catalog write path, per the build guide. Sandbox only -- no production Square
token exists yet.

## What was built

**1. Backup before any write.** `apps/api/src/catalog/catalog-backup.ts`:
`backupCatalog(backupsDir)` exports every top-level catalog object (`catalog.list()`,
paginated) to `data/backups/catalog-backup-<timestamp>.json`. `assertFreshBackup(plan,
backupsDir)` throws unless the newest backup file's mtime postdates `plan.createdAt`.
Wired into `applyPlan` itself (not just the CLI) as the very first line -- a hard stop
that holds no matter which caller reaches `applyPlan`. CLI: `cli:catalog-backup`.

**2. Allowlist enforcement.** `catalog-plan.ts` gained `buildAllowlist(plan)` and
`assertObjectAllowed(id, allowlist, context)`, checked before every read/write in
`applyPlan` and `catalog-rollback.ts`. The substantive guard is a drift check: before
writing, `applyPlan` re-derives the item's *current* variation set from Square and
refuses to write if it carries any variation that is neither the reviewed legacy
variation nor a SKU the plan says it creates -- catching catalog drift between plan
and apply time, which the pre-existing code would otherwise have silently written
over (it replaced `itemData.variations` wholesale with only `[relabelledLegacy,
...newVariationObjects]`, dropping anything else on the item without comment).

**3. No deletes, ever.** `apps/api/src/catalog/square-client.ts`: right after
constructing the shared `square` client, `catalog.object.delete`, `catalog.batchDelete`,
and any `catalog.object.upsert` carrying `itemData.isArchived: true` are replaced with
functions that throw an explanatory error before any HTTP call. This is instance-level
(the SDK's getters cache their sub-clients, confirmed by reading the compiled SDK), so
it holds for every caller of this file's `square`, present and future, not just the
call sites this branch touches. `prototypes/src/client.ts` constructs its own,
separate, unguarded client and is untouched -- its negative-control test legitimately
deletes sandbox objects on a different code path.

**4. Stop on first failure.** `apps/api/src/catalog/catalog-migrate.ts`:
`runCategoriesSequentially(categories, runOne)` is a pure control-flow primitive
(no Square/Prisma dependency) that halts at the first category whose `runOne` returns
`ok: false` and never invokes the ones after it. `cli:catalog-migrate --categories
<list>` wires the real plan → apply → verify pipeline into it, still writing every
plan and result to disk for the record. Category names are **not** hardcoded --
the actual dev/sandbox DB's `Category.name` values (Footwear, Garments, Headwear,
Miscellaneous, Mittens, Scarves, Supplies, Toys) don't match the decision record's
conceptual grouping (Scarves, Mittens, Socks, Stuffies, Capes/Wraps) closely enough to
bake in; DEPLOY.md tells the operator to confirm real names with `SELECT name FROM
"Category"` before running.

**5. Rollback.** `apps/api/src/catalog/catalog-rollback.ts`: `rollbackPlan(plan)`
renames the legacy variation back to `item.originalLegacyName` (a new field on
`ItemPlan`, along with `originalLegacySellable`/`originalLegacyStockable`, captured by
`buildPlan` at plan time -- this is what the build guide meant by "the plan file must
therefore record" the original name) and "archives" every variation the plan added,
identified by SKU. **"Archive" here is not Square's `isArchived`** -- that field only
exists on `CatalogItem`, not `CatalogItemVariation`, and setting it on an ITEM is what
guard 3 forbids anyway. The equivalent used instead: `sellable: false`,
`presentAtAllLocations: false`, `presentAtLocationIds: []`. The object is never
deleted -- still resolvable, still holding whatever it held -- so nothing is destroyed
and a category could be re-migrated later. CLI: `cli:catalog-rollback --plan <file>`.

**6. Preflight.** `apps/api/src/catalog/catalog-preflight.ts`: `runPreflight(opts)`
checks, in order, `SQUARE_ENV` against the operator's stated intent (a required CLI
argument, not inferred -- the whole point is catching a mismatch between what the
operator meant and what the environment variable says), `oAuth.retrieveTokenStatus()`
for token validity and scopes (default required: `ITEMS_READ`, `ITEMS_WRITE`,
`INVENTORY_READ`, `INVENTORY_WRITE`, `ORDERS_READ`, `MERCHANT_PROFILE_READ`, matching
DEPLOY.md §4's "Catalog, Inventory, Orders, Merchants"), the visible location count
against an expected number, and backup presence. Prints a per-check PASS/FAIL table
and a single GO/NO-GO line. Every check is a read; safe to re-run any number of times.
CLI: `cli:catalog-preflight --expected-env <sandbox|production> --expected-locations <n>`.

## Sandbox rollback proof

`apps/api/test/catalog-guards.spec.ts`, `guard 5: rollback -- sandbox round trip`,
run against the live Square sandbox (no mocks, same convention as `prototypes/`):

1. Seeded a real flat ITEM (`RollbackProof <run-id>`, one `Regular` variation, $65)
   and one completed order against it.
2. Took a **real, full-catalog backup** via `backupCatalog()` before apply.
3. Built a plan by hand (bypassing Prisma -- see "Deviations" below), applied it
   (`applyPlan` → `status: 'applied'`), verified it (`verifyPlan` → `ok: true`,
   `failures: []`).
4. Rolled it back (`rollbackPlan` → `status: 'rolled-back'`, 2 variations archived).
5. Confirmed: the archived variations still resolve (`catalogObjectExists` → `true`
   for both -- nothing deleted); the legacy variation is back to name `"Regular"`,
   `sellable: true`; every other variation on the item is `sellable: false`; the
   historical order line still resolves to the same live catalog object; a second
   `rollbackPlan` call reports `already-rolled-back` (idempotent).
6. Diffed the live post-rollback state against the pre-apply backup file: the
   backup's snapshot of the item held exactly one variation, `"Regular"`, sellable,
   at $65.00; the live item post-rollback has exactly one *sellable* variation,
   same name, same price.

**Honest caveat on "matches the pre-apply backup":** this is a match on *sellable
state* -- what a cashier or a sales report would see -- not a byte-identical object.
Because guard 3 forbids deletion, the archived Blue/Green variations remain on the
item permanently after rollback; the backup had 1 variation, the live item has 3 (1
sellable + 2 archived). That's the real cost of "no deletes, ever" being genuinely
absolute, and it's the correct tradeoff -- an extra hidden, unsellable row is
recoverable data; a deleted one is not. The test asserts the comparison that's
actually true (sellable-state match) rather than a byte-identical one that would be
false by design.

## Test summary

19/19 tests in `apps/api/test/catalog-guards.spec.ts` pass, covering all five required
cases plus a basic preflight sanity check: apply refuses to run with no backup and
with a stale backup (guard 1, both unit-level on `assertFreshBackup` and integration-
level on `applyPlan` itself); apply refuses on a drifted/unreviewed object ID, proven
against a real sandbox item with an out-of-plan variation injected, and confirmed no
write occurred (guard 2); the delete guard throws for `catalog.object.delete`,
`catalog.batchDelete`, and an archiving upsert, all before any HTTP call, plus a
control test proving normal upserts still pass through (guard 3); category
sequencing halts at the first failure and never invokes the categories after it, and
runs all of them through when nothing fails (guard 4, pure logic, no Square/DB); and
the full sandbox round trip above (guard 5). Full existing `apps/api` suite (135
tests, 14 files) still passes with no regressions -- `catalog-verify`'s override-
enforcement logic (the property protecting pricing at 14 markets) was not touched.

Typecheck (`pnpm --filter @winterborn/api typecheck`) is clean.

## Deviations from a literal reading of the build guide

- **`applyPlan(plan, backupsDir?)` gained an optional second parameter.** The build
  guide describes `catalog-apply` checking for a fresh backup; I put the check inside
  `applyPlan` itself (called first thing, before any Square call) rather than only in
  the CLI, so the guard holds for `catalog-migrate`'s in-process loop and for tests
  too, not just the one CLI entry point. `backupsDir` defaults to the real
  `data/backups`; the only reason to override it is test isolation.
- **The sandbox rollback proof builds its `CatalogPlan` by hand rather than via
  `buildPlan(prisma, category)`.** `buildPlan` is the only function in this area that
  touches Prisma; `applyPlan`/`verifyPlan`/`rollbackPlan`/the backup functions do not.
  Constructing the plan object directly let the whole guard test suite run without
  touching Postgres at all -- deliberately, given the constraint below.
- **`cli:catalog-migrate` takes `--categories` as a required argument, not a hardcoded
  default.** The decision record's intended production order (Scarves, Mittens,
  Socks, Stuffies, Capes/Wraps) doesn't match this dev database's actual `Category`
  rows (Footwear, Garments, Headwear, Miscellaneous, Mittens, Scarves, Supplies,
  Toys) closely enough to bake in as a default without risking a wrong, silent
  category name at the real cutover. DEPLOY.md tells the operator to confirm real
  names first.
- **Guard 3 also blocks archiving via `isArchived: true` on upsert**, which the build
  guide's wording ("a delete or archive call") implies but doesn't spell out as a
  separate mechanism from `catalog.object.delete`. Square's catalog API has no
  standalone "archive" endpoint -- archiving an ITEM is done through the same upsert
  call the migration legitimately uses, so it has to be inspected per-call rather than
  blocked at the method level the way delete is.

## A real bug this work found and fixed (not part of the original brief)

Before this branch, `applyPlan` fetched the item's *current* variations, then
unconditionally overwrote `itemData.variations` with `[relabelledLegacy,
...newVariationObjects]` -- silently dropping any variation on the item that wasn't
the one legacy variation the plan expected, with no error, no log line, nothing. If
the catalog drifted between `catalog-plan` and `catalog-apply` (another process added
a variation, or the flat-item assumption from `buildPlan` turned out to be stale),
this would have quietly deleted data through a plain upsert -- exactly the failure
mode guard 3 is designed to prevent, reached by a different door. Guard 2's drift
check closes it. Proven with a real sandbox test (`guard 2` describe block): an
out-of-plan variation injected onto a seeded item, `applyPlan` refuses with a named
error, and a re-fetch confirms the item is untouched.

## A note on the dev database

Running the full `apps/api` test suite (`pnpm test`) truncates and reseeds the
catalog/ledger tables via `seedDevCatalog` on every DB-touching spec's `beforeEach`
-- pre-existing, documented behavior of this repo (see
`.superpowers/sdd/2026-08-21-seed-and-catalog/task-4-5-report.md`, item 4), not
something introduced here. Running it once during this work (to confirm no
regressions) dropped `LedgerEvent` to 3 rows. Restored via the same pipeline that
report documents: `cli:import-sortly` → `cli:assign-families` → `cli:generate-skus` →
`cli:join-square` → `cli:replay-season --dir data/square-2025/item-detail`. The
replay reported `resolved: 42705, ledger rows created: 42705` -- an exact match for
the row count named in the task brief. `LedgerEvent` now holds 42,708 rows (42,705
replayed + 3 pre-existing test-fixture rows also present before this branch's work
started); `ItemGroup` holds 53 rows (vs. 52 in the cited prior report -- no duplicate
names found, not investigated further given the exact ledger-count match). The new
`catalog-guards.spec.ts` test file itself never touches Prisma/Postgres, specifically
so re-running it during this work would not repeat the truncation. `prisma migrate
reset` was never run.

## Concerns for whoever runs this against production

1. **The category-name mapping is still unresolved.** `cli:catalog-migrate` will
   reject a wrong category name loudly (`buildPlan` throws if `ItemGroup.findMany`
   with that category comes back empty... actually it returns an empty plan, not a
   throw -- worth a human noticing "0 items touched" rather than assuming success).
   Confirm real category names before the bulk run.
2. **Preflight's required-scope list is my best inference from DEPLOY.md's prose**
   ("Catalog, Inventory, Orders, Merchants"), not verified against an actual
   production token, since none exists yet. If Joel's issued token reports different
   scope strings, `--expected-env`/scope check will false-negative; the fix is a
   one-line override, not a code change, but it should be checked once a real token
   exists.
3. **§8.3 step 5 (Item Sales report reconciliation on one live low-volume item) is
   still the actual first gate**, per the decision record's "What is still unknown"
   section -- restated in DEPLOY.md §9. Nothing in this branch can satisfy it; it's a
   Dashboard-only check.
4. **The allowlist/drift guard only inspects variation IDs and SKUs, not every
   field.** It would not catch, for example, the legacy variation's price having
   changed out from under the plan between plan and apply (only that the variation
   set is what was reviewed). That's a narrower guarantee than "nothing about this
   item changed since the plan was built" -- worth knowing, not fixed here since it
   wasn't in scope.

## Files touched

- `apps/api/src/catalog/square-client.ts` (guard 3, monkeypatched onto the shared client)
- `apps/api/src/catalog/catalog-plan.ts` (guards 1 + 2 wired into `applyPlan`; `ItemPlan` gained `originalLegacyName`/`originalLegacySellable`/`originalLegacyStockable`)
- `apps/api/src/catalog/catalog-backup.ts` (new -- guard 1)
- `apps/api/src/catalog/catalog-rollback.ts` (new -- guard 5)
- `apps/api/src/catalog/catalog-migrate.ts` (new -- guard 4)
- `apps/api/src/catalog/catalog-preflight.ts` (new -- guard 6)
- `apps/api/src/cli/catalog-backup.ts`, `catalog-rollback.ts`, `catalog-migrate.ts`, `catalog-preflight.ts` (new CLIs)
- `apps/api/package.json` (four new `cli:*` scripts)
- `apps/api/test/catalog-guards.spec.ts` (new -- 19 tests)
- `docs/DEPLOY.md` (new §9, production runbook)
