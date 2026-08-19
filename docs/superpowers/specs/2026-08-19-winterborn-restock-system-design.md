# Winterborn Restock System — Design Specification

**Status:** Approved design, pre-implementation
**Date:** 2026-08-19
**Supersedes:** nothing. Derived from `Square POS Audit Final Winterborn-Document-1.pdf` (evidence) and `Winterborn-Dev-Brief-Document-2.pdf` (scope).
**Audience:** the build team. Internal. No pricing.

---

## 1. Purpose

Build a single-source-of-truth inventory and restock system for Winterborn Alpaca LLC, a seasonal retailer running 14 US Christmas-market locations.

Square POS stays the till and the permanent sales record. This system owns everything else: warehouse intake, product catalog discipline, restock requests, box-level dispatch, per-location stock derivation, write-offs, and season-close reconciliation. Sortly, the current warehouse app, is retired to read-only; its export becomes seed data.

### 1.1 Why it exists

The person who decided what stock went to which market did it from memory for a decade and has left. Nothing recorded how they decided. The audit established that the gap is structural, not procedural:

- Square has recorded **zero stock transactions**, ever, at any of the 14 locations.
- **95.2% of season revenue records no colour.** Scarves, the #1 category at $860,483 (29% of the business), sell as flat items with no variations at all, while the warehouse tracks colour on nearly every unit.
- There is **no shared identifier** between Square and the warehouse. SKU and GTIN are blank on 100% of 52,278 sold item lines and on all 74 catalog rows. Item names are the only join key.

The information a restock decision needs exists in two systems that do not connect. This system connects them and records the decisions.

### 1.2 Scale

| Metric | 2025 season (Nov 1 – Jan 1) |
| --- | --- |
| Transactions | 41,226 |
| Net sales | $2,923,110 |
| Units sold | 57,080 |
| Locations | 14 |
| Warehouse units (Sortly) | 42,428 across 564 items |
| Distinct warehouse colours | 245 |
| Refund rate | 0.24% |
| Custom-amount sales | 15 (POS discipline is excellent) |

Weekend concentration: Saturday + Sunday are 48.7% of the season. Sunday alone is 26.6%. **The week's stock position is decided by Friday.** A review-Monday / dispatch-Friday cadence fits all 14 markets and is the rhythm the tool is designed around.

Season windows differ per market (Boston opens Nov 7; most open Nov 19–23; Wrigley and Savannah trade to Dec 31; Denver and DC close Dec 24). Restock scheduling runs on **per-market calendars, not one season clock.**

---

## 2. Hard constraints from physical reality

These are not preferences. They are the client's operating environment, and a design that ignores them produces confidently wrong data.

1. **Market sites are chaotic.** Staging piles, staff grabbing stock freely, unsold items tossed in the back. **Nothing is ever scanned or counted at a market.**
2. **All discipline lives at ONE warehouse.** One packer, one door, one scan. That is the entire accuracy budget of the system.
3. **Market staff behaviour changes in exactly one way:** tapping a colour at the till. They already do this on the beanie line, so this extends an established habit rather than teaching a new one.
4. **Counts are directional, not forensic.** Mis-taps and shrinkage cause drift. Spot checks and season-close reconciliation are the correction mechanisms. Never promise unit-perfect live counts to anyone.
5. **The opening-load rule.** Everything entering a market goes through a labelled box. The opening scans *are* the opening inventory. If anything is side-loaded, counts are fiction from hour one. This is a client-behaviour rule, enforced in training and stated in writing.

---

## 3. The core principle: inventory is a derivation

Inventory is never a stored number. It is computed:

```
on_hand(variation, location) = Σ dispatched − Σ sold − Σ written_off
```

Dispatches live in our database because we create them. Sales live in Square permanently and are queryable forever via the Orders API. Therefore **any count can be recomputed from scratch at any time.** A missed webhook, a duplicate write, or a bad deploy can never cause permanent drift.

Everything in this document exists to protect that property. Build for replayability.

---

## 4. Architecture

### 4.1 Stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 15, App Router, TypeScript, installable PWA |
| Backend | NestJS 11, TypeScript |
| Database | PostgreSQL |
| ORM | Prisma |
| Queue | BullMQ on Redis |
| Validation / shared contract | Zod, in a shared workspace package |
| Auth | Magic-link email, JWT in httpOnly cookie, issued by the API |
| Email | Resend |
| Service worker | Serwist |
| Errors | Sentry (both apps) |
| Logs | pino, structured |

### 4.2 Repository layout

A single monorepo, pnpm workspaces with Turborepo.

```
winterborn/
├── apps/
│   ├── web/                  Next.js 15 PWA
│   └── api/                  NestJS 11
│       └── prisma/           schema + migrations (API-only)
├── packages/
│   ├── shared/               Zod schemas — the single definition of every domain shape
│   └── config/               eslint, tsconfig, prettier bases
├── data/                     client exports (gitignored)
├── docs/
└── turbo.json
```

**Why a monorepo despite a solo build.** The two apps share a large vocabulary: ledger events, variations, colour families, warehouse variants, box manifests, request state machines. Every one of those shapes must mean the same thing on both sides or the counts lie.

`packages/shared` holds **Zod schemas as the single definition.** NestJS validates inbound requests against them via `nestjs-zod`; Next parses API responses against them; TypeScript types are inferred from the same source on both ends. Change a schema and both apps fail to compile. That is the property worth the extra scaffolding.

**Prisma lives in `apps/api` only. The web app never touches the database.**

### 4.3 Runtime topology

The API is three processes, not one:

| Process | Responsibility |
| --- | --- |
| **Web service** | REST API for the PWA, Square webhook receiver |
| **Worker** | BullMQ consumers: inbox processing, outbound Square calls, threshold evaluation |
| **Cron** | Reconciliation poll every 20 minutes |

The webhook endpoint does exactly three things: verify the signature, insert the raw payload into `square_inbox_event`, return 200. Target under 50 ms. **Nothing else runs inline.** Processing in the request handler is how events get dropped during a market Sunday when Square fires faster than the handler completes.

The same discipline applies outbound: every Square mutation goes through a queue with exponential backoff and 429 / `retry-after` handling, so a rate limit or a transient 503 retries instead of silently losing a catalog write.

### 4.4 Hosting

| Piece | Platform | Notes |
| --- | --- | --- |
| `apps/web` | **Vercel** | Preview deploy per branch, edge CDN, PWA assets |
| `apps/api` | **Render** | Docker web service + background worker + cron job, all first-class service types. US-East. Stable public HTTPS for webhooks from day one. |
| PostgreSQL | **Neon** | Serverless, US-East. **Branching** lets us fork production data to rehearse a ledger replay or a destructive migration, then discard the branch. Point-in-time recovery included. |
| Redis | **Upstash** | BullMQ backing store, serverless |

HTTPS is mandatory (Square will not post webhooks to plain HTTP). Region is US-East for client and Square latency.

Local development: Docker Compose for Postgres and Redis only; `web` and `api` run natively. Webhook testing against a Render preview URL or a tunnel.

### 4.5 Environments

| Env | Square | Database | Purpose |
| --- | --- | --- | --- |
| local | sandbox | Docker Postgres | day-to-day |
| staging | sandbox | Neon branch | integration, dry runs |
| production | production | Neon main | pilot from Sept 18 |

Everything is built and proven against the sandbox. Moving to production is an environment-variable change, not a code change.

---

## 5. Data model

### 5.1 Locations include the warehouse

`Location` covers the 14 markets **plus a WAREHOUSE pseudo-location.**

