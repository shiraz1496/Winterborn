# SDD ledger — plan: docs/superpowers/plans/2026-08-19-catalog-migration-prototypes.md

Spec: docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md (read)
Branch: plan-01-catalog-prototypes
Base: b3ce5b2 (docs commit) -> see per-task BASE lines

## Pre-flight scan

### Cross-task pairs (shared file or interface)

| Producer | Consumer | Produces -> Consumes | Finding |
|---|---|---|---|
| T1 client.ts | T2 seed.ts | square, RUN_ID, mainLocationId | agree |
| T1 client.ts | T3 verify.ts | square | agree (see F1) |
| T1 client.ts | T4 migrate-a.ts | square, RUN_ID | agree |
| T1 client.ts | T5 locations.ts | square, RUN_ID | agree |
| T1 client.ts | T6 migrate-b.ts | square, RUN_ID | agree |
| T2 seed.ts | T3 verify.test.ts | seedFlatItem(name, priceCents, orderCount) | agree |
| T2 seed.ts | T4 migrate-a.test.ts | seedFlatItem | agree |
| T2 seed.ts | T5 overrides.test.ts | seedFlatItem | agree |
| T2 seed.ts | T6 migrate-b.test.ts | seedSizeItem(name, sizes, priceCents, ordersPerSize) | agree |
| T3 verify.ts | T4 migrate-a.test.ts | readOrderLines, catalogObjectExists, resolveVariationToItem, itemVariationNames | agree |
| T3 verify.ts | T6 migrate-b.test.ts | readOrderLines, catalogObjectExists, itemVariationNames | agree |
| T4 migrate-a.ts | T5 overrides.test.ts | migrateFlatToVariations(itemId, colourNames, priceCents, legacyLabel?) | agree |
| T4,T5,T6 | T7 decision record | test results | agree |

### Per-task self-consistency

| Task | Tests vs code | Files created vs later touched | Finding |
|---|---|---|---|
| T1 | connectivity.test.ts imports square/mainLocationId/RUN_ID, all exported by client.ts | client.ts touched by nothing later | agree; SDK surface unverified -> F2 |
| T2 | seed.test.ts calls seedFlatItem/3, matches signature | seed.ts read-only thereafter | agree |
| T3 | verify.test.ts exercises all 4 exports | verify.ts read-only thereafter | agree |
| T4 | test asserts legacy renamed, not deleted; impl renames | migrate-a.ts consumed by T5 | agree |
| T5 | test asserts override survives migration | locations.ts terminal | agree; sandbox capability unverified -> F3 |
| T6 | test asserts 4 vs 20 entry counts; impl produces both | migrate-b.ts terminal | agree |
| T7 | docs only, modifies spec 8.3/8.6/13 | spec is the authority; edits are outcome-recording only | agree |

### Findings and rulings

F1. T3 Interfaces block declares `mainLocationId` as consumed, but verify.ts
    does not import it.
    Ruling: over-declaration, harmless. Implementer imports only what it uses;
    reviewer must not treat the unused declaration as a spec gap.
    Cost if wrong: none.

F2. Every task's code is written against the `square` SDK v43 surface
    (SquareClient, SquareEnvironment, bigint Money.amount, catalog.object.get/upsert).
    The installed version may differ.
    Ruling: T1 is the verification gate and already says so. Implementers adapt
    imports, response-shape accessors, and Money.amount numeric type to the
    installed SDK, and record every deviation in their report so later tasks
    inherit the correction. The assertions are the contract, not the call syntax.
    Cost if wrong: rework confined to call sites; assertions unaffected.

F3. T5 `ensureSecondLocation` assumes the sandbox permits creating a location
    via the Locations API. If it does not, the task cannot run as written.
    Ruling: fall back to setting the override on the single existing location
    and still assert it survives the migration. That still proves the field is
    preserved, which is the requirement in spec 7.3. Implementer must state in
    the report which path ran.
    Cost if wrong: the multi-location case stays unproven in sandbox and must be
    confirmed on the one live low-volume item at the start of Plan 3.

