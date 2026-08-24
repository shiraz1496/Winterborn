# SDD ledger — plan: docs/superpowers/plans/2026-08-20-foundation-and-ledger.md

Spec: docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md
Prior: docs/superpowers/decisions/2026-08-19-flat-item-migration.md (Plan 1, merged)
Branch: plan-02-foundation-ledger

## Pre-flight scan

| Producer | Consumer | Produces -> Consumes | Finding |
|---|---|---|---|
| T1 PrismaService | T2,T4,T5 | PrismaService, PrismaModule | agree |
| T2 schema | T4,T5 | all Prisma models + enums | agree |
| T2 seed-dev.ts | T4,T5 | seedDevCatalog -> DevSeed{warehouseId,denverId,variationId,otherVariationId,warehouseVariantId,otherWarehouseVariantId} | agree, all six fields used |
| T3 shared | T4,T5 | appendEventInputSchema, transferInputSchema, AppendEventInput, TransferInput, StockLevel | agree |
| T4 LedgerService | T5 tests | append(), transfer() | agree |
| T5 LedgerReadService | none | onHandByFamily/ByVariant/For/recompute | agree |

Per-task self-consistency: T1 no test cycle by design (scaffold verified by build+connect);
T2 no per-model tests by design (Prisma/Postgres guarantee constraints; models exercised by
T4/T5); T3,T4,T5 tests match the code they specify.

Two plan bugs found and fixed BEFORE execution:
  P1. AppendEventInput/TransferInput were z.infer (output type). transferInputSchema has
      .default('DISPATCH') and coerced dates, so T5's tests that omit `type` or pass a string
      date would have failed typecheck. Changed to z.input.
  P2. recompute()'s raw SQL wrapped the table in a subquery with ORDER BY before a SUM, which
      does nothing. Removed. The genuine difference from onHandByFamily is raw SQL vs Prisma
      groupBy, which is what makes the two-implementation check meaningful.

## Process for this plan (speed adjustment, user request)
- Fix rounds for Critical and Important findings ONLY. Minors are logged and surfaced.
- No re-testing of framework or database guarantees.

## Task log
Task 1: BASE cf2236e
Task 1: complete (cf2236e..d3a29aa, review approved, no findings).
  Two PLAN bugs found by the implementer and fixed:
   - Prisma 5 hard-errors `prisma generate` on a schema with zero models. A ScaffoldPlaceholder
     model was added. Task 2 MUST delete it. Reviewer confirmed it is inert and no migration
     was generated against it, so removal is clean.
   - apps/api/tsconfig.json extends @winterborn/config but the plan never declared the
     dependency, so pnpm did not symlink it and typecheck failed TS6053. Added as workspace:*
     devDependency. apps/web has no equivalent problem, its tsconfig is self-contained.
  Docker here is colima, not Docker Desktop. It was started to bring the stack up.
  Known-red until Task 3/4: apps/api `pnpm test` exits 1 with "no test files found".
  Carrying into Task 2: add --passWithNoTests so CI is not red through Task 2.

Task 2: BASE d3a29aa
Task 2: complete (d3a29aa..364358d, review approved, no findings).
  22 models. All four LedgerEvent indexes confirmed in the GENERATED migration.sql, not just
  the Prisma schema. seedDevCatalog TRUNCATE list verified against the actual model list and
  run twice consecutively with no FK violations. ScaffoldPlaceholder removed.
Task 2: minor (deferred): spec 5.6 specifies a PARTIAL index on
  (warehouseVariantId, locationId) WHERE warehouseVariantId IS NOT NULL. Prisma generated a
  plain composite index. Functionally equivalent for Task 5's GROUP BY, marginally larger.
  Not worth a fix round; revisit only if index size is ever measured as a problem.
Task 2: tooling note: `pnpm --filter X db:migrate -- --name Y` does not forward the name arg.
  Invoke `prisma migrate dev --name Y` directly.

