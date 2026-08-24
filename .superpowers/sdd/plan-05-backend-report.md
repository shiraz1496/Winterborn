# Plan 5 — Requests and Fulfilment (Backend): Implementation Report

Plan: `docs/superpowers/plans/2026-08-21-requests-and-fulfilment.md`
Branch: `plan-05-requests-fulfilment`
Scope: Tasks 1–3 (backend). Task 4 (the PWA) is out of scope for this pass.

## 1. Task status

All three tasks are complete, committed separately, and green against `pnpm typecheck && pnpm build && pnpm test` at the root.

| Task | Commit | Status |
| --- | --- | --- |
| 1. Auth and roles | `1819cff` | Done |
| 2. Restock request workflow | `343fce6` | Done |
| 3. Boxes, dispatch, load verification | `1887223` | Done |

Root-level `pnpm typecheck && pnpm build && pnpm test` passed clean after the final commit: 4 packages, **114 API tests + 8 shared-package tests**, no failures. The sole-writer CI grep (`prisma.ledgerEvent.*` outside `ledger.service.ts`) was re-run manually and is clean — nothing in `auth`, `requests`, or `fulfilment` writes to `ledger_event` directly; `BoxesService.dispatch` is the only caller of `LedgerService.transfer()`.

A schema change was required and is included in the Task 1 commit: `User.locationId` (nullable, FK to `Location`) was added via migration `20260821085640_add_user_location`. Without it there was no way for a `MARKET_MANAGER` row to say which location it belongs to — the plan's own scoping requirement ("a market manager sees only their own location") was otherwise unimplementable. `prisma migrate diff` against the committed schema shows no drift; `prisma migrate deploy` was verified to apply cleanly.

## 2. The illegal-transition table

`apps/api/src/requests/requests.service.ts` exports one map, `REQUEST_TRANSITIONS`, and one method, `transition()`, that every state change routes through — no controller or service method assigns `state` directly.

```
DRAFT      -> OPEN
OPEN       -> PACKING
PACKING    -> DISPATCHED
DISPATCHED -> ARRIVED, CLOSED
ARRIVED    -> CLOSED
CLOSED     -> (none)
```

`apps/api/test/requests.spec.ts` builds the table programmatically: every ordered pair of the 6 `RequestState` values (36 pairs total) minus the 6 legal ones the map allows, including same-state "transitions" (never legal). That leaves **30 illegal pairs**, each driven through `it.each` — not hand-picked. A companion assertion (`the table covers exactly 30 illegal pairs`) pins that count so the table can't silently shrink if `REQUEST_TRANSITIONS` changes. Every illegal case asserts both that `transition()` throws and that the row's `state` column is unchanged afterward. The legal path (`DRAFT → OPEN → PACKING → DISPATCHED → CLOSED`) is proven end to end in a separate test, including `closedAt` being stamped.

`AuditService.record()` takes the caller's own `Prisma.TransactionClient` and is only ever invoked from inside a `prisma.$transaction(async (tx) => ...)` block in `RequestsService` — the audit write and the mutation it describes share one transaction in every method (`create`, `addLine`, `updateLine`, `transition`). Tests confirm every edit path leaves an `AuditLog` row with the correct `oldValue`/`newValue` pair (line creation: `null → qty`; line update: `oldQty → newQty`; every transition: `oldState → newState`). Editing a line (`addLine` or `updateLine`) once a request has entered `PACKING` throws and is tested for both methods; both are still allowed in `DRAFT` and `OPEN`.

## 3. Dispatch: paired transfer, verified idempotent

`BoxesService.dispatch()` iterates the box's `BoxLine` rows and calls `LedgerService.transfer()` once per line, with `idempotencyKeyPrefix: transferKeyPrefix('dispatch', boxId, warehouseVariantId)` (the builder from `@winterborn/shared`, never a hand-built string).

`apps/api/test/fulfilment.spec.ts` proves:

- A box with two manifest lines (two different warehouse variants under the same family, standing in for "40 Charcoal + 20 Ash") dispatches to **exactly 4 ledger rows** (2 lines × 2 legs), each pair sharing one `transferId`, negative at the warehouse location and positive at the destination, with the correct signed quantities per variant.
- Dispatching the **same box four times** still leaves exactly 2 ledger rows for that box's single-line case: the first call reports `created: true`, every subsequent call reports `created: false` with the same `transferId` — the ledger event count never grows past the first successful pair.
- `LoadsService.dispatch()` (dispatching a whole load) delegates to `BoxesService.dispatch()` per scanned box, so the same idempotency guarantee holds whether a box is dispatched individually or as part of a load.

## 4. Load verification: wrong-destination box refused

`LoadsService.scanBox(loadId, boxId)` compares `box.destinationLocationId` to `load.destinationLocationId` **before** creating the `LoadBox` row, and throws `BadRequestException` on a mismatch. Tested directly: a box packed for "Boston" scanned against a load bound for "Denver" is rejected, and — critically — no `LoadBox` row is created (checked via a `findMany` returning empty), so the rejection doesn't leave a half-scanned state behind. A matching-destination scan is proven to succeed in the adjacent test. Scanning the same box onto the same load twice is treated as a no-op (idempotent read-back on the unique-constraint collision) rather than an error, matching the ledger's general idempotency posture, though this wasn't explicitly requested by the plan.

`Box.qrToken` is generated with `randomBytes(16).toString('base64url')` and is asserted to be neither equal to nor containing the box's own id or any packed warehouse-variant id — it carries no contents, matching spec §9.4 ("contents live in BoxLine"). `GET /boxes/:id/label` returns `{ qrToken, destinationLocationId, destinationLocationName, lineCount, packedAt }` for the frontend to render/print; label rendering itself is Task 4's job.