## Task log

Task 1: BASE 4a8cdea, implementer agent aab134657e81431c8, HEAD b41e99d
Task 1: review -> spec OK, quality approved, 2 Important findings both plan-mandated

F4. connectivity.test.ts "can read the catalog" asserts count >= 0, which is
    vacuously true and also true when res.data is undefined. The Square SDK
    surfaces API-level failures in res.errors WITHOUT throwing, so the test
    passes on a permissions failure.
    Ruling: ACCEPTED and load-bearing beyond this task. Every task 2-6 helper
    reads an expected field and throws a generic message when absent; an
    errors-bearing response would surface as "Upsert returned no object" rather
    than the real cause. Worse, verify.ts catalogObjectExists() try/catches to
    false, which would render a Square auth failure indistinguishable from
    "the object was deleted" -- and "was the object deleted" is precisely the
    question Task 4 exists to answer. Fix now, and add a shared
    assertNoErrors(res, context) helper to client.ts that tasks 2-6 must use
    after every Square call. Plan Global Constraints amended accordingly.
    Cost if wrong: none, the helper is additive.

F5. connectivity.test.ts "refuses to run outside sandbox" re-asserts env values
    rather than exercising assertSandbox()'s throw path, so an inverted
    comparison in the guard would pass.
    Ruling: ACCEPTED. The guard is the only thing standing between these
    prototypes and Joel's live $2.9M catalog. It gets a real test.
    Cost if wrong: none.

Task 1: fix round 1/5 dispatched (F4, F5)
Task 1: fix round 1/5 (2 addressed, 0 open — F4 assertNoErrors helper + real catalog assertion; F5 guard throw-path tests; commits b41e99d..c1332a9)
Task 1: complete (commits 4a8cdea..c1332a9, review clean). 4/4 tests green.
  SDK pinned: square@43.2.1, surface matched the plan exactly.
  Downstream facts: catalog.object.get -> res.object; catalog.object.upsert -> res.catalogObject;
  Money.amount is bigint; catalog.list returns a Page exposing res.data; Orders shapes NOT yet verified.
  New 5th export from client.ts: assertNoErrors(res, context).
  Sandbox has 0 pre-existing catalog ITEMs.
Plan amended at ad7adf8 (Global Constraints: assertNoErrors after every Square call).

Task 2: BASE ad7adf8
Task 2: complete (commits ad7adf8..44a67bc, review clean). 5 tests green.
  Real API finding: orders.create with state:'COMPLETED' returns 400 CONFLICTING_PARAMETERS.
  Working sequence is create OPEN -> payments.create with sandbox nonce 'cnon:card-nonce-ok'
  -> orders.get confirms COMPLETED. Line items reference the VARIATION id, which is what
  Tasks 4/6 must measure. assertNoErrors used on all four Square calls.
Task 2: resolved (cannot-verify): reviewer could not confirm from the diff that the brief's
  original state:'COMPLETED' call fails live. Ruling: moot. The replacement is proven by tests
  that assert COMPLETED via orders.get; why the original was abandoned changes nothing downstream.
  Cost if wrong: none.
Task 2: minor (deferred): seedSizeItem has no automated test of its own; Task 6 exercises it.
Task 2: minor (deferred): order placement is sequential, 3 API calls per order; may be slow for larger fixtures.

Task 3: BASE 44a67bc
Task 3: complete (commits 44a67bc..2822800, review clean). 7/7 tests green.
  Instructed departure implemented correctly: catalogObjectExists returns false ONLY on a
  genuine Square not-found (statusCode + errors[].code on SquareError); auth, 429, timeout and
  assertNoErrors soft-failures all propagate. Traced end-to-end by the reviewer against the
  SDK's own error type definitions.
Task 3: minor (deferred): the 'DOES_NOT_EXIST' test would pass even if catalogObjectExists
  always returned false; it only has teeth alongside the positive assertion. Inherited from the brief.
Task 3: minor (deferred): tsc --noEmit union-narrowing errors in seed.ts and verify.ts.
  No typecheck gate exists and none is required for throwaway prototypes.