```
Location
  id
  name
  kind                  MARKET | WAREHOUSE
  square_location_id    nullable — NULL for warehouse
  season_start          date, nullable
  season_end            date, nullable
  is_active
  timezone
```

Modelling the warehouse as a location makes intake, dispatch and season returns the same operation with different endpoints. `season_start` / `season_end` drive per-market restock scheduling.

### 5.2 Catalog structure

```
Category            8 reporting categories, aligned to the Sortly folder tree
  id, name, sortly_folder

ItemGroup           a product, e.g. "Scarf (Stripes)"
  id, category_id, name, square_item_id, brand   -- brand: OWN | FRAAS

ColourFamily        TIER 1 — what the cashier taps
  id, category_id, name, display_order

ColourVariant       TIER 2 — warehouse detail, e.g. "Wine & Smoke"
  id, colour_family_id, name, sortly_name, normalised_name
  photo_url           -- archived from Sortly; see §6.3
  family_assignment_source  LEXICAL | SYNONYM | VISUAL | MANUAL
  family_confidence   0..1, drives review ordering

SizeOption
  id, category_id, name, display_order

Variation           SELLABLE UNIT: ItemGroup × ColourFamily × Size
  id, item_group_id, colour_family_id, size_option_id
  square_variation_id, till_sku, is_sellable

WarehouseVariant    STOCK UNIT: ItemGroup × ColourVariant × Size
  id, item_group_id, colour_variant_id, size_option_id
  variation_id            -- denormalised roll-up to the sellable Variation
  warehouse_sku, unit_cost, is_sale_item
```

`WarehouseVariant.variation_id` is a denormalised roll-up, derived from `ColourVariant.colour_family_id`. It is written once at seed time and maintained on family reassignment. It exists so that a single ledger row can carry both granularities without a join at write time.

### 5.3 The SKU scheme — two levels

Document 2 specifies `CAT-GROUP-COLOR-SIZE`, giving `SCF-STR-WNE-R` as the example. But "Wine" is a *warehouse variant* while Square variations are *till families*. Those cannot share one code. **This design resolves the ambiguity with two levels:**

| Level | Format | Example | Where it lives |
| --- | --- | --- | --- |
| **Till SKU** | `CAT-GROUP-FAMILY-SIZE` | `SCF-STR-BLU-R` | written to every Square variation; the join key against Square |
| **Warehouse SKU** | `CAT-GROUP-VARIANT-SIZE` | `SCF-STR-WNE-R` | our DB only; manifests, intake, season-close |

Warehouse SKUs roll up to till SKUs through the variant → family mapping. Both levels are collision-checked across all 564 seed items. The `[Fraas]` resale line (Carmel only, ~$10k) carries a brand segment. Supplies (bags etc.) receive SKUs but are flagged `is_sale_item = false`.

### 5.4 The ledger

One append-only table.

```
LedgerEvent
  id
  type                  INTAKE | DISPATCH | SALE | WRITE_OFF | RETURN | CORRECTION
  location_id           → Location
  variation_id          → Variation           ALWAYS set (family level)
  warehouse_variant_id  → WarehouseVariant    NULL for SALE (variant unknown)
  quantity              signed integer
  occurred_at           business time
  recorded_at           system time (default now())
  source                WEBHOOK | POLL | UI | SCRIPT
  source_ref            square order+line uid, box id, intake id, …
  idempotency_key       UNIQUE
  actor_id              → User, nullable for machine sources
  transfer_id           groups the two rows of a transfer, nullable
  reason                write-off reason, nullable
  note                  nullable
```

**Nothing is ever updated or deleted.** A mistake is corrected by appending a `CORRECTION` event. `idempotency_key` is what makes replay and re-ingestion safe.

Signed quantities mean one `SUM` answers every stock question:

| Business event | Rows written |
| --- | --- |
| Warehouse intake | `+qty @ WAREHOUSE` |
| Dispatch to Denver | `−qty @ WAREHOUSE` **and** `+qty @ DENVER`, sharing `transfer_id` |
| Sale at Denver | `−qty @ DENVER` (family level, `warehouse_variant_id` NULL) |
| Write-off | `−qty @ location` |
| Season-close return | `−qty @ DENVER` **and** `+qty @ WAREHOUSE` |

### 5.5 Mixed granularity is deliberate

Sales arrive from Square at family level. Dispatch and intake are recorded at variant level. Two derivations fall out of the same table:

```sql
-- Family-level on-hand. Valid everywhere, including live markets.
SELECT variation_id, location_id, SUM(quantity) AS on_hand
FROM ledger_event
GROUP BY variation_id, location_id;

-- Variant-level on-hand. Exact at the warehouse.
-- At a market this reads "sent, not yet reconciled".
SELECT warehouse_variant_id, location_id, SUM(quantity) AS on_hand
FROM ledger_event
WHERE warehouse_variant_id IS NOT NULL
GROUP BY warehouse_variant_id, location_id;
```

This is the precision map expressed as schema rather than as a promise:

| Where | Precision |
| --- | --- |
| Intake | variant-exact |
| Warehouse stock | variant-exact |
| Manifests | variant-exact |
| Dispatch | variant-exact |
| Live market stock | **family-accurate** |
| Season-close scan-back | variant-exact |

Season-close writes `RETURN` events at variant level, and `sent − returned` recovers **variant-level sell-through per market** — the first colour-level demand data this business has ever had, and the seed for 2027 prediction work.

### 5.6 Derive live; do not materialise yet

An indexed `SUM` over one season of events (order of 150k rows) returns in single-digit milliseconds. A cached balance table is a second source of truth that can silently disagree with the ledger — precisely the failure mode this architecture exists to eliminate.

**Decision: derive live in Stage 1.** If measurement demands it in Stage 2, add a `stock_balance` rollup maintained inside the same transaction as the event insert, plus a scheduled job asserting it still equals the recompute. Do not add it speculatively.

Required indexes: `(variation_id, location_id)`, `(warehouse_variant_id, location_id) WHERE warehouse_variant_id IS NOT NULL`, `(location_id, occurred_at)`, unique on `idempotency_key`.

### 5.7 Supporting entities

```
RestockRequest        id, location_id, state, created_by, created_from, closed_at
  state: DRAFT → OPEN → PACKING → DISPATCHED → ARRIVED? → CLOSED
  created_from: THRESHOLD | REVIEW | MANUAL

RestockRequestLine    id, request_id, variation_id, warehouse_variant_id?, qty_requested

Box                   id, request_id, destination_location_id, state,
                      qr_token, packed_by, packed_at, dispatched_at, arrived_at

BoxLine               id, box_id, warehouse_variant_id, quantity   -- the manifest

Load                  id, vehicle_label, destination_location_id, created_by, dispatched_at
LoadBox               load_id, box_id, scanned_at

Threshold             variation_id, location_id, min_level, source (SEEDED|MANUAL), updated_by

Intake                id, warehouse_variant_id, quantity, unit_cost, photo_url, created_by   -- Stage 2

SquareInboxEvent      id, square_event_id UNIQUE, event_type, payload jsonb,
                      received_at, processed_at, error

SquareSyncCursor      location_id, last_polled_at, cursor

AuditLog              id, entity, entity_id, field, old_value, new_value, actor_id, at

User                  id, email, name, role (OWNER|WAREHOUSE|MARKET_MANAGER|OPERATOR), is_active
Session               id, user_id, expires_at
MagicLinkToken        token_hash, email, expires_at, consumed_at
```

`AuditLog` is not optional. Both sides can edit a restock request before packing, and every edit records who, when, and old → new.