## 5. Role scoping: enforcement and tests

Two layers:

- **Route layer**: `JwtGuard` authenticates the session cookie and attaches `request.user` (id, email, name, role, `locationId`); `RolesGuard` reads `@Roles(...)` metadata and 403s a role not in the list. Unit-tested directly in `auth.spec.ts` by constructing a minimal `ExecutionContext` and a stubbed `Reflector` — this exercises `RolesGuard`'s own allow/deny decision, not Nest's metadata plumbing (the plan's testing policy explicitly says to skip framework wiring). A `MARKET_MANAGER` against a route requiring `WAREHOUSE` throws `insufficient role`; a `WAREHOUSE` user against the same route is allowed; a route with no `@Roles(...)` at all lets any authenticated role through.
- **Data layer** (the one that actually matters for "cannot list or touch another location's requests"): `RequestsService` has a single private `assertLocationAccess(actor, locationId)` called from `get`, `addLine`, `updateLine`, and `transition`, and `list()` filters its `where` clause to `locationId: actor.locationId` when `actor.role === 'MARKET_MANAGER'`. Every other role sees everything, matching spec §9.2.

`requests.spec.ts` proves this with two locations (the seeded Denver plus an ad-hoc Boston): a Denver-scoped market manager's `list()` never returns the Boston request; `get`, `addLine`, and `transition` against the Boston request all throw for that actor; the same actor can freely list/get/create against their own location.

`/auth/me` was proven over real HTTP (a booted `NestApplication`, native `fetch`, real cookies) rather than mocked, since that round trip — magic link → verify → cookie → guard → user — is the actual feature under test, not framework wiring: 401 with no cookie, 200 with the cookie set by `/auth/verify`, correct user in the body.

## 6. Deviations from the plan text

- **`transferKeyPrefix` signature**: the plan's prose says `transferKeyPrefix(boxId, warehouseVariantId)`, but the actual exported signature (from Plan 4's work) is `transferKeyPrefix(kind: 'dispatch' | 'return', ...parts)`. Used it as implemented: `transferKeyPrefix('dispatch', boxId, warehouseVariantId)`.
- **`User.locationId` schema addition** (see §1) — a migration the plan's "do not add migrations unless something is genuinely missing" clause anticipates. No other schema changes were made.
- **`loads.controller.ts`**: not named in the plan's Task 3 file list (only `boxes.controller.ts` and `loads.service.ts` are), but "REST under `/boxes` and `/loads`" requires it, so it was added alongside `loads.service.ts`.
- **JWT implementation**: no `jsonwebtoken` or `@nestjs/jwt` dependency was added. `apps/api/src/auth/jwt.ts` is a ~40-line dependency-free HS256 sign/verify built on `node:crypto`, in keeping with spec §10.1 ("keep it boring") and avoiding a new dependency for what the app needs (one algorithm, no rotation).
- **Cookie parsing**: no `cookie-parser` dependency either; `apps/api/src/auth/cookies.ts` parses the raw `Cookie` header directly, mirroring the existing pattern in `webhook.controller.ts` of narrow hand-written interfaces instead of pulling in `@types/express`.
- **Magic-link response shape**: `POST /auth/magic-link` returns `{ ok: true, devLink }` when `MAIL_TRANSPORT === 'console'` (the only transport implemented), in addition to printing the link via `console.log`. This directly serves Task 4's stated need ("dev shows the link inline") without building any of Task 4 itself, and costs nothing beyond the one field.
- **CLI user emails**: `apps/api/src/cli/seed-users.ts` reads `SEED_OWNER_EMAIL` / `SEED_WAREHOUSE_EMAIL` / `SEED_MARKET_MANAGER_EMAIL` / `SEED_OPERATOR_EMAIL` from the environment with generic `*@example.com` fallbacks, rather than hardcoding the real names from spec §9.2 (Joel, Casey) — Global Constraints rule out client-identifying data in committed files, even though those two names already appear in the (separately committed) spec document.

## 7. Concerns / follow-ups for Task 4 or later

- **Session revocation**: `JwtGuard` re-checks the `Session` row (and the `User.isActive` flag) on every request rather than trusting the JWT payload alone, so a deactivated user or an expired session loses access immediately. There's no explicit logout endpoint yet (delete the `Session` row + clear the cookie) — trivial to add when the PWA needs it.
- **`PackBoxInput`/`CreateLoadInput` are not Zod-validated** the way request bodies are in `packages/shared` — the plan only calls out shared schemas for Task 2 ("requests"), so Task 3's inputs are validated with plain TypeScript types and a couple of manual checks (positive quantities, at least one line). If Task 4 needs compile-time contract sharing for the pack/scan/dispatch payloads the way it has for requests, that's a small follow-up, not a redesign.
- **`BoxesService.dispatch` looks up the warehouse location by `kind: 'WAREHOUSE'`** via `findFirstOrThrow`, assuming exactly one warehouse location exists — true today and consistent with the seed/spec, but worth flagging if a second warehouse is ever added.
- **Load-level destination vs. box-level destination**: a box's `destinationLocationId` is set at pack time and is independent of any request it's linked to; nothing currently cross-checks that a packed box's destination matches its originating `RestockRequest.locationId`. Not required by the plan and not the wrong-van check it asks for (that's load verification, which is implemented), but worth a look if boxes start getting packed against the wrong request in practice.