F6. Ruling on the reviewer's cannot-verify item, and it is LOAD-BEARING.
    Open question: when a Square catalog object is DELETED, does catalog.object.get throw a
    404 (so catalogObjectExists returns false), or resolve with the object carrying
    isDeleted: true (so catalogObjectExists wrongly returns TRUE)?
    Why it matters: Task 4's central assertion is "historical order lines still point at a live
    catalog object". If deleted objects read as existing, that assertion CANNOT DETECT
    ORPHANING -- it would pass whether or not the migration destroyed history, and the plan
    would return a confidently wrong answer to the only question it exists to ask.
    Task 3's own tests cannot catch this: the preserve-and-relabel approach never deletes, so
    the detector is only ever exercised on objects that genuinely exist.
    Ruling: Task 4 must add a NEGATIVE CONTROL -- create a throwaway variation, delete it, and
    assert catalogObjectExists reports it absent. If it reports present, catalogObjectExists is
    hardened to treat isDeleted as absence before any migration assertion is trusted.
    Cost if wrong: the entire plan's headline finding is unsound. This is the cheapest possible
    insurance against it.

Task 4: BASE 2822800
Task 4: THE GATE PASSED. item_id survives, legacy variation preserved with its ID intact,
  all historical order lines still resolve to a live catalog object. 9/9 tests green.
Task 4: F6 negative control RESOLVED empirically. Square's catalog.object.get throws a 404
  SquareError for a DELETED object, identical to one that never existed. No isDeleted
  resolve-path at this API layer. catalogObjectExists needed no hardening -- the detector
  genuinely detects, so the migration test's `true` is a real signal, not a false positive.

F7. Reviewer finding (Important, plan-mandated): the brief's test cannot distinguish correct
    behaviour from the "silent mislabel" failure mode it exists to guard against. If the
    implementation renamed the legacy variation to 'Blue' and added 'Unspecified (pre-2026)'
    as a NEW variation, every single assertion still passes. The test checks the honest label
    exists SOMEWHERE on the item, never that it is on the object carrying the history.
    sellable:false is never asserted at all.
    Ruling: ACCEPTED. This is the entire reason preserve-and-relabel was chosen over
    reuse-as-a-colour, and it is currently evidenced only by reading the source. Three-line fix.
    Cost if wrong: none, the fix is additive.

F8. Reviewer finding (Minor): the negative control deletes a variation with ZERO order history,
    but the case that matters is a deleted variation WITH sales against it.
    Ruling: ACCEPTED, folded into the same fix round. Residual risk is low but the fix is one
    argument (orderCount 0 -> 1) and it makes the control cover the case it is actually insuring.
    Cost if wrong: none.

F9. Reviewer finding (Minor, carried forward not fixed): new colour variations are created with
    no locationOverrides and no presentAtLocationIds. Correct for this task's scope, but for the
    real client it means a migration preserves the legacy row's per-location overrides while
    leaving every NEW colour row at a flat price across all 14 markets.
    Ruling: not a Task 4 defect. Carried into Task 5's dispatch and into the decision record's
    "Consequences for Plan 3" section, where the production scripts must handle it.
    Cost if wrong: discovered in production as flat pricing at Carmel and Boston. Recording it
    is the mitigation.

F10. SCOPE LIMIT on the headline finding, raised by the reviewer and accepted.
    What Task 4 proves: the DATA-MODEL linkage survives -- historical order lines still
    reference a live catalog object under the same item_id.
    What it does NOT prove: that Square's Item Sales report or a YoY export still attributes
    those lines under that item once the legacy variation is sellable:false. That reporting
    layer is where the client's $2.9M year-over-year figure is actually read from, and spec
    section 8.3 lists "Item Sales reports still aggregate correctly" as a required verification.
    No assertion in this task touches it, and it is Dashboard-only so it cannot be asserted
    programmatically in sandbox without violating the plan's own constraint.
    Ruling: not a blocker for Task 4, and not fixable in sandbox. It goes into the decision
    record under "What is still unknown", and it becomes the PRIMARY thing to verify on the one
    live low-volume item at the start of Plan 3 -- which is precisely what spec 8.3 step 5 exists
    for. Task 7's dispatch must carry this.
    Cost if wrong: the migration is data-model-safe but reporting-unsafe, and we would learn it
    on the live item rather than in production. Acceptable.