---

## 6. The two-tier colour model

Get this right; everything depends on it.

### 6.1 The two tiers

**Tier 1 — till families.** Curated per category (Blue, Gray, Pink, Cream, Multi, …). These become the Square variations the cashier taps. Target 6–12 per category.

> **Rule for choosing a family:** any staffer must be able to pick it correctly by looking at the item in hand, mid-queue, with a line behind them.

**Tier 2 — warehouse variants.** The full detail: 245 distinct colour names in the Sortly seed ("Wine & Smoke", "French Gray", "Moss & Stone"). **Each variant maps to exactly one family.**

Manifests, intake, pick lists and season-close run at variant level. Sales run at family level.

### 6.2 Why not variant precision at the till

A picker with 28 mitten options is unusable in a queue and produces confidently-wrong data, which is worse than no data. A cashier can tell pink from gray instantly; they cannot tell "Dusty Rose" from "Rose Blush" from "Wine Pink" with a queue behind them.

**Do not attempt variant precision at the till.** Everything finer than a family is tracked for staff, not by them.

### 6.3 Deriving the family sets — measured against the real export

Verified 2026-08-19 against `data/sortly.csv`: 564 items, 42,428 units, **248 distinct `Color` values**, attributes carried as `Color` / `Style` / `Size` scattered across three attribute slots.

**Critical finding: the Sortly `Color` attribute is not always a colour.**

For Mittens and Headwear it genuinely is — `Blue`, `Brown`, `Gray`, `Purple`, `Pink w/ White`. For **Scarves, Capes and Wraps it is a design name**: `Pirate Pants (2024)`, `Mint Chocolate Chip`, `Ecuadorian Airlines (2024)`, `Shady Grove`, `On the Waterfront`, `"The Classic" v. 2`, `Creamsicle`. There is no colour token to extract, and a multi-stripe scarf does not meaningfully have "a colour" at all.

Measured lexical coverage across all 248 values:

| | |
| --- | --- |
| Contains a recognisable colour word | **208 / 248 (84%)** |
| No colour word at all | **40 / 248 (16%)** |

Unmappable share weighted by units, per category:

| Category | Units | Unmappable by text |
| --- | --- | --- |
| Footwear | 8,433 | 1.4% |
| Headwear | 2,857 | 0.2% |
| Toys | 131 | 0.0% |
| Garments | 1,480 | 8.1% |
| **Scarves** | 7,566 | **15.3%** |
| **Mittens** | 5,790 | **29.3%** |

Mittens is the least alarming of the two despite the number: it is almost entirely `Multiple` and `Traditional Pattern` (1,504 units of patterned flip mitts), which resolve to a `Multi` family the moment the lexicon knows those phrases. Scarves is the genuine problem.

**Therefore the derivation is three passes, not one:**

1. **Lexical pass.** Normalise (lowercase, strip punctuation and year suffixes, expand ampersands) and tokenise against an extended palette. The palette must go beyond base colour words to include the trade vocabulary actually present: `almond, camel, taupe, champagne, coco, sand, wheat, honey, mulberry, amethyst, ruby, eggplant, bourbon, clementine, pumpkin, sapphire, periwinkle, seafoam, oatmeal`.
2. **Synonym pass.** Map non-colour phrases to families explicitly: `Multiple`, `Multicolor`, `Traditional Pattern`, `Spotted`, `Houndstooth`, `Cool Tones`, `Warm Tones`, `Candy-Corn Stripes`, `Wild Stripes` → `Multi`; `Grayscale`, `4-Shade Browns` → `Gray` / `Brown`.
3. **Visual pass for the residual.** Roughly 40 values survive both passes — `Pirate Pants`, `Ecuadorian Airlines`, `On the Waterfront`, `Shady Grove`, `"The Classic" v. 2`, `Autumnal 3-Pane`. These are assigned by eye, not by algorithm.

**The visual pass is possible because the export carries photos.** 559 of 564 items have a `Photo1` URL. The `/admin/colours` screen therefore **renders the product photo beside each unassigned variant** — family assignment for the residual is a glance, not a research task. Confidence score per assignment, sorted worst-first, so the reviewer spends their attention where the algorithm was least sure.

Family sets are weighted by 2025 revenue so they are sized by what actually sells, not by name frequency.

Casey ratifies when available. **If she is unscheduled by Aug 21, ship the three-pass mapping and adjust later** — the mapping is one table and reassignment is cheap.

> **Time-sensitive: archive the photos now.** The URLs are `lnk.sortly.co` links tied to Joel's subscription. When Sortly is retired the links die, and with them the only visual record of 559 warehouse variants. Download all 559 into our own storage as part of the seed, before anything else about Sortly changes.

### 6.4 Vocabulary enforcement — a first-class feature

This is the mechanism that stops "blue / light blue / navy blue" drift. Treat it as core, not polish.

- **Colour is never free-typed.** Intake autocompletes over existing variants.
- Creating a new variant runs a fuzzy match using PostgreSQL `pg_trgm` trigram similarity over `normalised_name` (threshold ≈ 0.4).
- On a hit, the UI blocks with: *"3 similar exist: Navy, Night Blue, Denim — use one of these?"*
- Creating a genuinely new variant **forces family assignment before save.** There is no path to an unmapped variant.

Without this, the dataset degrades within a single season and the season-close report is worthless.

### 6.5 Explicit non-goals

- **No colour-level prediction this season.** 2025 data carries colour on 4.8% of revenue. Style-level pick-list suggestions are fine; colour prediction is a 2027 feature fed by this season's data. Do not build it or imply it.
- No variant precision at the till.

---

## 7. Square integration

**Read-mostly. The poll is the source of truth; webhooks are only the low-latency trigger.**

### 7.1 Inbound: sales

Subscribed events: `order.created`, `order.updated`, `payment.updated`.

**The webhook endpoint does three things and nothing else:**

1. Verify the `x-square-hmacsha256-signature` header — HMAC-SHA256 over `notificationUrl + rawBody`, using the webhook signature key, compared in constant time. Reject on mismatch.
2. Insert the raw payload into `square_inbox_event`, unique on Square's event ID.
3. Return `200`.

Target: under 50 ms. No parsing, no ledger writes, no Square API calls inline.

A **worker** then consumes the inbox:

- Fetches the full order via `RetrieveOrder` (webhook payloads may be partial).
- Maps each line item to a `Variation` by `square_variation_id`.
- Writes `SALE` events with `idempotency_key = sale:{order_id}:{line_item_uid}`.
- Marks `processed_at`, or records `error` and leaves the row for retry.

Unmapped `square_variation_id` values (a variation created in Square outside our catalog run) are recorded to a dead-letter list and surfaced on the operator dashboard rather than silently dropped.

Refunds and voids arrive as `order.updated` carrying returns. They write correcting `SALE` events with positive quantity and a distinct idempotency key. Refunds are 0.24% of transactions, but they must not corrupt the ledger.

### 7.2 The reconciliation poll

A Render cron job, every 20 minutes:

- For each active market location, `SearchOrders` filtered on `updated_at` since that location's cursor, paginated to exhaustion.
- A **60-minute overlap window** is re-scanned every pass so nothing is lost at a cursor boundary.
- Mapping produces **identical idempotency keys** to the webhook path, so re-ingestion is a no-op.
- The cursor advances only after a full successful pass.

This is why a week of dropped webhooks self-heals on one poll pass. **Design and test for this explicitly:** a test that disables the webhook path for a simulated week, runs one poll, and asserts the ledger is identical.

