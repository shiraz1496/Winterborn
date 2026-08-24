# Handover

Start here. Read this file, then the four documents in "Read these, in order".

---

## What this is

Winterborn Alpaca LLC sells alpaca goods at **14 US Christmas markets**. Roughly **$2.9M** of revenue lands in eight weeks, across **41,226 transactions**. Square POS is the till and works fine. Two things are broken:

**Square has never recorded a single stock count.** Not once, at any location. Every quantity lives in Sortly, a warehouse app that has no connection to Square.

**Square records almost no colour.** 95.2% of season revenue has no colour attached. Scarves are 29% of the business ($860k) and sell as flat items with no variations at all, while the warehouse tracks 26 colour variants of one scarf design. So "red scarves are selling, white ones are sitting" is invisible.

The person who held all of this in their head left, and it left with them.

**So this system does two things.** It restructures the Square catalog so the till records colour, and it owns everything Square does not: warehouse stock, restock requests, box-level dispatch, per-location counts, and season-close reconciliation.

**The governing idea:** inventory is never a stored number. It is derived.

```
on_hand(variation, location) = Σ dispatched − Σ sold − Σ written_off
```

Dispatches are ours. Sales live in Square permanently. So any count can be recomputed from scratch at any time, and a missed webhook or a bad deploy cannot cause permanent drift. Everything in the architecture protects that property. If you change one thing after reading this, do not break it.

---

## Read these, in order

1. **`Winterborn-Dev-Brief-Document-2.pdf`** — the client-agreed scope. This is the contract. When in doubt, it wins.
2. **`docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md`** — the design spec, measured against the client's real exports rather than assumed. Note the sections marked as *superseding* the original audit; the audit was wrong in four places.
3. **`docs/superpowers/decisions/2026-08-19-flat-item-migration.md`** — the authority on how the catalog migration must behave, proven against Square sandbox. **Read this before touching any catalog write code.** It is not optional background.
4. **`docs/DEPLOY.md`** — environment variables, owner-gated credentials, and the catalog write-path runbook.

Then, if you want the reasoning rather than the conclusions: `.superpowers/sdd/*/progress.md` holds every ruling made during the build, every review finding, and how each was resolved. `.superpowers/sdd/*-report.md` holds the per-task reports.

---

## Local setup

You need Docker (colima works), Node 20+, and pnpm 9.

```bash
# 1. Infrastructure
docker compose up -d          # Postgres on 5432, Redis on 6379

# 2. Environment. Copy .env from the handover zip, or from .env.example.
#    JWT_SECRET must be set or the API refuses to boot, deliberately:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

export DATABASE_URL="postgresql://winterborn:winterborn@localhost:5432/winterborn"

# 3. Install and migrate
pnpm install
pnpm --filter @winterborn/api db:generate
pnpm --filter @winterborn/api db:deploy

# 4. Seed, in this order. Each is idempotent and re-runnable.
pnpm --filter @winterborn/api cli:seed-users
pnpm --filter @winterborn/api cli:import-sortly -- --file ../../data/sortly.csv
pnpm --filter @winterborn/api cli:assign-families
pnpm --filter @winterborn/api cli:generate-skus
pnpm --filter @winterborn/api cli:seed-thresholds
pnpm --filter @winterborn/api cli:replay-season -- --dir ../../data/square-2025/item-detail

# 5. Run
pnpm --filter @winterborn/api dev    # :3001
pnpm --filter @winterborn/web dev    # :3000
```

Log in at `http://localhost:3000/login` as `operator@example.com` / `winterborn-dev`.

**Sanity check after seeding:** 564 items, 42,428 units, 96 till SKUs, 517 warehouse SKUs, 0 collisions, 42,705 ledger rows with 42,705 distinct idempotency keys. If any of those differ, something is wrong; do not proceed to a catalog write.

---

## Traps that have already cost time

**The test suite truncates the dev database.** `seedDevCatalog` wipes every table, so running `pnpm test` destroys your seeded catalog and ledger. This bit us four times. Re-run the seed commands above. **Fixing this properly (a separate test database) is the first thing I would do.**

**`tsx` cannot run the API.** It uses esbuild, which does not emit decorator metadata, so NestJS cannot resolve any constructor dependency. The dev script uses `@swc-node/register` for this reason. Do not "simplify" it back to `tsx`.

**`pnpm --filter X db:migrate -- --name Y` does not forward the name.** Use `pnpm --filter @winterborn/api exec prisma migrate dev --name Y`.