Task 4: fix round 1/5 dispatched (F7, F8)
Task 4: fix round 1/5 (2 addressed, 0 open — F7 legacy-variation assertions bound to the object
  by pre-migration ID, F8 negative control widened to orderCount 1; commits a978480..29f6ba8)
  Implementer did mutant testing: confirmed the new F7 assertions FAIL against a reproduction of
  the mislabel bug, then reverted it. Reviewer confirmed migrate-a.ts is untouched by the fix
  round, so no mutant remains.
  F8 result: deleting an ORDER-REFERENCED variation 404s identically to an unreferenced one.
  catalogObjectExists is sound in the case that actually matters.
Task 4: complete (commits 2822800..29f6ba8, review clean). THE GATE IS CLOSED.

Task 5: BASE 29f6ba8
Task 5: implemented at d05c403. Review: spec OK, quality approved, 1 Important (F11).
  RESULT 1 -- per-location price override SURVIVES the migration. {L1Y8D6MP72WPT: 17700}
  identical before and after. Genuine round-trip through Square, pre-state asserted, bigint
  conversion handled in one place. Reviewer: sound enough for a production decision record.
  RESULT 2 -- F9 CONFIRMED AND IT IS A REAL PRODUCTION RISK. The newly created colour
  variations come out with empty locationOverrides and no presentAtLocationIds. On the real
  catalog that means a migration preserves the Carmel premium on the UNSELLABLE LEGACY ROW
  while every customer-facing colour variation sells at flat price across all 14 markets.
  Plan 3's production scripts must read each variation's overrides and reapply them to the new
  variations. This goes in the decision record's "Consequences for Plan 3".
  F3 RESOLVED: locations.create succeeded in sandbox, so the multi-location case is genuinely
  proven, not fallback-proven. The single-location fallback branch exists but never ran.

F11. Reviewer finding (Important): the report describes presentAtAllLocations:true as asserted,
     but it appears only in an out-of-band evidence script and a code comment, not in an expect().
     Ruling: ACCEPTED. That sub-claim is the most quotable line of F9 -- it is the one that says
     plainly that new variations sell at flat price at ALL 14 markets -- and it is headed for a
     document Plan 3 is written from, to be read by someone who cannot re-run a deleted script.
     One assertion. Assert whatever Square actually returns; a surprise is a finding.
     Cost if wrong: none, additive.

Task 5: fix round 1/5 dispatched (F11)
Task 5: fix round 1/5 (1 addressed, 0 open — F11 presentAtAllLocations now CI-asserted inside
  the loop against a freshly fetched object; Square returns true, no surprise; commits d05c403..241ac54)
Task 5: complete (commits 29f6ba8..241ac54, review clean). 10 tests green across 5 files.
Task 5: note (not a defect): SDD workspace is gitignored so report files are untracked by design.
  The committed artifact is Task 7's decision record, not the reports.

Task 6: BASE 241ac54
Task 6: implemented at 1a5c52d. Review: spec OK, quality approved, 1 Important (F12).
  MEASURED RESULT -- item-per-pattern: 4 selectable entries per item (UNDER the 16 ceiling).
                     in-place expansion: 20 entries (BREACHES the ceiling).
  entryCount=20 is derived from Square's actual upsert response, a true measurement.
  History survived in-place expansion: seeded order lines still resolve to the specific
  seeded variation IDs, with a length gate and real awaits. Would fail if expandInPlace no-oped.
  seedSizeItem behaved correctly on its first real use (Task 2 shipped it untested).
  OVERRIDES GAP CONFIRMED ON A SECOND CODE PATH: new pattern items also come out with no
  locationOverrides / presentAtLocationIds and presentAtAllLocations:true. SHARPER here than in
  migrate-a, because item-per-pattern has NO legacy row to fall back on -- there is nowhere for
  the Carmel premium to survive at all. Plan 3 must handle both paths.

