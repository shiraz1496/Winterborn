# SDD ledger — plan: docs/superpowers/plans/2026-08-21-seed-and-catalog.md

Spec: docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md
Authority on migration behaviour: docs/superpowers/decisions/2026-08-19-flat-item-migration.md
Branch: plan-03-seed-and-catalog. Plan 2 merged to master at c59c140.

## Pre-flight scan

| Producer | Consumer | Produces -> Consumes | Finding |
|---|---|---|---|
| T1 | T2-T5 | ledger FKs, recomputeByVariant, wider CI guard | agree, no downstream coupling |
| T2 sortly-parser | T3,T4 | ParsedSortlyItem, ColourVariant/WarehouseVariant rows | agree |
| T3 family-assigner | T4 | ColourFamily rows + assignments | agree, tillSku needs family names |
| T4 sku | T5 | tillSku/warehouseSku on rows | agree |
| T5 square-join | none | ItemGroup.squareItemId, plan/apply/verify | agree |

Per-task self-consistency: T1 code matches the existing LedgerReadService shape; T2-T5 tests
match the code they specify. Expected import totals cross-checked against the analysis of the
real files (585 rows = 564 items + 21 folders, 50 groups, 248 colours, 42,428 units, 96 zero-qty,
41 min levels, 6 prices, 559 photos).

## Process (speed adjustment, standing)
- Fix rounds for Critical and Important only. Minors logged and surfaced.
- No re-testing of framework or database guarantees.

## Task log
Task 1: BASE (see below)
Task 1: BASE 8843a7a, implemented at 89cb54b (13/13 tests). Review: spec OK, 1 Critical + 1 Important.
  Confirmed good: recomputeByVariant genuinely independent (raw SQL vs Prisma groupBy, neither
  calls the other); property test asserts both granularities against the SAME generated history
  with the same seeded LCG, normalising on warehouseVariantId so the two variants cannot collapse;
  orphan test exercises a real P2003 since append() only special-cases P2002; actorId left bare
  with the explanatory comment.
F1. CRITICAL. Prisma's implicit referential actions shipped as
    warehouseVariantId ON DELETE SET NULL, variationId ON UPDATE CASCADE.
    SET NULL is implemented by Postgres as a generated UPDATE against LedgerEvent, which fires
    the append-only trigger (no WHEN clause excludes FK-originated updates). So the delete IS
    blocked today -- but by a mechanism designed for something else, surfacing an error about an
    UPDATE on LedgerEvent in response to a DELETE on a different table.
    Two reasons that cannot ship: (a) anyone disabling just that trigger for a one-off backfill
    re-enables the silent path; (b) if it ever succeeded it is PERMANENT corruption, because
    warehouseVariantId being null is precisely what distinguishes a family-level SALE from a
    variant-level movement, and append-only means no UPDATE can repair it.
    Ruling: explicit onDelete: Restrict and onUpdate: Restrict on BOTH relations. A
    WarehouseVariant with ledger history should be exactly as undeletable as a Variation with
    ledger history, failing with a clean FK violation.
    Cost if wrong: a legitimate variant deletion needs a deliberate migration, which is the
    correct friction.
F2. Important. The widened CI guard excludes ledger-append.spec.ts WHOLE-FILE rather than the
    two lines that legitimately prove the trigger. That file grows next plan with webhook and
    poll tests, exactly where someone adds a convenience ledgerEvent.create fixture.
    Ruling: narrow to those two calls, either by moving them to their own spec or by an inline
    marker. Cost if wrong: the sole-writer guard is blind to a growing file.
Task 1: fix round 1/5 dispatched (F1, F2)
Task 1: fix round 1/5 (2 addressed, 0 open — F1 both relations now ON DELETE RESTRICT ON UPDATE
  RESTRICT, verified in the generated SQL and against pg_constraint, with doc comments explaining
  the real mechanism; RestockRequestLine's parallel relations fixed the same way unprompted.
  F2 guard narrowed to a same-line marker; reviewer independently reproduced the regression check
  by injecting an unmarked createMany, confirmed it was caught, and restored the file clean.
  Commits 89cb54b..bd734c7)
  Reviewer agreed with editing the applied migration in place plus migrate reset: created in the
  immediately preceding commit of the same task, branch has no remote, no other environment could
  have applied the old checksum. Correctly scoped as not-a-general-practice.
Task 1: complete (8843a7a..bd734c7, review clean). 13/13 api, 8/8 shared.