Every ledger event records `source: WEBHOOK | POLL`, so it is always answerable which path delivered a given sale.

### 7.3 Outbound: catalog only

Stage 1 writes **only** to the Catalog API:

- `BatchUpsertCatalogObjects` for items, variations and SKUs.
- Every call carries an idempotency key.
- Every call goes through the BullMQ outbound queue with exponential backoff and 429 / `retry-after` handling.

**Mandatory rule with a dedicated test: any catalog write must read-modify-write, preserving `location_overrides`.** This is the highest-consequence rule in the integration.

Verified against the live export (§8.1): **47 of 85 active rows carry a per-location price override.** The dominant pattern is a systematic Carmel premium across most of the catalog, with a separate Boston (Snowport) set and two Denver anomalies. Values range from a $2 uplift on socks to **$750 → $800 on `Cape (100% Baby Alpaca)`**. A careless upsert flattens more than half the catalog silently, across all 14 locations, and nobody would notice until a market rings up the wrong price.

Also preserve `present_at_location_ids`. Verified enablement spread across 85 active rows: 37 at all 14 locations, 9 at 12, 3 at 13, 14 at exactly one location, and **8 at zero locations** (the dead entries in §8.1).

**Preserving the override is not enough — it must be REAPPLIED to every new variation.** Proven in sandbox on both migration code paths ([decision record](../decisions/2026-08-19-flat-item-migration.md)): a read-modify-write migration keeps the override on the *legacy* row, which is relabelled `Unspecified (pre-2026)` and marked unsellable, while every **new** variation is created with `location_overrides` empty, no `present_at_location_ids`, and `present_at_all_locations: true` — flat price, everywhere. On the item-per-pattern path it is sharper still: a new pattern item has no legacy row at all, so there is nowhere for the premium to survive even inertly.

Left unhandled, that means customers at Carmel and Boston are charged the base price at the till, on the variations they actually buy, on more than half the catalog, with nothing visibly wrong until someone reconciles takings. **Every catalog migration must read each variation's existing overrides and `present_at_location_ids` before the write and reapply them to the new variations after it, and `catalog:verify` (§8.4) must re-read and assert the match or fail the run.**

### 7.4 No inventory writes in v1

**The system does NOT write inventory into Square in Stage 1.** This is a decision, not an omission. It removes double-receive risk, concurrency handling, and any interaction with price overrides at write time. Square is read-only to us apart from the catalog restructure.

*Optional Stage 2, deferred:* a feature-flagged one-way mirror pushing derived counts into Square's inventory module for owner familiarity, overwritten from our DB on every sync so Square cannot be wrong for more than a few minutes. **Build nothing for it in Stage 1.**

### 7.5 Credentials

| Env | Needs |
| --- | --- |
| Sandbox | our own developer account: application ID, sandbox access token, webhook signature key |
| Production | owner-gated. Joel must create the app in the Square Developer Console (owner-only) and issue a token with **Catalog, Inventory, Orders, Merchants** scopes, plus the production webhook signature key |

Everything runs against sandbox until the production token arrives. **Escalate if not in hand by Aug 22.**

---

## 8. Catalog restructuring and the migration protocol

This is the riskiest work in the project. Do the prototype first.

### 8.1 Current Square state — verified against the live export

Verified 2026-08-19 against `data/catalog-item-library-export.csv` (Item Library export, all locations). **These numbers supersede the audit where they differ.**

| Fact | Value |
| --- | --- |
| Total rows | 143 |
| Active rows | 85, across **46 items** |
| Archived rows | 58, across **30 items** |
| Locations | 14, confirmed by name |
| SKU populated | **0 / 143** |
| GTIN populated | **0 / 143** |
| Default Unit Cost populated | **0 / 143** |
| `Option Name` / `Option Value` used | **0 / 143** — no structured item options anywhere |
| Stock alerts configured | none |
| Reporting categories | 7 in use (Toys, Headwear, Miscellaneous, Scarves, Footwear, Mittens, Garments) + empty "Plushies" |

Structure by category, active items only:

- **Scarves — 14 flat items** (10 own-brand + 4 `[Fraas]`), every one a single `Regular` variation. Confirms the audit. This is the primary restructure target and it is one-dimensional, which makes it the cleanest.
- **Mittens** — `Mittens (Flip Mitts)`: Solid Color / Striped / Patterned. `Mittens (Full w/ Fleece Lining)`: Solid Color / Patterned. Plus 3 flat `[Fraas]` items. Style variations only.
- **Footwear** — `Socks (Dress)` S/M/L/XL, `Socks (Sport)` S/M/L/XL, `Socks (Tech)` S/M/L, `Slippers` flat. **Size variations only.**
- **Toys** — `Stuffies` L/M/S, `Knit Animals` (7 animal types), `Handmade Alpaca Yarn Toy` flat.
- **Headwear — the model to copy.** `Beanie (Single Layer Knit w/ Pom)` carries **Red / Navy / White / Gray / Black**; `Earmuffs` carries 8 colours; `Hat (Russian Style)` carries 3. This is internal proof that colour selection already works at the till.
- **Garments** — Cape, Cape (100% Baby Alpaca), Wrap all flat; `Matched Set` has 4 component variations.
- **Miscellaneous** — `Blanket` (Pink/Blue/Gray), Holiday Cards, Keychains, Dryer Balls.

**Corrections to the audit, confirmed from the export:**

1. **Per-location price overrides cover 47 of 85 active rows, not two items.** The dominant pattern is a systematic **Carmel premium** (Scarf Stripes $65→$70, Mittens Flip Mitts $40→$43, Socks Dress $28→$30, Cape $165→$177, Cape 100% Baby Alpaca $750→$800). A separate **Boston (Snowport)** set exists (Socks Tech $35→$38, Stuffies Large $70→$80, Matched Set Just Hat $50→$55), plus one Denver anomaly (Keychains $18→$28, Slippers $45→$60). **More than half the catalog carries an override.** Preservation is the single highest-consequence integration test.
2. **There are 30 archived items (58 rows), not zero.** A retired Plushies line and a silk range. Not a build problem, but the audit's "zero archived-item clutter" is incorrect.
3. **Eight dead entries, not three** — active but enabled at zero locations: Earmuffs Light Gray / Dark Gray / Black, Scarf (100% Baby Alpaca Houndstooth), Scarf (100% Baby Alpaca Plaid w/ Long Fringe), and Socks (Tech) Small / Medium / Large. Note Socks (Tech) is enabled nowhere yet still carries stock quantities at Chicago (Wrigley).
4. **Inventory is not entirely untouched.** 17 non-zero `Current Quantity` cells survive, **including negatives** (`Beanie (Traditional Multi-Color)` at −3 in Chicago Daley Plaza, a Seattle scarf at −1). Negative counts mean tracking was enabled at some point and sales decremented past zero. **This residue must be cleared before any tracking is switched on**, or it seeds the ledger with fiction.
5. **Only three tax rates exist in the entire account**: Boston (Sowa) 6.25%, Boston Sales Tax 6.25%, Philadelphia 8% — applied to 4, 20 and 21 of 85 active rows respectively. **Eleven of fourteen locations have no tax rate configured.** The client-requested "market locations + tax rates" task is therefore not setup alone; it is per-item tax application across the catalog.

**Colour drift is already present in Square.** The archived `Scarf (100% Baby Alpaca Solid w/ Long Fringe)` carries both **`Grey` and `Gray`** as separate variations, alongside Cream, Oatmeal and Black. This is live evidence for the vocabulary enforcement in §6.4, not a hypothetical.

