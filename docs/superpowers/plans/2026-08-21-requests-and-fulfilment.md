# Requests and Fulfilment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** The workflow the warehouse actually uses. Log in, see what a market is low on, raise a restock request, pack it into labelled boxes, scan them onto a van, and have the dispatch post itself to the ledger.

**Architecture:** NestJS owns auth, the request state machine and fulfilment. Next.js is a phone-first installable PWA that talks to the API and never to the database. Dispatch writes to the ledger only through `LedgerService.transfer`.

**Tech Stack:** NestJS, Prisma, Next.js 15 App Router, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md` §9.

## Global Constraints

- **`LedgerService` is the sole writer to `ledger_event`.** Dispatch calls `transfer()`; nothing else writes.
- **Every request edit is audited.** `AuditLog` records who, when, and old to new. Not optional: both sides can edit before packing, and the spec makes this the record that replaces one person's memory.
- **The QR encodes a box token only.** Contents live in `BoxLine`, so a manifest edited before dispatch never orphans its label.
- **Nothing is scanned at a market.** All discipline lives at the warehouse. Market staff change one thing: tapping a colour at the till.
- **Counts post at dispatch.** An `arrived` state may exist for visibility, but no math depends on it.
- **Idempotency keys come from `@winterborn/shared` builders**, never inline.
- Roles: `OWNER`, `WAREHOUSE`, `MARKET_MANAGER`, `OPERATOR`. A market manager sees only their own location.
- Sandbox only. `data/` stays gitignored, no client figures in committed files.

## Testing Policy

Test the state machine's legal and illegal transitions, that dispatch writes a correct paired transfer, that load verification rejects a wrong-destination box, and that role scoping actually scopes. Skip framework wiring and CRUD happy paths.

---

### Task 1: Auth and roles

**Files:** `apps/api/src/auth/{auth.module.ts,auth.service.ts,auth.controller.ts,jwt.guard.ts,roles.guard.ts,roles.decorator.ts}`, `apps/api/test/auth.spec.ts`

**Produces:** `POST /auth/magic-link`, `POST /auth/verify`, `GET /auth/me`, `@Roles(...)` decorator, `JwtGuard`, `RolesGuard`, `CurrentUser` param decorator.

- [ ] **1.** Tests: a magic link token is single-use and expires; a consumed token is rejected; `@Roles('WAREHOUSE')` returns 403 for a `MARKET_MANAGER`; `/auth/me` returns the user for a valid cookie and 401 without one; **token values are stored hashed, never in plaintext**.

- [ ] **2.** Implement. Magic link: generate a random token, store only its SHA-256 hash in `MagicLinkToken`, email it. **Mail transport is `console` for now** — print the link — since no sending domain is verified yet. Verify: hash the presented token, look it up, check expiry and `consumedAt`, stamp it consumed, issue a JWT in an httpOnly, SameSite=Lax cookie, create a `Session`.

- [ ] **3.** Seed the four users from `.env` or a CLI so login works locally. Commit `feat(api): magic-link auth with role guards`.

---

### Task 2: Restock request workflow

**Files:** `apps/api/src/requests/{requests.module.ts,requests.service.ts,requests.controller.ts,audit.service.ts}`, `apps/api/test/requests.spec.ts`, shared schemas in `packages/shared/src/requests.ts`

**Produces:** `RequestsService.create/addLine/updateLine/transition/list`, `AuditService.record`, REST under `/requests`, and Zod schemas exported from `@winterborn/shared`.

- [ ] **1.** Tests, and these are the ones that matter:
  - the legal path `DRAFT → OPEN → PACKING → DISPATCHED → CLOSED` succeeds
  - **every illegal transition is rejected** — table-drive this, do not hand-write a few
  - editing a line after `PACKING` is refused
  - every edit writes an `AuditLog` row carrying old and new values
  - a `MARKET_MANAGER` cannot list or touch another location's requests

- [ ] **2.** Implement. Transitions go through one `transition()` method holding an explicit allowed-transitions map; no controller sets `state` directly. `AuditService.record` is called inside the same transaction as the mutation, so an edit can never land unaudited.

- [ ] **3.** Commit `feat(api): restock request workflow with audit logging`.

---

### Task 3: Boxes, dispatch and load verification

**Files:** `apps/api/src/fulfilment/{fulfilment.module.ts,boxes.service.ts,boxes.controller.ts,loads.service.ts}`, `apps/api/test/fulfilment.spec.ts`

**Produces:** `BoxesService.pack/addLine/dispatch`, `LoadsService.create/scanBox/dispatch`, REST under `/boxes` and `/loads`.

- [ ] **1.** Tests:
  - packing resolves a family-level request line to concrete variants, and the box manifest records **variant** level
  - `dispatch` writes exactly one paired transfer per manifest line: negative at the warehouse, positive at the destination, sharing a `transferId`
  - dispatching the same box twice is idempotent and does not double-count
  - **load verification rejects a box whose destination differs from the load's** — this is the cheap high-value check that catches wrong-van errors nobody currently notices until a market opens the box
  - a box's `qrToken` is opaque and carries no contents

- [ ] **2.** Implement. `dispatch` iterates `BoxLine` rows and calls `LedgerService.transfer` with `transferKeyPrefix(boxId, warehouseVariantId)`, so re-dispatch is a no-op. Generate `qrToken` as a random opaque string.

- [ ] **3.** Add `GET /boxes/:id/label` returning label data for browser printing — box token, destination, line count, packed date. Rendering is the frontend's job.

- [ ] **4.** Commit `feat(api): box packing, dispatch to ledger, load verification`.

---

### Task 4: The PWA

**Files:** `apps/web/app/**`, `apps/web/lib/api.ts`, `apps/web/public/manifest.webmanifest`

**Screens, phone-first, all behind auth:**
- `/login` — email in, magic link out, dev shows the link inline
- `/` — dashboard: per-market on-hand by family, low-stock list, open requests
- `/requests` and `/requests/[id]` — list, detail, edit lines before packing
- `/pack/[requestId]` — resolve family quantities to variants, build boxes, print labels
- `/scan` — camera QR for dispatch and load verification
- `/admin/colours` — the residual queue, showing each variant's archived photo beside the family picker

- [ ] **1.** `lib/api.ts` wraps fetch with credentials and parses every response through the `@winterborn/shared` Zod schemas, so a backend change that breaks the contract fails loudly in the client rather than rendering wrong numbers.

- [ ] **2.** Scanning uses the native `BarcodeDetector` where available and falls back to `@zxing/browser` for iOS Safari. **Multiple codes in one frame are all decoded, but each box is confirmed by a deliberate tap.** The scan finds; the human confirms. Auto-confirming whatever the camera glimpsed is how a box still on the truck gets marked dispatched.

- [ ] **3.** PWA: manifest, icons, installable to home screen. Service worker can wait; installability cannot, since iOS web push requires it.

- [ ] **4.** Design it properly. This is the first thing anyone sees, it is used one-handed in a warehouse, and it should not look like unstyled scaffolding. Load the `frontend-design` skill before writing the UI.

- [ ] **5.** Commit `feat(web): restock PWA`.

---

## Definition of Done

`pnpm typecheck && pnpm build && pnpm test` green, and:

1. Illegal state transitions are rejected by a table-driven test, not by inspection.
2. Every request edit leaves an audit row with old and new values.
3. Dispatching a box writes a correct paired transfer and is idempotent.
4. A wrong-destination box is refused at load time.
5. A market manager cannot see another location's data.
6. The PWA installs to a phone home screen and scans a QR code.