Task 3: BASE 364358d
Task 3: complete at 08b2933 (6/6 tests, workspace green). Review dispatched.
Task 4: implemented at da96589 (5/5 tests). Review: spec OK, approved, 1 Important.
  Reviewer confirmed append's idempotency rests on the DB unique constraint with a narrow P2002
  check, not a racy read-then-write; and traced the atomicity test to confirm it genuinely
  discriminates (a non-transactional impl would leave before+1 rows and fail).
  Sole-writer verified by grep: ledger.service.ts is the only caller of ledgerEvent.create.
F1. Important, ACCEPTED: transfer()'s idempotency PRE-CHECK is TOCTOU-racy. Two concurrent
    calls with the same prefix can both pass findUnique before either commits; the loser throws
    a raw Prisma error instead of returning {created:false} the way append() does.
    Ledger integrity is NEVER at risk -- the unique constraint kills the second write and the
    transaction rolls back, so no double-count and no orphaned leg. The defect is contract
    inconsistency, and it matters because Plan 4's reconciliation poll re-ingests the same
    window every pass by design and any retry path around dispatch would hit it.
    Ruling: fix by mirroring append's catch-P2002 pattern, plus a concurrent-duplicate test.
    Cost if wrong: an unhandled exception during a genuine race in peak season.
Task 4: fix round 1/5 dispatched (F1)
Task 5: complete at aa25a72. 16 tests green workspace-wide.
  MUTATION CHECK PASSED: recompute() was deliberately broken (WRITE_OFF rows dropped), the
  property test went red, then reverted. The test can fail, so its passing means something.
  Deviation accepted: added "env": ["DATABASE_URL"] to turbo.json's test task. Turborepo 2.x
  strict env mode was stripping the variable from child processes. Non-secret, minimal.
Task 5: minor (deferred): recompute() is property-tested only against onHandByFamily.
  onHandByVariant has the fixed-scenario test but no randomised replay check. Per the brief's
  design of two code paths, not three.
Task 4: fix round 1/5 (1 addressed, 0 open — F1 pre-check removed, recovery now inside a catch
  narrowed on P2002 mirroring append(); returns the EXISTING transferId not a fresh UUID;
  new concurrency test uses Promise.allSettled with both promises started before either await,
  asserts both fulfilled, matching transferIds, and exactly 2 rows. Reviewer confirmed the test
  would fail against the pre-fix code. Both inserts still inside one $transaction, atomicity
  untouched. Commits aa25a72..e26c0d8)
Task 4: complete (08b2933..e26c0d8, review clean). 6/6 tests, stable across 3 repeat runs.
Task 5: review (approved) found 1 Important, and it is a defect in MY PLAN TEXT not the code.
F2. The recompute() docstring claims "if they ever diverge, either something other than
    LedgerService wrote to the ledger, or an event was mutated in place." That is FALSE.
    Both queries read the SAME table at the SAME instant, so a rogue write or an in-place
    mutation is summed identically by both and produces no divergence whatsoever. The test
    cannot detect either. What it genuinely proves is narrower: a derivation-LOGIC bug in
    either query gets caught, which the mutation check demonstrated.
    Ruling: ACCEPTED, rewrite to claim only what is true. A comment in code read for years
    must not assert a protection that does not exist.
    Cost if wrong: someone trusts a safety property that was never there.
F3. Reviewer's closing observation, and the genuinely valuable one: the no-permanent-drift
    guarantee actually rests on the SCHEMA storing no balance anywhere (verified), not on the
    two-path comparison. But append-only ITSELF is enforced only by discipline. Nothing stops
    an UPDATE or DELETE from a migration, a console session, or a future service.
    Ruling: ACCEPTED, add a Postgres BEFORE UPDATE OR DELETE trigger on LedgerEvent raising an
    exception. Cheap now, effectively impossible once a season of production data exists.
    TRUNCATE is unaffected (row triggers do not fire), so seedDevCatalog still works.
    This converts a Global Constraint from convention into a guarantee.
    Cost if wrong: a legitimate future delete requires dropping the trigger deliberately,
    which is the correct friction for that operation.
Task 5: fix round 1/5 dispatched (F2, F3)
Task 3: review clean, approved, no findings. Test honesty verified: all five negative tests
  die if their corresponding refine is deleted. z.input confirmed on both input types.