**Item IDs are not in the export.** The `Token` column is **variation-level** (143 rows, 143 unique tokens; multi-variation items carry a distinct token per row). The migration protocol depends on preserving `item_id`, so item IDs must be fetched via `ListCatalogObjects`/`SearchCatalogObjects` with `type=ITEM`. **This puts Square API credentials on the critical path for the prototype, not merely for the production run.**

### 8.2 The trap

Converting a FLAT item to a variation-structured item is a **restructure, not an edit.** Done wrong, last season's sales history orphans and year-over-year reporting breaks — which destroys the headline value of the entire project.

### 8.3 Mandatory protocol

**This is a blocker gate. Nothing else in catalog work proceeds without sign-off.**

**Sandbox gate CLOSED 2026-08-19.** Preserve-and-relabel does not orphan sales history: `item_id` survives, the legacy variation keeps its ID, and historical order lines still resolve to a live catalog object — proven against the live sandbox, with a negative control establishing that the detector genuinely reports a deleted object as absent. Full evidence and the resulting rules: [decision record](../decisions/2026-08-19-flat-item-migration.md). **Step 5 (one live low-volume item) is still outstanding and remains a gate.**

**Amended from Document 2 on the evidence in §8.1: run TWO prototypes, not one.** The export shows two structurally different migrations, and only one of them is the flat case Document 2 anticipated.

1. **Prototype A — the flat case.** One low-volume flat item in sandbox (a Scarves-pattern item: single `Regular` variation).
   - Preferred approach: **add variations TO the existing item object, preserving `item_id`**, with the existing single price point becoming per-variation prices.
2. **Prototype B — the two-dimension case.** One item that already has size variations (`Socks (Tech)` is ideal: three sizes, currently enabled at zero locations, so it is genuinely low-risk). This prototype answers §8.6.
3. **Verify four things on each:**
   - Historical order lines still resolve to the item. — **PROVEN in sandbox.**
   - Item Sales reports still aggregate correctly. — **NOT PROVEN.** The prototypes establish the data-model linkage only; the reporting layer is Dashboard-only and could not be asserted programmatically. This is the **primary** thing to verify at step 5.
   - The new variations sell correctly on a test device. — **NOT PROVEN.** Physical-device check, outstanding.
   - **Per-location price overrides and `present_at_location_ids` survive the write.** 47 of 85 active rows carry an override; test on `Cape` (Carmel $177) and `Stuffies / Large` (two overrides: Boston $80, Carmel $75). — **PARTLY PROVEN.** The override survives on the legacy row (asserted before and after a real two-location round trip). It is **not** carried onto the new variations, which must be reapplied explicitly — see §7.3. `present_at_location_ids` survival was not asserted; assert it at step 5.
4. **Write path: Catalog API read-modify-write.** Settled by the prototype ([decision record](../decisions/2026-08-19-flat-item-migration.md)). Fetch the ITEM object with `catalog.object.get`, spread it forward, and `catalog.object.upsert` it back under the same `id` — which is what preserves `item_id` and, with it, the sales history. This is only half measured: the prototype proved that an *existing* override on the legacy variation survives a spread-forward write, and separately proved that variations built *from scratch* come out with no `location_overrides`. It did not construct a fresh object literal over an *existing* override-bearing variation and observe the override vanish — that negative control was not built. The claim that constructing an item object from scratch **drops** `location_overrides` and `present_at_location_ids` is therefore inferred from Square's documented replace-on-upsert semantics, not directly measured. Read-modify-write is mandatory regardless: the risk is asymmetric — if the inference is wrong and Square merges rather than replaces, read-modify-write is merely more cautious than required, never wrong. Recorded honestly: this was settled by proving one path, not by measuring both. **CSV round-trip import was never exercised and no claim is made about it. Do not use it.**
5. **Repeat on one live low-volume item.** Get explicit sign-off.
6. **Only then** bulk-run, in revenue order: **Scarves (29%) first**, then Mittens, Socks, Stuffies, Capes/Wraps.

### 8.4 Scripting

All catalog work runs as CLI commands in `apps/api`, driven by the parsed Sortly export:

- `catalog:parse-sortly` — parse export into staged variants, families, sizes, quantities
- `catalog:propose-families` — the §6.3 mapping proposal
- `catalog:generate-skus` — both levels, with collision checks across all 564 items
- `catalog:plan <category>` — **dry run**: print a full diff of intended Square writes, no mutations
- `catalog:apply <category>` — execute, idempotent, resumable
- `catalog:verify <category>` — re-read from Square and assert overrides, availability and SKUs survived

**Every apply is preceded by a plan whose diff has been read.** No exceptions.

### 8.5 Housekeeping folded into the same pass

Since every catalog object is being touched anyway:

- Archive the **eight** dead entries (active but enabled at zero locations, listed in §8.1). The audit said three; the export says eight.
- Delete the empty "Plushies" category; products live under Toys as "Stuffies".
- Align category names with the Sortly folder tree.
- Fix Earmuffs price-range inconsistencies across colour variations.
- Fold `[Fraas]` into the SKU scheme as a brand segment (Carmel only, ~$10k season net).
- Give Supplies (bags etc.) SKUs, flagged non-sale.
- Compile a per-market discount inventory and document the per-location price overrides (all 47, per §8.1).
- **Clear the 17 residual `Current Quantity` cells, including the negatives.** Tracking was evidently enabled at some point; that residue must not seed the ledger.
- **Configure tax rates for the 11 locations that have none**, and apply taxes consistently per item. Only three rates exist today, applied to 4, 20 and 21 of 85 rows.
- Archive the 96 zero-quantity Sortly items in the seed.

### 8.6 Two-dimension items — resolved by the Sortly structure

The catalog export raised this; the Sortly export largely answers it.

**The problem as first stated.** Square collapses `Socks (Dress/Sport/Tech)` into one item each with size variations, and `Stuffies` into three sizes. Adding colour on top would give `4 sizes × 8 families = 32` selectable entries — unusable in a queue, and a direct violation of §6.1.

**What the warehouse data actually shows.** Footwear is not organised by colour at all. Sortly splits **Sport Socks into twelve pattern groups** — Stripes, Floral, Nordic Stripe, Snowflake, Southwestern, Geometric, Star Pattern, Sweater Patterns, Cozy Alpaca, Pop Art Alpaca, Standard, Black Solid — and several of them carry **zero** colour values. Dress Socks splits into Striped / Solid / Alpaca Pattern. Colour is a minor attribute in this category; **pattern is the identity**.

**Resolution: for Footwear, the till dimension is PATTERN, not colour** — and the account already has the precedent. Scarves in Square is *already* item-per-design: `Scarf (Stripes)`, `Scarf (Plaids)`, `Scarf (Double Weaves)`, `Scarf (Single Color)` are separate items, not variations of one. Applying the same convention to Footwear gives twelve visually distinct tiles in the POS grid, each keeping the size variations it already has. `sizes × colours` never occurs. A cashier picks a sock by looking at it, then picks a size, which is exactly two unambiguous taps.

**Settled by Prototype B, 2026-08-19: item-per-pattern.** Measured against the live sandbox on a 4-pattern × 4-size fixture, with both figures read back from Square's own upsert responses rather than computed from the input:

| Approach | Measured selectable entries per item | Ceiling (≤ 16) |
| --- | --- | --- |
| **Item-per-pattern (chosen)** | **4** — one entry per size, on each of the four items | passes |
| In-place expansion | **20** — 4 original size entries + 4 patterns × 4 sizes | **breaches** |