Task 2: BASE bd734c7, implemented at bdca39a. 23/23 tests.
  ALL EIGHT EXPECTED TOTALS MATCHED EXACTLY against the real export: 585 rows = 564 items +
  21 folders, 50 groups, 248 colours, 42,428 units, 96 zero-qty, 41 min levels, 6 prices,
  559 photos. Import run twice, second run created 0 rows across all 7 models.
  Two real bugs found while validating against the real file and fixed before commit:
  a duplicate-SID merge that could null out a real price, and a create-once-only photo write.
  One divergence to assess at review: 52 persisted ItemGroup rows vs 50 distinct group names,
  because 2 real rows have a blank Item Group Name and fall back to their own Entry Name.
PROCESS CHANGE (user request, standing): speed over ceremony. No task reviews except where a
silent bug is expensive. Fix rounds for CRITICAL only. Batch remaining tasks. Spot-check outputs
directly instead of dispatching reviewers.

Task 2: review found 1 Critical + 2 Important + 1 Minor. Fix round dispatched for all four
  (the Critical is real client data committed in a test fixture: the client's business name
  "BarHaus (IN STOCK)" on all 12 rows plus 5 real product-line names and 2 real attribute values,
  while the report claimed the fixture was hand-authored).
  Ruling on remediation: fix forward, do NOT rewrite git history. No remote exists, nothing left
  the machine, and the exposure is product names rather than credentials or sales figures.
  Rewriting history mid-sequence adds more risk than it removes.
Task 3: complete at b0c4f41. Spot-checked directly rather than reviewed.
  Family distribution: Blue 60, Gray 39, Brown 33, Red 28, Purple 27, Black 22, White 20,
  Cream 18, Green 18, Pink 17, Multi 10, Orange 4, Unassigned 74.
  The reported "residual 18" was distinct colour VALUES; the DB holds 74 unassigned VARIANTS.
  Inspected the residual list: the large majority are not colours at all. They are Toys style
  values (Alpaca (Large), Bear (Medium), Koala, Reindeer, Unicorn, Highland Coo...) and sock
  pattern groups (Sport Socks | Floral, | Star Pattern, | Stripes), which genuinely have no
  colour. Schema requires WarehouseVariant.colourVariantId, so items with no colour get a
  variant named after their style. Leaving these Unassigned is CORRECT; forcing them into a
  colour family is the confidently-wrong-data failure the whole design guards against.
  Deliberate under-coverage of mint/chocolate/gold to avoid the "Mint Chocolate Chip" over-reach
  trap is a defensible call: better a human assigns 5 values than the algorithm splits a dessert
  name into two colours.
  Photos: 512 of 559 archived. 47 failures not investigated, noted.
Task 3: minor (deferred): "Sport Socks | Black Solid 2025" leaks a group name into the colour
  field. Source data quality, not a parser bug.
Tasks 4+5: BATCHED into one dispatch, no review.
Task 2: F3 CRITICAL fixed by the controller, not a subagent. The dispatched fix agent vanished
  without completing, and this was real client data sitting in a committed file, so I did the
  edit directly rather than re-dispatch: 12-row CSV, unambiguous, and speed was the standing
  instruction. Business name and all real product-line and attribute values replaced with
  invented equivalents; row SHAPES preserved so every parser behaviour under test still runs.
  Two spec assertions realigned. 41/41 api + 8/8 shared green. Verified no committed file
  outside data/ and docs/ contains a real client string.
  F4, F5, F6 (test coverage for the two import bugs, two vacuous parser assertions, silent
  ItemGroup fallback warning) NOT done -- Important, not Critical, deferred under the standing
  speed instruction.
Tasks 4+5: complete at 8cfe1a7 and 0a8641e. No review, spot-checked directly.
  SKUs: 96 till, 517 warehouse, ZERO collisions at both levels. Real tie-break exercised
  (Sport Socks | Standard vs | Star Pattern both reducing to STA, resolved STA / STAR).
  Join: 16 clean matches persisted, 11 ambiguous groups withheld (13 candidate pairs, including
  a genuine many-to-one where two Sortly groups both score 0.67 against one Square item),
  25 unmatched Sortly, 24 unmatched Square. Withholding rather than forcing is correct.
  plan/apply/verify ran end to end against sandbox, and verify was demonstrated FAILING when
  overrides were missing, which is the property that protects pricing at 14 markets.
PLAN 3 COMPLETE. 7 commits, 49 tests.