**Do not run `pnpm build` while a dev server is running.** It rewrites `.next` underneath it and every asset 404s while the page still loads. Looks like a catastrophic bug; is not.

**`LedgerService` is the sole writer to `ledger_event`.** A CI step enforces this by grep. Do not insert directly, not even in a test fixture. `ledger_event` is also append-only at the database level via a trigger; correct a mistake by appending a `CORRECTION` row.

**Idempotency keys come from the builders in `@winterborn/shared`.** Never construct one inline. If the webhook path and the poll build keys differently for the same sale, every sale double-counts permanently, and the table is append-only.

---

## What is done, and what is not

Stage 1, as Document 2 defines it, is complete except for two lines that both wait on the same thing.

| Document 2, Stage 1 | State |
| --- | --- |
| Flat-item migration prototype + sign-off | Done, decision record written |
| Catalog restructure, 5 categories + till family sets | Scripts built and proven in sandbox. **Not run against production.** 34 of 50 group mappings still need a human |
| SKU generation + write to Square + collision checks | Generated, zero collisions. **Not written to Square** |
| Core app: auth, roles, request workflow, edit logging | Done |
| Pack/label/dispatch + QR + load verification | Done |
| Square sync: webhooks, signature verify, poll, ledger | Done, replayed at full season volume |
| Threshold engine (manual-review mode) + dashboard v1 | Done |
| Pilot deploy, opening-load support, on-market watch | Not started. It is an event, not code |

**Stage 2 is deliberately untouched**: warehouse intake (the actual Sortly replacement), the write-off flow, automated alerts, and all-markets rollout. Late October, per the brief. Building it early changes what the client agreed to.

**Two human passes need no credentials and can be done now:** resolving the 34 unmatched group joins, and clearing the residual colour queue at `/admin/colours` against the archived photos.

---

## Blocked on the client

**One Square access token**, scoped to exactly:

```
ITEMS_READ  ITEMS_WRITE  ORDERS_READ  MERCHANT_PROFILE_READ
```

Only the account owner can create it; Square's Developer Console is owner-only and a team-member login gets a 403 there. That token is the only thing standing between us and finishing Stage 1.

**Which market is the 18 September pilot**, and whether it is one of the existing 14 or a new one. If new, it does not exist in Square, has no history to seed reorder points from, and is almost certainly one of the eleven locations with no tax rate configured.

**Not blocking today, but ask:** has the 2026 stock order been placed, and when does it land? The catalog freezes 12 September. Anything arriving after that has no home, and if stock lands in October the warehouse intake module has to move earlier than the brief plans.

---

## Before you write to the live catalog

Six guards exist. Do not route around them.

```bash
pnpm --filter @winterborn/api cli:catalog-preflight -- --expected-env production --expected-locations 14
pnpm --filter @winterborn/api cli:catalog-backup
pnpm --filter @winterborn/api cli:catalog-plan -- --category Scarves     # writes a diff, changes nothing
# read the diff, then:
pnpm --filter @winterborn/api cli:catalog-apply -- --plan <file>
pnpm --filter @winterborn/api cli:catalog-verify -- --plan <file>
# if needed:
pnpm --filter @winterborn/api cli:catalog-rollback -- --plan <file>
```

`apply` refuses to start without a backup newer than the plan. It may only touch object IDs in the plan you reviewed. Deletes are blocked at the client level. A category that fails verify halts the run. Rollback is proven end to end in sandbox.

**Do the single live low-volume item first**, per the decision record. `Socks (Tech)` is the recommended subject: three sizes, currently enabled at zero locations, so a mistake costs nothing. Confirm historical order lines still resolve and the Item Sales report still aggregates **before** the bulk run. That reporting check is the one thing sandbox could not prove, and it is where the client's year-over-year figure is read from.

---

## Known debt, in the order I would fix it

1. **Separate test database.** The truncation problem above.
2. **QR scanning has never been tested with a real camera.** Verified only by manual token entry.
3. **47 of 559 product photos failed to download.** Retry while the client's Sortly subscription is still live; those links die with it.
4. Three findings deferred under a speed instruction during the catalog plan: test coverage for two import bugs, two vacuously-passing parser assertions, and a silent fallback that should warn. See `.superpowers/sdd/2026-08-21-seed-and-catalog/progress.md`.
5. Only one per-location price override was exercised in the migration tests; the real catalog has rows carrying two simultaneously.