Item-per-pattern's entry count is `sizes.length`, independent of how many patterns exist, so the real 12-pattern Footwear case still yields **4 entries per tile**. In-place expansion scales as `patterns.length × sizes.length + existing.length`, so the same real case would give **52 entries on one item** — it already breaches the ceiling on a fixture smaller than the real one and gets worse with every pattern added. (4 and 20 are measured; 4 and 52 are projected from the measured formulas, not re-run.) In-place expansion was separately confirmed *not* to orphan history — it is rejected on the till rule alone. Full evidence: [decision record](../decisions/2026-08-19-flat-item-migration.md).

**The trade-off, accepted:** new items begin with no sales history, so year-over-year fragments for Footwear. Mitigation, unchanged: retain the existing `Socks (Sport)` item as the *Standard* pattern (preserving its history and its $466k of trading record) and create new items only for the other eleven patterns. **Category-level roll-up in Square's reporting was not confirmed by the prototype** — it is Dashboard-only, and it is carried into the live low-volume item check at §8.3 step 5 alongside the Item Sales verification.

**Note for the pattern items:** each new pattern item is created from scratch and therefore carries no `location_overrides` and no `present_at_location_ids` — and unlike the flat-item path there is no legacy row to fall back on. Any per-location pricing for Footwear must be captured before the migration and written onto each new pattern item's variations explicitly. See §7.3.

**Where colour genuinely is the dimension** — Scarves, Capes, Wraps, Mittens, Headwear, Blankets — the model in §6 applies unchanged, and every one of those is one-dimensional in Square today.

**Residual two-dimension cases, and how each is handled:**

| Group | Shape in Sortly | Handling |
| --- | --- | --- |
| `Flip Mitts (Glittens)` | 28 colours × 3 styles, 4,985 units | Style stays the Square variation. Colour applies to `Solid` only; `Striped` and `Traditional Pattern` resolve to `Multi`. Expands to roughly N + 2, not 3 × N. |
| `Standard Reversible Beanies` | 21 colours × 2 styles, 1,184 units | Solid / Striped stay as variations; colour families added within Solid. |
| `Stuffies` | 29 styles, size baked into the style name (`Alpaca (Large)`, `Bear (Medium)`) | **Not a clean join.** Sortly encodes size inside the style string while Square splits Large/Medium/Small as variations. The parse must decompose these before mapping. Animal type becomes the till dimension; size stays a variation. |
| `Matched Sets` | 4 colours × 3 components | Components stay as variations, as today. |

**Binding design rule, retained:** `selectable entries per item ≤ 16`. Nothing above survived it, but the rule stays as a guard against a family set quietly growing during the Casey session.

**Fallback, now narrowed:** Prototype B passed, so the till-size reason for deferring is gone. The fallback stands only if the live-item check at §8.3 step 5 shows reporting breaks — in which case defer Footwear and Toys restructuring to Stage 2. Scarves, Mittens, Garments and Headwear still deliver colour visibility on the majority of revenue by Sept 18. **Never compromise the till to hit a date.**

### 8.7 The freeze

**Catalog freeze is Sept 12 and it is absolute.** The catalog is shared account-wide; the pilot market must open on a finished catalog, not an iterating one. No catalog change after Sept 12 without an explicit, deliberate decision.

---

## 9. Feature modules

### 9.1 NestJS module map

| Module | Owns |
| --- | --- |
| `auth` | magic link, JWT, sessions, four roles + guards |
| `catalog` | items, families, variants, sizes, variations, SKUs; the migration CLI |
| `ledger` | event append, derivations, recompute, invariants |
| `square` | API client, webhook controller, inbox, poll cron, outbound queue |
| `requests` | restock request state machine, edit logging |
| `fulfilment` | boxes, manifests, QR, labels, dispatch, load verification |
| `thresholds` | min levels, velocity seeding, auto-draft |
| `writeoffs` | Stage 2 |
| `intake` | Stage 2, with vocabulary enforcement |
| `reporting` | dashboard aggregates, season-close sell-through |

> **Hard architectural rule: no module writes to `ledger_event` directly.** Every write goes through `LedgerService`, which owns idempotency, transfer pairing, validation and recompute. That single choke point is what keeps the derivation trustworthy.

### 9.2 Roles

| Role | Sees |
| --- | --- |
| **Owner** (Joel) | everything; account-wide dashboard |
| **Warehouse** (Casey) | request queue, packing, dispatch, load, intake |
| **Market Manager** | own location: stock, sales, raise requests |
| **Operator** (us) | everything; decision queue; admin screens |

### 9.3 Restock requests

Raised three ways: auto-drafted by the threshold engine, from the Monday review, or manually.

A request is a market plus lines (family or variant level, with quantity). Both sides can edit before packing; **every edit is logged with who, when, and old → new.**

States: `DRAFT → OPEN → PACKING → DISPATCHED → (ARRIVED) → CLOSED`. `ARRIVED` is optional — it exists for in-transit visibility, nothing in the math depends on it, and nothing at the market is required to produce it.

### 9.4 Pack, label, dispatch

The packer resolves family quantities to concrete variants: *"60 gray"* becomes *"40 Charcoal + 20 Ash"*, recorded on the manifest. This is where variant precision enters the ledger.

- **One QR label per box**, printed from the tool via browser print to a Brother QL-class thermal printer (~$100, client purchasing, must be at the warehouse by **Sept 15**). CSS `@page` sized to the label stock.
- **The QR encodes the box ID only.** Contents live in the DB, so a manifest edited before dispatch never orphans its label.
- **Dispatch scan at the warehouse door** posts the manifest to the destination location's ledger as a transfer pair.
- Counts post at dispatch by default.

Scanning uses the native `BarcodeDetector` API where available, with a `@zxing/browser` fallback for iOS Safari. Multiple codes in one frame are all decoded, but **each box is confirmed deliberately** — the scan finds, the human confirms. Auto-confirming whatever the camera glimpsed is how a box still on the truck gets marked dispatched.

### 9.5 Load verification

The loader selects a vehicle and destination, then scans boxes on. **A box destined elsewhere errors immediately.**

Cheap (the scan infrastructure already exists) and high value: it catches wrong-van errors that nobody currently detects until a market opens the box.

### 9.6 Live sales sync

Per §7. Latency target: seconds via webhook, hard-guaranteed within one poll cycle. Every ingested event logs its source for debugging.

### 9.7 Threshold engine

Per `(variation, location)` minimum levels, seeded from 2025 style-level velocity (the season exports are parsed), editable by owner and operator.

On each ledger change affecting a `(variation, location)` pair: if below threshold, auto-draft a restock request line. **Deduped** — never stack drafts for the same line.

**Stage 1: thresholds exist but alerts are manual-review only.** The operator watches the dashboard daily. Stage 2 turns automated alerts on.

### 9.8 Write-off flow — Stage 2

Reasons: damage / gift / sample. Writes a ledger event (`−stock` at location or warehouse).

Replaces the current "100% Gifted/Destroyed" POS discount, used 74 times last season across 11 markets. **That discount gets retired by the owner once the flow is adopted — not by us deleting it.**

### 9.9 Dashboard

**Keep it one screen.** It serves the Monday-review / Friday-dispatch cadence the audit established.

Per market: on-hand by family (derived), sales today and this week by family, open and in-transit requests, variance log.

Account-wide: low-stock list across all markets, decision queue.

### 9.10 Warehouse intake — Stage 2

Form flow: item (search-as-you-type) → variant (controlled vocabulary, family auto-attached) → quantity → unit cost → photo from the phone camera. **Target: under 60 seconds per line.**