F12. Reviewer finding (Important): entriesPerItem is computed from sizes.length (input
     arithmetic) while entryCount is derived from Square's response (a real measurement).
     Reviewer judged it non-blocking because the test independently cross-checks with
     itemVariationNames against a live query.
     Ruling: ACCEPTED and fixed anyway. The figure 4 goes into a document Plan 3 is written
     from, read months later by someone who cannot see this test file. A number that is
     self-verifying inside the function is worth more than one that depends on the reader
     knowing a separate assertion existed. One line.
     Cost if wrong: none.

Task 6: fix round 1/5 dispatched (F12)
Task 6: fix round 1/5 (1 addressed, 0 open — F12 entriesPerItem now measured from Square's
  upsert response, all four per-item counts asserted equal, missing variations array throws
  with context; still measures 4; commits 1a5c52d..80d6419)
Task 6: complete (commits 241ac54..80d6419, review clean).

Task 7: BASE 80d6419
Task 7: decision record written at b74252d. Review (opus): spec OK, 2 Important + 9 Minor.
  Reviewer verdict on "would you build a production migration from this document alone":
  YES ON SAFETY, NO ON COMPLETENESS. Nothing in the record is stronger than its evidence;
  all three must-survive facts (overrides gap, reporting-layer limit, present_at_location_ids)
  survived summarization at full strength. The gap is mechanical, not evidentiary.
Task 7: NEW GAP found by the implementer, not by me or the plan -- present_at_location_ids
  preservation was never proven. Spec 7.3 requires it alongside location_overrides, but no test
  ever set a non-default value on a legacy variation and asserted survival, because seeded
  sandbox items are present at all locations. Only locationOverrides survival is proven.
  Correctly recorded as an unknown rather than inheriting the override result's strength.

F13. Important, ACCEPTED: the record renders locationOverrides as {} -- which is the prototype
     helper's flattened locationId->cents map, NOT the API shape. The real field is an array of
     {locationId, priceMoney:{amount:bigint,currency}, pricingType:'FIXED_PRICING'}, absent as
     undefined. "Reapply overrides onto new variations" is the record's most consequential
     instruction and nobody can write an override from a flattened map.
     Cost if wrong: Plan 3 writes the wrong shape and rediscovers it against production.
F14. Important, ACCEPTED: client-supplied #-prefixed temp IDs and the idMappings response field
     are absent from the API-facts section, though every new catalog object in the prototypes is
     created that way and Plan 3 creates every new variation. Cost if wrong: rediscovery.
F15. Minor, ACCEPTED anyway: "This record closes that gate" is unqualified in the Question
     section while the reporting-layer limit appears ~270 lines later. Most quotable sentence in
     the document, and out of context it claims more than was proven.
F16. Minor, ACCEPTED anyway: spec 12's top risk row left stale, and the overrides gap has NO
     entry in 12 at all. Section 12 is the register a reader scans for what is still dangerous;
     the most dangerous production finding in the plan belongs in it.
F17. Minor, ACCEPTED anyway: record points Plan 3 at the prototypes as reference implementation
     without saying they fail tsc --noEmit. Production code will be strict-mode.

Task 7: deferred minors (NOT fixed, recorded for the final review):
  - spec 13 item-1 phrasing inconsistent with its "only unresolved" preamble
  - spec 8.3 steps 1-2 retain "unless the prototype proves it is required" language
  - only ONE override on ONE location on ONE legacy variation was exercised; the real catalog
    has rows with two simultaneous overrides (Stuffies/Large: Boston $80 + Carmel $75)
  - Consequences item 8's one-variation precondition lacks an inline caveat