Task 5: fix round 1/5 committed at 7497758. 18 tests, workspace green.
  Append-only trigger now lives in migration 20260820064642_ledger_append_only, raising
  'LedgerEvent is append-only; correct a mistake by appending a CORRECTION event, not by %'.
  Re-review dispatched.
Task 5: fix round 1/5 (2 addressed, 0 open — F2 docstring now claims only what is demonstrable
  and explicitly disclaims tamper detection, redirecting that guarantee to the trigger;
  F3 trigger verified BEFORE UPDATE OR DELETE FOR EACH ROW with no exception handler, TRUNCATE
  confirmed unaffected, no existing code path performs UPDATE/DELETE on LedgerEvent, and the
  test issues real prisma.update and prisma.delete calls asserting both reject. Commits
  e26c0d8..7497758)
Task 5: complete (da96589..7497758, review clean).

ALL 5 TASKS COMPLETE. 18 tests. Proceeding to final whole-branch review.

FINAL WHOLE-BRANCH REVIEW (opus): 2 Critical, 6 Important, 8 Minor.
Verdict: ledger sound and trustworthy; every finding was build plumbing that cannot corrupt
data, or an invariant currently unviolated but unenforced. Reviewer verified the architecture
rather than trusting it: no stored stock level anywhere, LedgerService provably sole writer,
no code path depends on mutating the event table.

C1 was invisible to every task-scoped review: the CI workflow has NEVER RUN (no git remote)
  and could not pass. Nothing generates the Prisma client -- migrate deploy does not generate,
  and @prisma/client's postinstall chdirs to the repo root where there is no schema, swallowing
  the failure. On a clean checkout typecheck fails. The Definition of Done was false.
  Reviewer proved it by running the Prisma CLI from the repo root.
Final fix wave c59c140: all 8 addressed (C1, C2, I2, I3, I4, I5, I6, Minor 4). 20/20 tests,
  verified from a fully clean state: generated client removed, dist removed, turbo cache cleared.
I6 outcome: the property test is now GENUINELY randomised. Seeded LCG, seed varies per run via
  Math.random, overridable by LEDGER_PROPERTY_SEED, logged unconditionally and again on failure
  with the exact repro command. Value ranges and event-type coverage preserved. The word
  "randomised" is now earned in the test, the plan, and the Definition of Done.

SCHEDULED FOR THE START OF PLAN 3 (not absorbed, not forgotten):
S1. Foreign keys on LedgerEvent.variationId and .warehouseVariantId. Spec 5.4 specifies them;
    the schema has only the Location relation. Worse now that rows are immortal: a row
    referencing a deleted variation inserts silently, skews every derivation, and CANNOT be
    deleted. Only remedy is an offsetting CORRECTION plus a permanent orphan.
S2. Randomised replay check for onHandByVariant(). It is a different query -- different WHERE,
    different GROUP BY -- and backs manifests and the season-close sell-through report. Its
    entire protection today is one fixed scenario asserting 40.

F4. PARKED (re-review out-of-scope observation). I3's key-builder collision safety between
    builder-made keys and transferKeyPrefix()'s :from/:to namespace rests on a doc-comment
    convention, not a runtime guard.
    Ruling: PARKED. Real but narrow, and the builders make accidental collision hard.
    Cost if wrong: a hand-rolled key ending :to/:from could collide with a transfer leg.
F5. PARKED (re-review out-of-scope observation). I4's CI guard greps only for
    `prisma.ledgerEvent.create(`. A future `createMany(...)` bypasses it -- and bulk sale
    ingestion in Plan 4 is exactly where someone would reach for createMany.
    Ruling: PARKED, no second fix wave, but this is the weakest of the parked items because the
    guard has a hole in the case it will most likely face. Widen the regex at the start of Plan 3
    alongside S1 and S2. One-line change.
    Cost if wrong: the sole-writer guard silently fails to catch the most plausible violation.

PLAN 2 COMPLETE. 9 commits, 20 tests. Workspace held for the user at the plan boundary.