Every intake is a ledger event (`+warehouse stock`). **Cost capture matters** — it unlocks margin reporting later; cost is blank on 558 of 564 seed items.

> **Note on sequencing:** intake is Stage 2, but the Sept 15–17 opening load still has to be entered. For the pilot, opening stock is loaded via the dispatch/manifest flow (which exists in Stage 1) or a one-off scripted import from the Sortly parse. **Do not pull the full intake UI forward for this.**

### 9.11 Season-close reconciliation — Stage 2, designed from day one

Leftover boxes scan back at the warehouse with variant-level manifests on return. Returns are simply negative dispatches, so the Stage 1 data model already supports them.

Output: `sent − returned` = **variant-level sell-through per market.** The first colour-level demand data this business has ever had, and the seed for 2027 prediction features.

### 9.12 PWA behaviour

Installable to the home screen, phone-first. Serwist service worker.

**Offline: Stage 1 is online-required, with explicit failure states rather than silent queueing.** Warehouse connectivity is an untested assumption; if it proves unreliable, an IndexedDB queue for scan actions only is the Stage 2 remedy. Do not build it speculatively.

iOS note: web push only works after the user has added the app to the home screen, and permission must be requested from a user tap. **This must be part of the training session**, or the warehouse never receives a single notification and it surfaces during the first market weekend.

---

## 10. Non-functional requirements

### 10.1 Auth

Magic-link email, issued and verified by the API — auth belongs to the API because the API is the source of truth and the PWA is a client. JWT in an httpOnly, Secure, SameSite=Lax cookie. Token hashes stored, never raw. Single-use, short expiry. No SSO. Keep it boring.

### 10.2 Observability

- Sentry on both apps, with release tagging.
- `pino` structured logs, correlation ID per request and per queue job.
- A health endpoint reporting: last successful poll per location, inbox backlog depth, outbound queue depth, oldest unprocessed inbox row.
- **The operator is the only support desk during a $2.9M season.** Instrument accordingly.

### 10.3 Testing

| Layer | Tool | Focus |
| --- | --- | --- |
| Unit | Vitest | SKU generation, colour normalisation, threshold rules |
| Integration | Vitest + Testcontainers (real Postgres) | ledger derivations, state machines |
| API e2e | Supertest | auth, request lifecycle, webhook path |
| Contract | Zod schemas in `packages/shared` | compile-time, both ends |

**Non-negotiable tests:**

1. **Ledger property test.** Generate random sequences of dispatch / sale / write-off / return events; assert that replaying from zero always equals the incremental result. This test is what allows anyone to say the counts cannot permanently drift.
2. **Poll self-heal test.** Disable the webhook path for a simulated week; run one poll pass; assert the ledger is byte-identical to the webhook-fed equivalent.
3. **Idempotency test.** Re-deliver the same webhook payload 100 times; assert exactly one ledger event.
4. **Price-override preservation test.** Write a catalog update to an item with per-location overrides; re-read; assert overrides and `present_at_location_ids` are unchanged.
5. **Migration history test.** After converting a flat item to variations in sandbox, assert historical order lines still resolve.

### 10.4 CI/CD

GitHub Actions on every push: typecheck, lint, unit + integration tests, and a Prisma migration check (`migrate diff` against the committed schema). Vercel and Render both auto-deploy from `main`; preview deploys per branch.

### 10.5 Security and data handling

- Square webhook signature verified on **every** event, constant-time comparison.
- Client business data (`data/`) is gitignored. Exports contain full sales history.
- Secrets in platform environment variables only. Never in the repo, never in the spec.
- Least-privilege Square token: Catalog, Inventory, Orders, Merchants. Nothing touching banking, payroll or payouts.

---

## 11. Build sequence and gates

Contract accepted Aug 18. Feature-complete **Sept 11**. Pilot live **Sept 18**. Stage 2 late October.

| Window | Work |
| --- | --- |
| **Aug 19–20** | **Flat-item migration prototype — BLOCKER GATE.** Sandbox, then one live item. Nothing else in catalog proceeds without sign-off. |
| Aug 19–20 | Market locations + per-state tax rates (client-requested, 14 locations). Chase Casey. Send Joel the printer link. Escalate the API token. |
| Aug 20–21 | Monorepo scaffold, Prisma schema, CI, deploy skeleton live on Render + Vercel with a reachable webhook URL |
| Aug 21–25 | Sortly parse → colour family proposal → SKU generation (both levels) + collision checks |
| Aug 22–28 | Catalog restructure scripts, dry run, sandbox run, then production run — Scarves first |
| Aug 25 – Sep 1 | Core app: auth, roles, restock request workflow, edit logging |
| Aug 28 – Sep 3 | Square sync: webhooks, signature verify, inbox, reconciliation poll, ledger service |
| Sep 1–6 | Pack / label / dispatch + QR + load verification |
| Sep 4–8 | Threshold engine (manual-review mode) + dashboard v1 |
| **Sep 8** | **Production dry run:** real catalog, test dispatches |
| **Sep 11** | **Feature-complete. One-week buffer begins. No new features after this date, period.** |
| **Sep 12** | **Catalog freeze — absolute** |
| Sep 12–17 | Opening load packed and labelled through the system; printer live; staff trained (10 minutes: colour tap only) |
| **Sep 18** | **Pilot live at the trial market.** Operator watches daily through opening weeks. |
| Week of Sep 22 | Pilot review: till-accuracy spot checks, sync lag, count drift, decision load |
| Late Oct | Stage 2 complete; all 14 markets ready; Sortly read-only |
| Nov | Season live |
| Jan | Season-close scan-back + sell-through report |

### 11.1 Gates that stop work

| Date | Gate |
| --- | --- |
| Aug 20 | Flat-item prototype signed off, or catalog work does not start |
| Aug 21 | Casey session held, **or** proceed from the Sortly-derived family mapping |
| Aug 22 | Production API token in hand, **or escalate** |
| Aug 25 | Catalog restructure complete in sandbox before any production run |
| Sep 1 | Core app + sync working end-to-end in staging against sandbox |
| Sep 8 | Production dry run passes |
| Sep 11 | Feature freeze |
| Sep 12 | Catalog freeze |
| Sep 15 | Printer physically at the warehouse |

### 11.2 Stage split

**Stage 1 (by Sept 11):** migration prototype · catalog restructure + till family sets · SKU generation and write · core app (auth, roles, request workflow, edit logging) · pack/label/dispatch + QR + load verification · Square sync (webhooks, signature, poll, ledger) · threshold engine in manual-review mode + dashboard v1 · pilot deploy and opening-load support.

**Stage 2 (late Oct):** warehouse intake module with vocabulary enforcement, photos and costs · write-off flow · automated alerts and notifications, dashboard hardening from pilot findings · all-markets rollout, training, Sortly retirement, docs · season-close reconciliation design realised.

---

## 12. Risks and standing decisions

