# Thresholds, Dashboard and Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Close Stage 1. Seed reorder thresholds from last season's real velocity, auto-draft restock requests when stock falls below them, harden the dashboard into the one screen the Monday review runs on, and make the system deployable.

**Spec:** `docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md` §5.6, §9.7, §9.9, §10.2.

## Global Constraints

- **Stage 1 is manual-review mode.** Thresholds exist and auto-draft requests, but **no automated alerts fire**. An operator watches the dashboard daily. Automated alerting is Stage 2, deliberately.
- **Auto-drafts are deduped.** Never stack two drafts for the same location and variation.
- `LedgerService` remains the sole writer to `ledger_event`.
- **No colour-level prediction.** 2025 data carries colour on 4.8% of revenue. Style-level seeding is fine; anything implying colour prediction is out.
- Idempotency keys from `@winterborn/shared` builders only.
- `data/` gitignored, no client figures in committed files.
- **Do not create hosting accounts or deploy anything.** Produce configuration and documentation only.

---

### Task 1: Threshold engine

**Files:** `apps/api/src/thresholds/{thresholds.module.ts,thresholds.service.ts,velocity-seeder.ts,thresholds.controller.ts}`, `apps/api/src/cli/seed-thresholds.ts`, `apps/api/test/thresholds.spec.ts`

**Produces:** `ThresholdsService.evaluate(variationId, locationId)`, `.autoDraft()`, `VelocitySeeder.seedFromSeason(dir)`, `cli:seed-thresholds`, REST under `/thresholds`.

- [ ] **1.** Tests:
  - a ledger change dropping stock below `minLevel` produces exactly one auto-drafted `RestockRequest` line
  - a second evaluation while that draft is still open produces **no** second draft
  - a location above threshold produces nothing
  - closing the draft and dropping below again produces a new one
  - seeding from a fixture computes a sane min level and never a negative one

- [ ] **2.** Implement. `evaluate` derives current on-hand via `LedgerReadService`, compares to `Threshold.minLevel`, and on breach either creates a `DRAFT` request for that location or appends a line to the existing open draft. Dedupe on `(locationId, variationId)` across `DRAFT` and `OPEN`.

- [ ] **3.** `VelocitySeeder` reads `data/square-2025/item-detail/*.csv`, computes weekly units sold per item per location, and sets `minLevel` to roughly one week of peak-season velocity, floored at a small minimum so slow movers still restock. Write the formula you chose into the code comment; a future reader needs to know why a number is what it is. `source: SEEDED`.

- [ ] **4.** Run against real data. Report thresholds created, the distribution, and the top ten by min level. Commit `feat(api): threshold engine and velocity seeding`.

---

### Task 2: Dashboard and observability

**Files:** `apps/api/src/health/health.controller.ts`, `apps/web/app/page.tsx` and supporting components

**The dashboard is one screen.** It serves the review-Monday / dispatch-Friday cadence the audit established. Per market: on-hand by family, sales this week, open and in-transit requests. Account-wide: the low-stock list across all 14 markets, and the decision queue.

- [ ] **1.** `GET /health` returns, and this is what makes the system supportable by one person during a $2.9M season: last successful poll per location, inbox backlog depth, oldest unprocessed inbox row, dead-letter count, and database connectivity. Not a literal `{status:'ok'}` — that tells nobody anything at 2am.

- [ ] **2.** Harden the dashboard against real volume. It reads 42,000+ ledger rows; use the bulk endpoints, never a per-row call. A screen listing 2,000 variations that calls a single-variation endpoint per row will feel broken long before the ledger does.

- [ ] **3.** Add the decision queue: auto-drafted requests awaiting review, newest first, each showing what tripped it.

- [ ] **4.** Commit `feat: health endpoint and dashboard hardening`.

---

### Task 3: Deploy configuration

**Files:** `apps/api/Dockerfile`, `render.yaml`, `apps/web/vercel.json`, `docs/DEPLOY.md`, `.env.example`

**Produce configuration and documentation only. Do not create accounts, do not deploy.**

- [ ] **1.** `apps/api/Dockerfile`: multi-stage, pnpm, `prisma generate` during build, runs `dist/main.js`. Remember the build emits to `dist/main.js` via `tsconfig.build.json`.

- [ ] **2.** `render.yaml`: three services sharing one image — web service, background worker draining the inbox, and a cron running the reconciliation poll every 20 minutes. Plus Postgres. Region US-East.

- [ ] **3.** `docs/DEPLOY.md`: every environment variable and where it comes from; which are owner-gated and cannot be self-served; the production cutover order; and how to rotate the Square token. Written for someone who is not you and does not have this conversation.

- [ ] **4.** Update `.env.example` to match reality.

- [ ] **5.** Commit `chore: deploy configuration and runbook`.

---

## Definition of Done

`pnpm typecheck && pnpm build && pnpm test` green, and:

1. A stock drop below threshold auto-drafts once and only once.
2. Thresholds seed from real 2025 velocity with a documented formula.
3. `/health` reports poll freshness, inbox backlog and dead letters.
4. The dashboard renders against 42,000+ ledger rows without per-row calls.
5. `docs/DEPLOY.md` is complete enough for someone else to deploy from.
