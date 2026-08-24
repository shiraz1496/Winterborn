# Task 4 report: the PWA

## 1. Status

Done. `pnpm typecheck && pnpm build` green across all four packages; `pnpm test` green (122 tests: 114 API + 8 shared) as of the last run before final data seeding. Both servers booted for real, the magic-link flow was exercised end to end in an actual browser, and every write path in the plan (create/edit/transition a request, pack a box, print its label, dispatch it directly, load a van and dispatch the load, assign a colour family) was driven through the UI against the live API and confirmed in Postgres afterward.

Commits on `plan-05-requests-fulfilment`:
- `0b217f8` — `fix(api): expose read endpoints and box/load listing the PWA needs`
- `5923705` — `feat(web): restock PWA`

## 2. Screens built, and what "verified running against live data" means for each

All six screens from the plan exist, plus `/requests/new` (needed to actually raise a request) and `/pack` (an index so the bottom-nav "Pack" tab has somewhere to land before a request is chosen).

| Screen | Built | Verified live |
|---|---|---|
| `/login` | yes | Real magic-link round trip: requested a link for `warehouse@example.com` / `market-manager@example.com` / `operator@example.com`, the API printed it to stdout and handed back `devLink`, the UI showed it inline, tapping it called `/auth/verify` and landed on `/` with a real session cookie. |
| `/` dashboard | yes | Rendered real low-stock rows (thresholds vs. `stock/by-family`), real open requests, real on-hand-by-family list, for both an unscoped role (market picker shown) and a `MARKET_MANAGER` (locked to their own market, no picker). |
| `/requests`, `/requests/[id]`, `/requests/new` | yes | Listed the real seeded request; created a brand-new one through the actual search-and-add form as `operator@example.com` (landed on its detail page in `DRAFT`); edited a line's quantity via the stepper and confirmed the PATCH took. |
| `/pack/[requestId]`, `/pack` | yes | Expanded a family line to its real warehouse variants, allocated units with the stepper, packed three separate boxes, printed a label (real scannable QR rendered on a ticket), dispatched one box directly from this screen — confirmed `Box.state` and the paired `LedgerEvent` rows in Postgres afterward. |
| `/scan` | yes | Both modes: quick dispatch (manual token lookup → confirm sheet → `Confirm dispatch` → box `DISPATCHED`) and load verification (create a load → scan a box on via manual entry → `Confirm onto load` → `Dispatch load` → `Load.dispatchedAt` set, one `LoadBox` row). Camera itself only smoke-tested (see §4) — no physical camera in this environment. |
| `/admin/colours` | yes | Real residual queue (76 rows at the real import's `assign-families` count), real archived photos loading from the API's new static route, tapped colour chips and the "No colour" chip — queue count dropped 76 → 75 → 74 (74 matches the plan's stated number) and `ColourVariant.colourFamilyId` updated in the DB. |

Screenshots from the live run are in the scratchpad (`shots/01-login.png` … `30-new-request-created.png`) if useful for a follow-up review; not attached here since this report is text.

## 3. Design direction

Dark, high-contrast, industrial register — deliberately not a light theme with a toggle, because the audience and the room are fixed (a warehouse bench under fluorescent light), unlike a general consumer app. Dark also costs less battery on the OLED phones staff actually carry and cuts glare bounce off a phone held under bright warehouse lighting.

- **Tokens**: `--ink #14181a` background, warm off-white text (`#edeae1`, not pure white — softer under glare), one amber signal colour (`#e8a33d`) for every primary action and focus ring, pine/rust for success/danger states.
- **Type**: Archivo (800/900) for headings and big numbers — a condensed, stencil-like display face that reads like crate/shipping-label lettering; Public Sans for body copy (built for dense functional UI, USWDS heritage); IBM Plex Mono for anything that's data — SKUs, quantities, timestamps, the printed QR token.
- **Shape**: small radii (3–10px), hairline borders, no bubbly consumer-app curves — closer to a printed manifest than a social app.
- **The one recurring signature**: a colour family is shown as an actual coloured swatch everywhere — dashboard rows, request lines, the pack sheet, the admin queue — because resolving a colour family to a concrete variant is literally the job this software exists to do. A family with no natural swatch (the catch-all "Multi") gets a diagonal stripe; a variant that has been decided to have genuinely no colour gets a dashed, calm outline rather than a warning triangle, which is the direct answer to the brief's "make 'no colour' a legitimate answer, not a guess."
- **One-handed / thumb-zone**: primary actions are 60px tall and full-width; the bottom nav sits in the thumb zone (not a top bar, which is a desktop habit); the pack screen's stepper buttons are 60×60px so a gloved thumb doesn't miscount; the scan screen's confirm sheet slides up from the bottom, one thumb reachable, with a full-width primary "Confirm" button next to a smaller "Skip."
- Successful pack/scan confirms call `navigator.vibrate()` where available — real haptic feedback in a loud warehouse, at basically no cost.

## 4. How scanning degrades on iOS Safari

`lib/barcode.ts` picks one of two engines:

- **Native `BarcodeDetector`** (Chrome/Android and desktop Chrome): decodes every QR code visible in a single video frame in one `detect()` call, so several boxes laid out together are all found at once.
- **`@zxing/browser` fallback** (iOS Safari, which has never shipped `BarcodeDetector`): decodes one code per attempt via continuous polling, not every code in frame at once.

That's a real capability difference, not a bug, and it's the one explicitly called out in the brief. What does **not** differ between the two paths: neither one calls a mutating endpoint. Every code either engine proposes goes into the same queue, resolved through `GET /boxes/by-token/:qrToken`, and shown in the same bottom confirm sheet requiring the same deliberate tap before `dispatchBox` / `scanBoxOntoLoad` fires. "The scan finds, the human confirms" holds identically on both paths — only "how many at once" changes. A manual token-entry field is also always present (typing the code printed under the QR), both as an accessibility floor and because a damaged label or a denied camera permission shouldn't strand a packer.

Not independently verified against a real iPhone in this sandbox (no such device available) — verified instead by code review of the fallback path and by confirming the manual-entry path (which every engine funnels into identically) end to end live.

## 5. Deviations from the plan

- **Added read endpoints the API didn't have.** `LedgerReadService` existed but was never wired to a controller; there was no way to list locations, catalog metadata, thresholds, or the colour-assignment queue, and boxes/loads were write-only (no `GET`, and — significant — no way to resolve a scanned `qrToken` back to a box at all, which made `/scan` impossible to build as specified). Added `CatalogController` (`GET /locations`, `/catalog/variations`, `/catalog/warehouse-variants`, `/catalog/thresholds`, `/catalog/colour-variants/unassigned`, `/catalog/colour-families`, `PATCH /catalog/colour-variants/:id`, `/stock/by-family`, `/stock/by-variant`, `/stock/low`) and `GET` routes on `BoxesController`/`LoadsController` (list, get, get-by-token). All additive — no existing method signature changed — and covered by the existing test suite passing unmodified (114 API tests, unchanged).
- **`PATCH /catalog/colour-variants/:id` also repoints `WarehouseVariant.variationId`.** The schema comment on that field says it's "maintained on family reassignment" but nothing did that maintenance; the endpoint now finds-or-creates the (item group × new family × size) `Variation` and repoints every affected `WarehouseVariant`, mirroring `SortlyImportService`'s own find-or-create pattern.
- **Static file serving for archived photos.** `main.ts` now serves `data/photos/` at `/data/photos/*` (matches `ColourVariant.photoUrl` verbatim) — `/admin/colours` can't show a photo otherwise.
- **Fixed a crash in `cli:assign-families`.** It threw on a `ColourVariant` unique-constraint collision (two differently-categorized values lexically resolving to the same family+name) instead of routing that case to the residual queue like every other unresolvable value does. Left 159 variants stuck in `Unassigned` before the fix; 76 after (close to the plan's "~74").
- **`pnpm dev`'s `tsx watch src/main.ts` does not boot** — esbuild's decorator-metadata emission leaves `InboxWorker`'s first constructor param unresolved regardless of any change in this session (confirmed independently on a clean `git stash`, so this predates Task 4 entirely). `pnpm build && node dist/main.js` (i.e. `pnpm start`) boots cleanly and is what I used for all live verification. Did not touch this — it's a pre-existing dev-tooling gap outside Task 4's scope, but worth fixing before anyone relies on `pnpm dev` for the API.
- **No logout.** There's no `POST /auth/logout` in the API (only magic-link/verify/me), so there's nothing for a logout button to call. Left out rather than adding an API endpoint speculatively.
- **Service worker**: deferred, as the plan explicitly allows.

## 6. Concerns

- **`pnpm dev` for the API is broken** (see §5) — anyone who reaches for the documented dev command will hit the same wall I did. Worth a follow-up ticket; the fix is almost certainly switching the dev script off `tsx watch` (esbuild) or reconfiguring its TS transform, not application code.
- **Only one real market (Denver) exists in this dataset**, so the dashboard's location picker, and the "a wrong-destination box is refused at load time" behavior, could only be exercised through the already-passing API test suite, not live through the UI (there was no second market to misdirect a box to). The rejection path is wired through (`ApiError` message surfaces inline in the scan confirm sheet), just not clicked through by hand.
- **One demo dashboard row shows a negative on-hand number** ("Scarf (Stripes) / Blue: −1 / 15"). Root cause: `season-replay.spec.ts`'s dev-fixture seeding (`seedDevCatalog`, upsert-by-name) and the real imported Sortly catalog happen to collide on that one product/colour/location name, so a test run left two `SALE` fixture rows on top of my real seeded stock. Not a code defect — `LedgerReadService` is correctly, honestly summing whatever's in the ledger, negative or not — but if it's confusing during a demo, `TRUNCATE "LedgerEvent"` and re-run the seeding steps in the report's commit history to get a clean slate.
- **iOS Safari scanning is unverified on a real device** (see §4) — the fallback path was code-reviewed and its shared confirm-queue mechanics were verified live via manual entry, but nobody has held an actual iPhone up to a printed label yet.
- **74/76 warehouse variants still need a human in `/admin/colours`.** The screen makes each one fast (one tap), but nobody has actually worked the real queue down to zero.
