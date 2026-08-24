# Auth: magic-link → password login

Branch: `auth-password` (off `master`, not yet committed/merged).

## What changed

**Database** (additive migration `20260821120000_password_auth`, hand-written to
match this repo's existing convention of hand-written migrations for anything
`prisma migrate dev` shouldn't auto-generate):
- `User.passwordHash TEXT` (nullable) added.
- `MagicLinkToken` table dropped.
- Applied via `prisma migrate deploy` against the real dev DB. Verified before
  and after: `LedgerEvent` row count stayed at **42,705**, `MagicLinkToken` no
  longer resolves (`to_regclass` returns null), `User.passwordHash` exists.

**API**
- `AuthService.login(email, password)` — Argon2id verify (`@node-rs/argon2`,
  library defaults) against `User.passwordHash`. Runs the Argon2 verify against
  a fixed dummy hash even when the user or their `passwordHash` doesn't exist,
  so a wrong-password and an unknown-email response take the same code path
  and (approximately) the same time — no timing or content signal reveals
  which case occurred. Same generic `401 invalid email or password` either way.
- `AuthService.logout(sessionId)` — deletes the `Session` row (revoke, not
  just "forget the cookie" — matters on a shared warehouse phone).
- `AuthController`: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
  (unchanged route/shape). `logout` deliberately isn't behind `JwtGuard` — it
  reads the cookie with the same `cookies.ts`/`jwt.ts` helpers `JwtGuard` uses,
  so an already-expired cookie still clears instead of 401ing.
- `JwtGuard`, `RolesGuard`, `jwt.ts`, `cookies.ts`, `current-user.ts`,
  `current-user.decorator.ts`, `roles.decorator.ts` — **zero diff**, verified
  with `git diff --stat`. Session/JWT/guard machinery is untouched.
- `main.ts` — kept the "refuse to boot without `JWT_SECRET`" check (was
  already present in the working tree pre-task); reworded its comment away
  from magic-link framing.
- `cli:seed-users` — now hashes a password (Argon2id) per seeded user, sourced
  from `SEED_*_PASSWORD` env vars, falling back to `SEED_DEFAULT_PASSWORD`,
  falling back to a documented literal dev default (`winterborn-dev`). Prints
  `email / password` for each role on every run — an operator "resets" a
  password by re-running the seeder with a new env var.
- Removed: `MagicLinkToken` model, mail transport code, `requestMagicLink`/
  `verifyMagicLink`, `MAGIC_LINK_TTL_MINUTES`/`MAIL_TRANSPORT`/
  `RESEND_API_KEY`/`MAIL_FROM` everywhere (code, `.env.example`, `render.yaml`,
  `docs/DEPLOY.md`). `seed-dev.ts`'s test-fixture `TRUNCATE` list no longer
  names the dropped table.

**Shared** (`packages/shared/src/auth.ts`): replaced
`requestMagicLinkResultSchema`/`verifyResponseSchema` with `loginInputSchema`
(`{email, password}`) and `loginResponseSchema`. `meResponseSchema`/
`currentUserSchema` unchanged.

**Frontend**
- `apps/web/app/login/page.tsx` — rewritten as an email+password form (no more
  `Suspense`/`useSearchParams`/token-from-URL branch, since there's no link to
  land on). Reuses the existing `.login-screen`/`.field`/`.error-banner`/
  `.btn-primary` classes verbatim — no new visual system introduced.
- `apps/web/lib/api.ts` — `login()`/`logout()` replace `requestMagicLink()`/
  `verifyMagicLink()`.
- `apps/web/components/Shell.tsx` — added a "Sign out" control in the app
  topbar next to the user/role text. On click: `logout()` (best-effort),
  `refresh()`, redirect to `/login`.
- `apps/web/app/globals.css` — two small additive rules (`.app-topbar-right`,
  `.app-topbar-logout`) using existing design tokens (`--text-dim`,
  `--line-strong`, `--font-mono`, `--radius-sm`); no existing rule touched.

## Tests

Replaced `apps/api/test/auth.spec.ts`. New/kept cases:
- correct credentials → session cookie set, `GET /auth/me` resolves
- wrong password rejected; **wrong password and unknown email produce byte-
  identical error messages** (asserted directly)
- a user with `passwordHash: null` cannot log in
- `RolesGuard` suite kept **unmodified** (proves guard machinery untouched)
- a dedicated test spies on `console.log/error/warn` through a successful and
  a failed login and asserts the plaintext password never appears in any
  logged output, and that the persisted `User.passwordHash` is neither null
  nor equal to the plaintext (and has the `$argon2` prefix)
- added `POST /auth/logout` coverage (cookie cleared, session then 401s)

**Result: 118/118 tests pass** (13 files), including all pre-existing suites
(requests, fulfilment, ledger, square ingest/poll, thresholds, etc. —
unaffected by this change and confirmed still green).

**Important operational note, not part of the ask but worth flagging:** this
repo's `vitest.config.ts` says outright *"Tests share one Postgres database
and truncate between runs"* — every spec's `beforeEach` calls `seedDevCatalog`,
which `TRUNCATE ... CASCADE`s the catalog/ledger/user tables on whatever
`DATABASE_URL` it's given. Nothing in the repo scopes tests to a separate
database. Running `pnpm test` against the real `.env` `DATABASE_URL` would
have destroyed the 42,705-row seeded ledger — a landmine that predates this
task. I created a separate `winterborn_test` Postgres database (same local
Postgres container), applied all 5 migrations there, and ran every test run
against `DATABASE_URL=postgresql://winterborn:winterborn@localhost:5432/winterborn_test`
instead. The real dev database was never touched by a test run. I did not
change `vitest.config.ts` or add test-DB tooling to the repo — flagging this
here since it seems worth the team deciding how to handle permanently (a
`docker-compose` test-db service, a `.env.test`, etc.) rather than me making
that call unasked.

## Verified end-to-end in a browser

Both dev servers restarted clean (API on :3001 against the real dev DB, web
on :3000). `cli:seed-users` run against the real DB — printed
`owner@example.com` / `winterborn-dev` etc. for all four roles. Drove the app
with a headless Chromium (Playwright, no project `run` skill existed for this
repo) through the real UI, not just curl:

1. `http://localhost:3000/` with no session → redirected to `/login`; login
   form renders (email + password fields, "Winterborn Restock" mark, matching
   existing dark warehouse-app styling — screenshot `01-login-page.png`).
2. Submitted wrong password → styled `.error-banner` reading
   "invalid email or password" appears in place, no navigation
   (`02-login-error.png`).
3. Submitted correct credentials (`owner@example.com` / `winterborn-dev`) →
   redirected to `/`, dashboard renders (topbar "DASHBOARD" title, "Owner /
   owner" user text, bottom nav, decision-queue/low-stock/open-requests
   panels) — `03-dashboard.png`.
4. `document.cookie` in the page confirmed **empty** for the session cookie
   (httpOnly, as intended — JS can't read it).
5. Clicked the new "SIGN OUT" button in the topbar → redirected to `/login`,
   clean form (`04-after-logout.png`).
6. Re-navigated to `/` post-logout → bounced straight back to `/login`
   (`05-still-logged-out.png`), confirming the session was actually revoked
   server-side, not just forgotten client-side.
7. `console --errors` equivalent checked: only the four expected 401s (the
   deliberate wrong-password attempt and the unauthenticated `/auth/me`
   probes) — no unexpected JS errors.

Also verified directly against the API with `curl` (cookie jar): login sets
`Set-Cookie: winterborn_session=...; HttpOnly; SameSite=Lax`; `/auth/me`
resolves with the cookie; wrong password and unknown email both 401 with
identical bodies; `/auth/logout` returns `Set-Cookie: winterborn_session=;
Expires=Thu, 01 Jan 1970...` and a subsequent `/auth/me` 401s.

Both `apps/api` (`prisma generate` + `tsc`) and `apps/web` (`next build`)
build clean.

## Deviations from the spec as written

- Used the same `POST /auth/logout` reads-cookie-directly approach rather
  than putting it behind `JwtGuard`, specifically so an already-expired
  session still clears cleanly (idempotent) instead of 401ing on the one
  request whose whole purpose is "get me out." This does not touch guard
  code, just calls the same helper functions the guard itself uses.
- Also updated `render.yaml` (removed `MAGIC_LINK_TTL_MINUTES`/
  `MAIL_TRANSPORT`/`RESEND_API_KEY`/`MAIL_FROM` from the web service's
  `envVars`) even though only `.env.example` and `docs/DEPLOY.md` were named
  explicitly — leaving it referencing a dropped env var and a code path that
  no longer exists seemed worse than the small extra edit. `render.yaml` was
  already noted in `docs/DEPLOY.md` as never having been applied to a real
  Render account, so this is a paper-only change.
- Created the `winterborn_test` database as described above — not requested,
  but the alternative was either not running the test suite at all or running
  it against the real seeded data, neither of which seemed acceptable given
  the explicit instruction to be careful with the database.

## Concerns / follow-ups worth knowing about

- The dev-default seeded password (`winterborn-dev`) is now sitting in the
  real dev database's `User.passwordHash` (as an Argon2id hash, not
  plaintext) for all four roles. Fine for local dev; re-run `cli:seed-users`
  with real `SEED_*_PASSWORD` values before any shared/staging use.
- No rate limiting or lockout, as explicitly scoped out — `POST /auth/login`
  is not throttled. Acceptable per the brief's own reasoning (four to six
  known users), just flagging that it's unthrottled by design, not by
  oversight.
- The pre-existing `SameSite=Lax` cross-domain cookie gap documented in
  `docs/DEPLOY.md` §5 (Vercel + Render being different sites) is unrelated to
  this change and was left as-is — still an open item for whoever runs
  cutover.
