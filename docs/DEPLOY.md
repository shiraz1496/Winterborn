# Deploying Winterborn

This is written for whoever runs the actual cutover -- not necessarily
the person who wrote the code. It assumes you can read a `.env` file and
use the Render/Vercel dashboards, and nothing else.

**Nothing in this repo has been deployed.** `render.yaml`,
`apps/web/vercel.json` and `apps/api/Dockerfile` are configuration only,
written and locally validated (`docker build` succeeded against this
Dockerfile -- see the bottom of this file) but no hosting account, Render
service, Vercel project, or DNS record exists yet. Creating those is a
deliberate call the client makes, not something automated during
development.

---

## 1. What gets deployed where, and why

| Piece | Platform | Why |
| --- | --- | --- |
| `apps/api` (REST API, Square webhook, background worker, cron) | **Render** | Docker web service + background worker + cron job as first-class types, one Blueprint file, stable HTTPS from day one (Square will not deliver webhooks to plain HTTP) |
| `apps/web` (the PWA staff use) | **Vercel** | Native Next.js support, edge CDN, preview deploy per branch |
| Postgres | **Render (this blueprint) for staging** / **Neon recommended for production** | See §2 below -- this is a real, documented divergence between what `render.yaml` declares and what spec §4.4 recommends for production, not an oversight |
| Redis | Provisioned by `docker-compose.yml` for local dev only | **Not used by any deployed service.** See §6 |

Region for every Render resource: **Ohio** (Render's US-East region --
there is no region literally named `us-east`). Matches the client's
US-East market footprint and Square's own latency profile.

---

## 2. Database: Render Postgres vs Neon

`render.yaml` declares a Render-managed Postgres database so the
blueprint is self-contained -- pointing Render at this repo and applying
the blueprint stands up a fully working environment with no other setup,
which is worth having for a staging rehearsal.

**Spec §4.4's recommendation for production is Neon instead**, specifically
for branching (fork production data to rehearse a ledger replay or a
destructive migration, then throw the branch away) and point-in-time
recovery. Per spec §4.5, switching is an environment-variable change, not
a code change:

1. Create the Neon project (US-East region), get its connection string.
2. In the Render dashboard, on `winterborn-api` (and the worker and cron
   services), replace the `DATABASE_URL` env var's `fromDatabase` binding
   with the literal Neon connection string.
3. Delete the `databases:` block's Render Postgres instance once the
   Neon-backed environment is verified working (`GET /health` reports
   `database.connected: true`) -- don't delete it before, or you have no
   fallback mid-cutover.

Whoever runs cutover should decide once, up front, whether staging and
production both move to Neon or only production does. This document
does not make that call.

---

## 3. Environment variables

Every variable read anywhere in the codebase (verified by grepping
`process.env` across `apps/api` and `apps/web`), what it's for, where the
value comes from, and who can produce it.

### apps/api

| Variable | Purpose | Source | Owner-gated? |
| --- | --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | Render/Neon dashboard | No |
| `NODE_ENV` | `production` flips the session cookie's `Secure` flag on (`auth.controller.ts`) | Set literally in `render.yaml` | No |
| `API_PORT` | Port the Nest app listens on | Set literally (3001) | No |
| `WEB_ORIGIN` | CORS allow-origin (`main.ts`) | The deployed `apps/web` URL, known only once that Vercel project exists | No, but sequenced -- see §5 |
| `JWT_SECRET` | Signs session JWTs | `generateValue: true` in `render.yaml` -- Render generates and stores it, nobody needs to know the value | No |
| `SQUARE_ENV` | `sandbox` or `production` | Literal, flipped once at cutover | No |
| `SQUARE_APPLICATION_ID` | Square app identity | Square Developer Console | **YES -- see §4** |
| `SQUARE_ACCESS_TOKEN` | Square API auth | Square Developer Console | **YES -- see §4** |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Verifies every inbound webhook (`webhook.controller.ts`, constant-time HMAC compare) | Square Developer Console, created against this service's real URL | **YES -- see §4** |
| `SQUARE_WEBHOOK_NOTIFICATION_URL` | Must byte-for-byte match the URL registered with Square -- the signature is HMAC'd over `notificationUrl + body` | `https://<render-service>.onrender.com/square/webhook` | No, but easy to get wrong -- trailing slash or `http` vs `https` silently fails every webhook until the 20-minute poll self-heals it |
| `INBOX_DRAIN_INTERVAL_MS` | Poll interval for `cli:drain-inbox` | Literal, defaults to 10000 if unset | No |