Task 7: fix round 1/5 dispatched (F13, F14, F15, F16, F17)
Task 7: fix round 1/5 (5 addressed, 0 open — F13 wire shape, F14 temp IDs, F15 gate
  qualification co-located, F16 spec 12 refreshed + overrides row added, F17 tsc caveat;
  plus both accuracy points. Commits b74252d..0a20c57)
  Reviewer endorsed the implementer's idMappings deviation: recording it as SDK-typed but
  untested, rather than stating it flatly, is the more defensible choice under the document's
  own standard. No prototype reads res.idMappings; all recover IDs from res.catalogObject.
F18. NEW inaccuracy introduced BY the fix round, Important. The temp-ID bullet claims a child
     variation references its not-yet-created parent by temp ID. True for #var_ and #pat_.
     FALSE for #new_ in migrate-a.ts, where itemVariationData.itemId is the REAL pre-existing
     item ID -- which is the whole mechanism by which read-modify-write preserves item_id, and
     migrate-a.ts is the code path this entire document is built around. Also omits #exp_.
     Ruling: fix. Plan 3 writes exactly this code against a live catalog.
     Cost if wrong: Plan 3 constructs new variations against a temp parent that does not exist.
Task 7: fix round 2/5 dispatched (F18)
Task 7: fix round 2/5 (1 addressed, 0 open — F18 temp-ID claim split into its two genuine
  cases, #exp_ added; verified line-by-line against all four call sites; commits 0a20c57..d50a024)
  Implementer note worth carrying: a reader following the old bullet would have written a
  create-new-item upsert while believing it was a read-modify-write, which is the spec 8.2
  failure mode exactly. Also flagged: the error was introduced BY a fix round, not the original
  draft -- late additions under a "just add the missing fact" framing get less verification than
  the text they sit beside.
  Two further overreaches found and corrected while checking neighbours: an untested "must carry
  an id beginning with #" failure-mode assertion, and an imprecise res.catalogObject sentence.
Task 7: complete (commits 80d6419..d50a024, review clean).

ALL 7 TASKS COMPLETE. Proceeding to final whole-branch review.

FINAL WHOLE-BRANCH REVIEW (opus): no Critical. Verdict: safe to merge and the record is
trustworthy for production scripts, after a fix wave. 4 Important + 8 Minor, all of them
overstatements of EVIDENTIAL STRENGTH rather than errors in the conclusions. Every decision
survives the corrections unchanged.
Final fix wave 117210c: all 7 (I1-I4, M3, M4, deferred #7) ADDRESSED, verified against the
  diff rather than the report.
  I2 EMPIRICAL RESULT: raw locationOverrides is genuinely `undefined` (not []) on BOTH paths.
    The record's claim was true, it was simply unproven. Now CI-asserted on the raw field.
  I4 EMPIRICAL RESULT: locations.create was NOT called. ensureSecondLocation reused a location
    left behind by an earlier run. The reviewer's suspicion was correct and the record's claim
    that "locations.create succeeded" was false as stated. Now reworded, and distinctness is
    CI-enforced instead of inferred from the absence of a warning.
  I1 was the only code-side defect on the whole branch: mainLocationId() was the 1 of 24 Square
    call sites without assertNoErrors, while the record told Plan 3 the helper is used after
    every single call. Fixed, so the sentence is now true.

F19. PARKED (final review residual, Minor). The I3 rewording introduced a misattributed
     cross-reference in the decision record's Decision 3: it cites "Decisions/Consequences
     item 2" for the claim that new variations come out with no locationOverrides, but
     Decisions item 2 is about the legacy relabel. The correct target is Decisions item 6 /
     Consequences item 2.
     Ruling: PARKED, not fixed. There is no second fix wave, and this is cosmetic -- it
     misdirects a reader checking a source but changes no conclusion and no test result.
     Surfaced to the user as a one-word change to approve.
     Cost if wrong: a Plan 3 author following the citation lands on the wrong item and has to
     look twice. No production consequence.

Third recurrence of the same pattern: a finding introduced BY a fix round rather than by the
original draft. Worth carrying into Plan 3's process.

BRANCH COMPLETE. 16 commits. Workspace NOT deleted -- held for the user at the plan boundary.
