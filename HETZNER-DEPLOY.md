# Winterborn — Production Deployment Guide (Hetzner)

Complete guide to deploying the whole system — frontend, backend,
database, HTTPS — onto the project's Hetzner server and running it
live. Written so it can be followed top-to-bottom by whoever performs
the deploy, with every command given exactly as it should be typed.

**Deploy target** (verified in the Hetzner console on 2026-09-01):

| | |
|---|---|
| Server | `ubuntu-2gb-hil-1` — Hetzner CPX11 (2 vCPU, 2 GB RAM, 40 GB disk) |
| Public IP | `5.78.224.178` (IPv4, assigned and confirmed) |
| Location | Hillsboro, OR (us-west) |
| OS | Ubuntu |
| Hetzner firewall | none exists / none attached — nothing blocks traffic ✅ |
| SSH | password auth is **enabled** (verified); the "OBS" SSH key in the console was added *after* server creation so it is **not** installed on the server |
| Hetzner backups | currently **disabled** (optional; see [Later](#later--not-required-for-go-live)) |

---

## 1. Architecture — what runs where

Everything runs on the one server, as four Docker containers managed by
a single compose file (`docker-compose.prod.yml`):

```
                         the internet
                              │
                     https (ports 80/443)
                              │
                    ┌─────────▼─────────┐
                    │       caddy       │  reverse proxy + automatic HTTPS
                    └─────┬───────┬─────┘
     app.5-78-224-178     │       │      api.5-78-224-178
        .sslip.io         │       │         .sslip.io
                    ┌─────▼───┐ ┌─▼───────┐
                    │   web   │ │   api   │
                    │ Next.js │ │ NestJS  │
                    │  :3000  │ │  :3001  │
                    └─────────┘ └────┬────┘
                                     │ internal Docker network only
                                ┌────▼─────┐
                                │ postgres │  data in a Docker volume
                                │   :5432  │  (never exposed publicly)
                                └──────────┘
```

| Container | What it is | Reachable at |
|---|---|---|
| `web` | Frontend — Next.js 15 (`apps/web`), built via `apps/web/Dockerfile` into a standalone server | https://app.5-78-224-178.sslip.io |
| `api` | Backend — NestJS + Prisma (`apps/api`), built via `apps/api/Dockerfile`. Note: the app in the browser does **not** call this domain — it calls `/backend/*` on the web origin, and the Next server forwards those to the api container internally (same-origin proxy; keeps the login cookie working on iOS Safari). The api domain exists for health checks and, later, Square webhooks | https://api.5-78-224-178.sslip.io |
| `postgres` | Database — Postgres 16. Data persists in the `pgdata` Docker volume; survives restarts and redeploys. No public port — only the api container can reach it | internal only |
| `caddy` | Reverse proxy. Terminates HTTPS (obtains + renews Let's Encrypt certificates automatically), routes by hostname to web/api | ports 80/443 |

**Why the `sslip.io` domains?** Free wildcard DNS: any hostname ending
in `5-78-224-178.sslip.io` resolves to 5.78.224.178 automatically —
nothing to register or configure, and it lets Caddy issue real HTTPS
certificates. HTTPS is required (not optional) because the frontend's
barcode scanner needs a secure context to access the camera. Swapping
in a real domain later is a 4-line `.env` change
([see Later](#later--not-required-for-go-live)).

**Redis: intentionally absent.** Local dev's `docker-compose.yml`
provisions Redis and `.env.example` has a `REDIS_URL`, because the
original spec described a BullMQ job queue. The code was written
differently: the background worker is a plain database-polling loop, no
Redis client library is installed in any package, and the only mention
of Redis in the source is a comment in
`apps/api/src/cli/drain-inbox.ts` warning not to assume it's
load-bearing. Production runs no Redis and misses nothing.

**Deploy-related files in this repo — what each one does:**

| File | Role |
|---|---|
| `HETZNER-DEPLOY.md` | This guide — the step-by-step runbook the deploy follows |
| `docker-compose.prod.yml` | The heart of the deploy: defines the four containers above (web, api, postgres, caddy), their internal network, the database volume, and restart behavior. The deploy command in §7 runs this file. Also contains the commented-out Square `worker`/`poller` services for later |
| `apps/api/Dockerfile` | Recipe for building the **backend** image: installs pnpm workspace deps, compiles `packages/shared` then the NestJS app, generates the Prisma client, produces the runtime image. Must be built with the monorepo root as context (the compose file does this correctly) |
| `apps/web/Dockerfile` | Recipe for building the **frontend** image: compiles the Next.js app into a self-contained standalone server. No API URL is baked in — the browser calls the same-origin `/backend` proxy, which the Next server forwards to the API container at runtime (`BACKEND_INTERNAL_URL`, set in the compose file). One origin keeps the login session cookie working everywhere, including iOS Safari |
| `apps/web/next.config.mjs` | Next.js config; the `output: 'standalone'` line is what makes the web Dockerfile possible (emits a self-contained server instead of requiring the full `node_modules`). No effect on local dev |
| `deploy/Caddyfile` | Caddy's routing rules: which hostname goes to which container (`WEB_DOMAIN` → web:3000, `API_DOMAIN` → api:3001). HTTPS certificates are handled automatically by Caddy itself |
| `deploy/production.env.example` | Template for the server's `.env` (§6). Pre-filled with every known value; only 3 secrets need filling in. Named `production.env.example` (not `.env.production…`) so the repo's `.env.*` gitignore rule doesn't swallow it |
| `docker-compose.yml` | **Local dev only** (Postgres+Redis on localhost for `pnpm dev`) — not used in production |
| `render.yaml`, `apps/web/vercel.json` | Historical (a Render/Vercel plan that was never deployed) — ignored by this guide |

---

## 2. Prerequisites — have these before starting

- [ ] **Root access to the server.** Password SSH login is enabled
      (verified). Get the root password one of two ways:
      - Ask the client who created the server — Hetzner emailed it to
        them at creation, and the console activity log suggests they've
        been using it; **or**
      - Reset it yourself: Hetzner console → Servers →
        `ubuntu-2gb-hil-1` → **Rescue** tab → **Reset root password**.
        The new password is shown **once** — copy it immediately. Warn
        the client first, since this invalidates the password they have.

      (Optionally add your own SSH key to the server after first login
      for convenience — not required by anything in this guide.)

- [ ] **The deploy files are pushed to GitHub.** They were created on
      branch `feat/hetzner-deploy`. If deploying from a
      different machine than where they were authored, confirm
      `docker-compose.prod.yml` exists on the branch you're about to
      deploy (`git log --oneline -- docker-compose.prod.yml`). Merge
      the branch first if the deploy should run from `master`.

- [ ] **Access to the GitHub repo**
      (`https://github.com/shiraz1496/Winterborn`). If it's private,
      have a GitHub Personal Access Token ready (GitHub → Settings →
      Developer settings → Personal access tokens → Tokens (classic) →
      Generate, with the `repo` scope). Git asks for it in place of a
      password when cloning on the server.

Everything else (domains, certificates, database) is created during the
deploy itself. Square credentials are explicitly **not** needed for
go-live — see [Later](#later--not-required-for-go-live).

---

## 3. Connect to the server

- [ ] From any terminal:

      ssh root@5.78.224.178

  Type the root password when asked (nothing appears while typing —
  normal). On the very first connection, answer `yes` to the
  `continue connecting?` prompt.

  The prompt changes to `root@ubuntu-2gb-hil-1:~#` — you are now on the
  server. **Every command from here on runs on the server** unless
  marked otherwise.

---

## 4. Prepare the server (one-time)

- [ ] Update the operating system (a few minutes; if a pink/purple
      screen asks about restarting services, press Enter to accept the
      defaults):

      apt update && apt upgrade -y

- [ ] Install Docker via the official convenience script (installs the
      engine and the `docker compose` plugin):

      curl -fsSL https://get.docker.com | sh

- [ ] Add swap space. **Do not skip.** The server has 2 GB RAM; the
      Next.js build needs more and will be killed mid-build without
      swap:

      fallocate -l 4G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab

- [ ] Enable the firewall, allowing only SSH and web traffic
      (everything else inbound is blocked; the database has no public
      port to begin with):

      ufw allow OpenSSH
      ufw allow 80/tcp
      ufw allow 443/tcp
      ufw --force enable

---

## 5. Get the code onto the server

- [ ] Clone and switch to the branch being deployed:

      git clone https://github.com/shiraz1496/Winterborn.git
      cd Winterborn
      git checkout feat/hetzner-deploy

  If the repo is private, git prompts for username + password — paste
  the Personal Access Token as the password (see Prerequisites).

- [ ] Create the photos directory. `data/` is gitignored (it holds
      client business data), but the API image build expects the folder
      to exist:

      mkdir -p data/photos

  (If the real product photos are available, copy them into
  `data/photos/` — the API serves archived colour-variant photos from
  there. An empty folder is fine to go live; photos can be added later
  with a rebuild.)

---

## 6. Configure `.env` — every setting explained

`.env` is one plain-text file at the repo root **on the server**; it is
gitignored and is the single source of configuration for all
containers. Docker Compose reads it automatically because it sits next
to `docker-compose.prod.yml`.

- [ ] Copy the prepared template:

      cp deploy/production.env.example .env

- [ ] Generate the auth secret and copy the output:

      openssl rand -hex 32

- [ ] Edit the file:

      nano .env

  **Change exactly four values** (save with `Ctrl+O`, `Enter`, exit
  with `Ctrl+X`):

  1. `POSTGRES_PASSWORD=CHANGE_ME` → a strong password of **letters and
     numbers only** (symbols break the connection string) — generate one
     with `openssl rand -hex 24`
  2. `DATABASE_URL=postgresql://winterborn:CHANGE_ME@postgres:5432/winterborn`
     → replace `CHANGE_ME` with the **same** password
  3. `JWT_SECRET=CHANGE_ME` → paste the `openssl rand -hex 32` output
  4. `SEED_DEFAULT_PASSWORD=CHANGE_ME` → the password the app's login
     accounts will get in §8. If left as-is or blank, accounts are
     created with the publicly known dev default `winterborn-dev` —
     never acceptable on a live server

Full reference — what every variable does and who consumes it:

| Variable | Consumed by | Meaning / where the value comes from |
|---|---|---|
| `NODE_ENV` | api, web | `production`. Leave as-is |
| `API_PORT` | api | Port the NestJS app listens on inside its container (`3001`). Leave as-is |
| `WEB_DOMAIN` | caddy | Hostname Caddy serves the frontend on. Pre-set to `app.5-78-224-178.sslip.io` |
| `API_DOMAIN` | caddy | Hostname Caddy serves the API on. Pre-set to `api.5-78-224-178.sslip.io` |
| `POSTGRES_PASSWORD` | postgres | Password the database container is created with. **You set this** |
| `DATABASE_URL` | api (Prisma) | Connection string the API uses. Hostname is `postgres` — the database container's name on Docker's internal network; do not change it to an IP. **Password must match the line above** |
| `JWT_SECRET` | api | Signs login tokens. The API refuses to boot without it. **You set this** (random 64-hex-char string) |
| `WEB_ORIGIN` | api | The frontend's full URL, used for the API's CORS allow-list. Pre-set; must always be `https://` + `WEB_DOMAIN` |
| `NEXT_PUBLIC_API_URL` | — | **Must stay unset** (the template only carries a comment saying so). Unset, the browser uses the same-origin `/backend` proxy, which is what keeps logins working on iOS Safari. Setting it would silently break iPhone logins |
| `BACKEND_INTERNAL_URL` | web | Where the Next server forwards `/backend/*` calls. Set directly in `docker-compose.prod.yml` to `http://api:3001` (the API container on the internal network) — not in `.env`, nothing to change |
| `SQUARE_*` | api | Square POS integration credentials. **Leave exactly as pre-filled for go-live** — the template ships safe placeholder values (`SQUARE_ENV=sandbox`, a `sandbox-…` application id) because the API's Square module refuses to boot with anything else until real credentials exist. Only the Square-facing features error if used; everything else runs normally. See [Later](#later--not-required-for-go-live) and `docs/DEPLOY.md` |
| `INBOX_DRAIN_INTERVAL_MS` | worker (when enabled) | Milliseconds between backlog sweeps; default `10000` |
| `SEED_DEFAULT_PASSWORD` | seed command (§8) | Password every seeded login account receives. **You set this** — blank means the publicly known dev default. Re-run the seed command with a new value to reset passwords |

---

## 7. Build and start everything

- [ ] The main deploy command — builds both app images and starts all
      four containers. **First run takes 10–20 minutes** (later
      deploys are much faster thanks to Docker layer caching). Lots of
      output scrolls by; that's normal:

      docker compose -f docker-compose.prod.yml up -d --build

- [ ] Confirm all four are up:

      docker compose -f docker-compose.prod.yml ps

  Expected: `postgres` → `Up (healthy)`; `api`, `web`, `caddy` → `Up`.
  If anything shows `Restarting`, read its logs:

      docker compose -f docker-compose.prod.yml logs api
      docker compose -f docker-compose.prod.yml logs web
      docker compose -f docker-compose.prod.yml logs caddy

Startup order is handled automatically: the api container waits for
postgres to pass its healthcheck before starting.

---

## 8. Initialize the database

The Postgres container starts empty. Two commands, run once:

- [ ] Create the schema — applies the committed Prisma migrations from
      `apps/api/prisma/migrations`:

      docker compose -f docker-compose.prod.yml exec api sh -c "cd apps/api && ./node_modules/.bin/prisma migrate deploy"

  Success = a list of applied migration names, no red errors.

- [ ] Create the login accounts. **The output prints an email +
      password for each role (owner, warehouse, market manager,
      operator) — save them somewhere safe**; they are the only way to
      log in, and there is no self-service password reset (by design —
      small seasonal team). To reset a password later, re-run this same
      command with `SEED_*_PASSWORD` variables set in `.env`:

      docker compose -f docker-compose.prod.yml exec api node apps/api/dist/cli/seed-users.js

---

## 9. Verify it's live

- [ ] API health check (from the server or any machine):

      curl https://api.5-78-224-178.sslip.io/health

  Expected: a small JSON success response over HTTPS.

- [ ] Open **https://app.5-78-224-178.sslip.io** in a browser (works
      on phones too). Log in with an account from step 8. Confirm a
      page that talks to the API (e.g. the requests list) loads data.

  🎉 That's the whole system live: frontend, backend, database, HTTPS.

**If something's off**, the usual suspects:

| Symptom | Cause / fix |
|---|---|
| Browser certificate warning in the first ~2 minutes | Caddy is still obtaining certificates on first contact — wait a moment, refresh. Persisting longer: `logs caddy` |
| Build dies with `Killed` / exit code 137 | Out of memory — the swap step (§4) was skipped. Add swap, rerun the deploy command |
| `api` restarting with a JWT error | `JWT_SECRET` still blank/`CHANGE_ME` in `.env` — fix, then `docker compose -f docker-compose.prod.yml up -d` |
| `api` can't reach the database | Passwords in `POSTGRES_PASSWORD` and `DATABASE_URL` don't match, or `DATABASE_URL` host isn't `postgres` |
| Frontend loads but every action fails (network errors on `/backend/...`) | The web container can't reach the api container — check `docker compose ... ps` shows api `Up`, and `logs web` / `logs api` for details |
| Login succeeds but you're immediately logged out / cookie errors | Someone set `NEXT_PUBLIC_API_URL` in `.env` — it must stay unset (see §6 table); remove it and `up -d --build web` |
| Site unreachable entirely | `ufw status` should show 80/443 allowed; `docker compose ... ps` should show caddy `Up` |

---

## 10. Day-2 operations

**Deploy a code update** — SSH in, then:

    cd Winterborn
    git pull
    docker compose -f docker-compose.prod.yml up -d --build

Only changed containers rebuild/restart; the database and its data are
untouched. If the update includes new migration files, run the
`migrate deploy` command from §8 again afterwards (safe to run any
time — it only applies what's new).

**Watch live logs:**

    docker compose -f docker-compose.prod.yml logs -f api
    docker compose -f docker-compose.prod.yml logs -f web

**Restart everything** (e.g. after editing a non-build `.env` value):

    docker compose -f docker-compose.prod.yml up -d

**Back up the database** (writes a dated `.sql` file to the current
directory; do this before anything risky):

    docker compose -f docker-compose.prod.yml exec postgres pg_dump -U winterborn winterborn > backup-$(date +%F).sql

**Restore a backup** (into an empty/replaceable database — this
overwrites current data):

    cat backup-YYYY-MM-DD.sql | docker compose -f docker-compose.prod.yml exec -T postgres psql -U winterborn winterborn

---

## Later — not required for go-live

**Square POS integration.** The Square credentials in `.env` are blank
and two background processes are commented out in
`docker-compose.prod.yml`:

- `worker` — drains the Square webhook inbox continuously
- `poller` — reconciliation poll every 20 minutes (self-heal for
  dropped webhooks)

When the Square side is ready, follow `docs/DEPLOY.md` §3–§5 for the
credentials (some are owner-gated) and the cutover order — in
particular `SQUARE_WEBHOOK_NOTIFICATION_URL` must byte-for-byte match
the URL registered with Square
(`https://api.5-78-224-178.sslip.io/square/webhook`). Then uncomment
both blocks in `docker-compose.prod.yml` and run the deploy command
again.

**A real domain.** Buy one, create two DNS `A` records — `app` and
`api` — both pointing to `5.78.224.178`, wait for DNS to propagate,
then update three lines in `.env` (`WEB_DOMAIN`, `API_DOMAIN`,
`WEB_ORIGIN`) and apply:

    docker compose -f docker-compose.prod.yml up -d --build

Caddy fetches certificates for the new names automatically.

**Hetzner server backups** (currently disabled). Hetzner console →
server → Overview → OPTIONS box → **Enable** under BACKUPS. Daily
whole-server snapshots for +20% of the server price. Recommended once
the system holds real data — complements (doesn't replace) the
`pg_dump` backups above.

**More RAM.** If builds feel slow or the server swaps heavily under
real usage, the console's **Rescale** tab upgrades to a CPX21
(4 GB RAM) in ~a minute of downtime. Choose the "CPU/RAM only" rescale
to keep the option of scaling back down.