| Risk / decision | Position |
| --- | --- |
| **Flat-item migration orphaning sales history** | **De-risked at the data-model layer, 2026-08-19.** The sandbox prototype proves preserve-and-relabel keeps `item_id`, keeps the legacy variation and its ID, and keeps historical order lines resolving to a live catalog object — with a negative control proving the detector genuinely reports a deleted object as absent. [Decision record](../decisions/2026-08-19-flat-item-migration.md). **Residual risk, still open:** whether Square's *Item Sales* report still aggregates those lines under the item once the legacy variation is unsellable. That reporting layer is where the year-over-year figure is actually read from and it is Dashboard-only, so it is unproven. Confirm on one live low-volume item (`Socks (Tech)`) per §8.3 step 5 **before** any bulk run. |
| **Per-location overrides lost on new variations** | **Confirmed in sandbox on both migration paths, and it is the most dangerous production finding in the prototype work.** A migration preserves the override on the legacy row — which is unsellable — and creates every **new** variation with none, present at all locations, flat price. 47 of 85 active rows carry an override (§8.1). Unhandled, Carmel and Boston ring up the base price on the variations customers actually buy, silently, until takings are reconciled. Mitigation is mandatory and specified in §7.3: capture overrides and `present_at_location_ids` before the write, reapply after, and fail the run in `catalog:verify` if they do not match. |
| **Sept 12 catalog freeze** | Absolute. Shared catalog means changes hit all 14 locations; the pilot must open on a frozen catalog. |
| **Opening-load rule** | Everything entering the pilot market goes through a labelled box. If anything is side-loaded, counts are fiction from hour one. Client-behaviour rule: enforce in training, state in writing. |
| **Casey as a dependency** | Needed for family sets and intake design. If unscheduled by Aug 21, design from the Sortly export and validate later. Do not let her calendar eat the buffer. |
| **Owner-gated API token** | Square Developer Console is owner-only. Until received, everything runs against our sandbox. Escalate if not in hand by Aug 22. |
| **Counts are directional, not forensic** | By design. Mis-taps and shrinkage cause drift; spot checks and season-close reconciliation are the correction mechanisms. **Never promise unit-perfect live counts to anyone.** |
| **No colour-level prediction this season** | 2025 data carries colour on 4.8% of revenue. Style-level suggestions are fine. Do not build or imply colour prediction now. |
| **Warehouse connectivity** | Untested assumption that online-only scanning is viable. Verify before Sept 15; offline scan queueing is the Stage 2 remedy if not. |
| **Sole support during peak season** | Sortly had a help desk; after cutover we are it. Observability and the health endpoint are load-bearing, not nice-to-have. |
| **Two-dimension items (§8.6)** | **RESOLVED 2026-08-19 — item-per-pattern.** Measured in sandbox: 4 selectable entries per item, against 20 for in-place expansion on the same fixture and a binding ceiling of 16. See the [decision record](../decisions/2026-08-19-flat-item-migration.md). The Stage 2 deferral fallback is no longer needed for the till-size reason; it stands only if the live-item reporting check at §8.3 step 5 fails. **Never compromise the till to hit a date.** |
| **Tax configuration** | 11 of 14 locations have no tax rate. The pilot market must have correct tax before its first sale, or the takings are wrong from hour one. |
| **Residual inventory counts** | 17 non-zero cells including negatives survive from an earlier tracking attempt. Clear them before enabling anything. |
| **Sortly photo links expire** | 559 product photos exist only as `lnk.sortly.co` URLs tied to Joel's subscription. They are the only visual record of the warehouse variants and the input to visual family assignment. Archive them before Sortly is touched. |
| **Season-close returns are assumed, not verified** | §9.11 depends on leftover boxes coming back to the warehouse. Document 2 §5.9 states this as the design and it is therefore settled scope, but nobody has confirmed it operationally. If leftovers do not return, variant-level sell-through does not exist and the 2027 prediction case goes with it. Confirm during the Sept 18 pilot at the latest. |
| **Scope guard** | Anything not in this document is an add-on conversation, not a quiet extension. |

---

## 13. Open items and external dependencies

Anything decided in Document 2 or the client chat is settled scope and is not listed here. This table carries only what is genuinely unresolved.

**Closed by data analysis, 2026-08-19:** Sortly export (§6.3, §8.6) · Square catalog export (§8.1) · 2025 season exports (`data/square-2025/`, 41,226 tx verified) · product photos (559 URLs found in the Sortly export) · location names (all 14 confirmed from transaction data).

**Closed by prototype, 2026-08-19:** Square sandbox credentials (delivered and in use) · the flat-item migration approach and the two-dimension restructure (§8.3, §8.6, §12) — see the [decision record](../decisions/2026-08-19-flat-item-migration.md). **Still open from that work and carried into the catalog scripts:** Item Sales report aggregation after migration, and till-device selling, both to be confirmed on one live low-volume item (`Socks (Tech)`) before any bulk run.

| # | Item | Owner | Blocks | By |
| --- | --- | --- | --- | --- |
| 1 | **Archive the 559 Sortly photos** to our own storage | Osama | visual family assignment (§6.3); links die with the subscription | before Sortly changes |
| 2 | **Sending domain for magic-link email** (Resend verified sender) | Osama / Joel DNS | login works at all | before core app, ~Aug 25 |
| 3 | **Production access token + webhook signature key** (Catalog, Inventory, Orders, Merchants) | Joel, owner-only | production catalog run and live sync | Aug 22, escalate |
| 4 | **Pilot market identity** — which market, and does it exist in Square? | Joel | tax config, threshold seeding, location creation | Aug 21 |
| 5 | **2026 buy** — placed? landing when? | Joel | new variants have no family, SKU or catalog entry, and the freeze is Sept 12 | Aug 21 |
| 6 | Casey session: family sets + intake design | Joel to broker | ratifies §6.3. Per Document 2, if unscheduled by Aug 21 proceed from the export | Aug 21 |
| 7 | Thermal label printer at the warehouse (Brother QL-class) | Joel purchases | dispatch labelling | Sep 15 |
| 8 | Warehouse connectivity check at the packing/scan spot | Joel or Casey | online-only vs offline queue (§9.12) | Sep 15 |
| 9 | Names and emails for user seeding | Joel | login seeding; five-minute task | Sep 8 |
| 10 | Branding: logo and colours for the PWA icon | Joel | home-screen install | Sep 8 |
| 11 | Process-mapping session (Phase 1 leftover) | Joel | validates request workflow states; not blocking | when available |

**Work items owned by us, tracked in §8.5 rather than here:** clearing the 17 residual inventory cells including negatives · tax rates for the 11 unconfigured locations · the eight dead catalog entries.

---

## 14. Glossary

| Term | Meaning |
| --- | --- |
| **Till family** | Tier 1 colour. What the cashier taps. A Square variation. |
| **Warehouse variant** | Tier 2 colour. Full detail, e.g. "Wine & Smoke". Our DB only. |
| **Variation** | Sellable unit: ItemGroup × ColourFamily × Size. Has a Square ID and a till SKU. |
| **WarehouseVariant** | Stock unit: ItemGroup × ColourVariant × Size. Has a warehouse SKU. |
| **Ledger event** | An append-only row. The only way stock changes. |
| **Transfer** | Two ledger rows sharing a `transfer_id`: negative at source, positive at destination. |
| **Derivation** | `SUM(quantity)` over the ledger. Never a stored number. |
| **Replay** | Recomputing all counts from the ledger from zero. Must always equal the incremental result. |
| **Manifest** | The variant-level contents of one box (`BoxLine` rows). |
| **Family-accurate** | Precision available at a live market: correct at family level, not at variant level. |
| **Sell-through** | `sent − returned`, computed at season close, per variant, per market. |

---

## 15. What this system deliberately does not do

Stated so nobody quietly builds them:

- It does not organise the market tent. Nothing is scanned or counted at a market, ever.
- It does not make counts forensic. They are directional, with a self-correcting season-end checkpoint.
- It does not predict colours this season. It measures, so that next season can predict.
- It does not write inventory into Square in v1.
- It does not replace the restock *decision*. It records it, surfaces the data behind it, and makes whoever holds the seat effective from data rather than memory.