Auth is password-based (`auth.service.ts`, Argon2id via `@node-rs/argon2`)
-- no mail transport, no sending domain, no `MAIL_TRANSPORT`/`RESEND_API_KEY`
env vars. Login has no external dependency; the API refuses to boot at all
without `JWT_SECRET` (`main.ts`). Staff accounts (four to six people on a
seasonal team) are created and password-reset the same way: re-run
`cli:seed-users` with `SEED_*_PASSWORD` set on the target environment.
There is deliberately no self-service password reset flow.

### apps/web (Vercel)

| Variable | Purpose | Source |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | The only network config in `apps/web/lib/api.ts` -- baked into the browser bundle at build time (`NEXT_PUBLIC_` prefix) | The deployed `apps/api` Render URL. Set in Vercel project settings, not in `vercel.json` -- Vercel doesn't store secrets/config in that file, same convention as Render's `sync: false` |

Nothing else. Vercel's own project settings need **Root Directory** set
to `apps/web` -- `vercel.json`'s `installCommand`/`buildCommand` `cd
../..` steps assume that.

---

## 4. Owner-gated credentials (Joel only)

Per spec §7.5, these cannot be self-served by whoever runs the
deployment -- they require Joel's own Square Developer Console access:

1. **`SQUARE_APPLICATION_ID` / `SQUARE_ACCESS_TOKEN` (production).** Joel
   creates the app in the Square Developer Console under his own
   business account and issues a production access token scoped to
   **Catalog, Inventory, Orders, Merchants**. Nobody else can do this --
   it's tied to the Square account that owns the real POS data. If this
   isn't in hand, everything runs against sandbox indefinitely; spec §7.5
   says to escalate if it's not available by Aug 22.
2. **`SQUARE_WEBHOOK_SIGNATURE_KEY` (production).** Created in the same
   console, against the real `SQUARE_WEBHOOK_NOTIFICATION_URL` above --
   this has to happen *after* `winterborn-api` has a real public URL, so
   it's a second owner-gated step, not bundled with the token.

Auth needs nothing from Joel: login is a password checked against
`User.passwordHash`, with no sending domain, no DNS record, and no third
party in the path.

Everything else in the table above (`JWT_SECRET`, `DATABASE_URL`,
`WEB_ORIGIN`, ports, timeouts) can be produced by whoever runs the
deploy, no owner involvement needed.

---

## 5. Production cutover order, and one thing that must not be skipped

1. Deploy `apps/api` to Render (this blueprint) against **sandbox**
   Square credentials. Confirm `GET /health` reports
   `database.connected: true` and an empty inbox backlog.
2. Deploy `apps/web` to Vercel, `NEXT_PUBLIC_API_URL` pointing at the
   Render URL from step 1. Confirm the dashboard renders (see the
   verification note in this repo's plan-06 report for what "renders"
   was checked against).
3. Set `WEB_ORIGIN` on `winterborn-api` to the real Vercel URL from step
   2 and redeploy -- CORS is wrong until this points at the actual
   deployed web app, not `localhost:3000`.
4. Run `cli:seed-users` against the production `DATABASE_URL` with real
   `SEED_*_PASSWORD` values (not the dev defaults) so staff have accounts
   to log in with. Hand the printed email/password pairs to staff over a
   channel you trust; the CLI prints them once, to your terminal, and
   they are not retrievable afterward except by re-running the seeder.
5. **BLOCKING GAP -- the session cookie will not survive Vercel + Render
   being on different domains, as currently coded.** `auth.controller.ts`
   sets the session cookie `SameSite: 'lax'`. A `Lax` cookie is not sent
   on cross-site `fetch()` calls (only on top-level navigations) --  and
   a Vercel `*.vercel.app` domain and a Render `*.onrender.com` domain
   are different sites by the browser's definition, no matter how CORS
   is configured. Every authenticated call `apps/web/lib/api.ts` makes
   with `credentials: 'include'` would silently carry no cookie, and
   every request would 401. Two ways to fix it, neither done yet:
   - Put both services on **subdomains of one apex domain** you control
     (e.g. `app.winterborn.example` and `api.winterborn.example`) --
     subdomains of the same registrable domain count as the same site,
     so `SameSite: 'lax'` keeps working unmodified. This is the
     lower-risk fix and doesn't touch `auth.controller.ts`.
   - Or change the cookie to `SameSite: 'none'; Secure` in
     `auth.controller.ts`, which works across arbitrary domains but is a
     code change and slightly weakens CSRF posture (mitigate with
     `SameSite=None` plus the existing `httpOnly`/`Secure` combination
     and no state-changing GET routes, which is already true here).
   Pick one before real users hit a deployed environment; do not
   discover this from a support ticket during the pilot.
6. Register the production Square webhook subscription (Joel, per §4),
   flip `SQUARE_ENV=production` and the three Square env vars, redeploy.
7. Confirm `winterborn-inbox-worker` and `winterborn-reconciliation-poll`
   are both running against the same production `DATABASE_URL` and
   `SQUARE_ACCESS_TOKEN` as the web service -- `render.yaml` wires this
   by construction (same blueprint, `fromDatabase` binding), but verify
   after any manual env var edit in the dashboard, since those are exactly
   the edits `render.yaml` can't enforce once made outside git.

---

## 6. Redis: provisioned, not wired up

`docker-compose.yml` and `.env.example` both carry a `REDIS_URL` /
`redis` service. **No code in this repo reads it.** Spec §4.3 describes a
BullMQ-backed worker (inbox processing, outbound Square calls, threshold
evaluation all as queue consumers); what actually shipped instead is
`apps/api/src/cli/drain-inbox.ts`, a plain interval loop, and threshold
evaluation is a synchronous call from the dashboard/decision-queue read
path, not a queue job. Do not provision Upstash (spec §4.4's Redis
choice) for this deploy -- there is nothing to point it at. If a future
stage moves inbox processing or Square outbound calls onto a real queue,
this is the point in the codebase where that decision needs to be made
concretely, not assumed to already be true.

---

## 7. Rotating the Square access token

Square access tokens (per spec §7.5, Catalog/Inventory/Orders/Merchants
scope) don't auto-expire on a fixed schedule, but rotate on suspected
compromise or Joel's own security policy:

1. In the Square Developer Console, issue a **new** token on the same
   application (don't delete the old one yet -- overlap avoids a gap).
2. Update `SQUARE_ACCESS_TOKEN` on all three Render services
   (`winterborn-api`, `winterborn-inbox-worker`,
   `winterborn-reconciliation-poll`) -- all three call the Square API
   independently (`square-client.ts`'s `fetchOrder`/`searchOrders`) and
   all three need the new value. `render.yaml` marks this `sync: false`
   in each service block deliberately: Render does not propagate one
   service's env var edit to another, so this is three manual edits, not
   one.
3. Redeploy (or let Render's own restart-on-env-change do it).
4. Confirm `GET /health` still reports clean poll timestamps advancing
   for every market, and check the Render logs for
   `winterborn-inbox-worker`/`winterborn-reconciliation-poll` for any
   auth failure in the minutes after rotation.
5. Once confirmed, revoke the old token in the Square console. Don't
   revoke it in the same step as issuing the new one -- if step 2 is
   incomplete on any service, that service silently starts failing every
   Square call until someone notices `GET /health`'s poll timestamps have
   stopped advancing.

---

## 8. Local validation performed during this pass

`docker build -f apps/api/Dockerfile -t winterborn-api .` was run from
the repo root against a local Docker daemon (colima) to catch obvious
Dockerfile mistakes before writing this document -- see the plan-06
report for the exact outcome. No image was pushed anywhere and no
container was deployed; this was a local build-only sanity check.
