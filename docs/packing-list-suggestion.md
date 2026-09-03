# Packing List Suggestion — How It Works

Comprehensive reference for the `/requests/suggest` engine that generates a full draft packing list per market, given a target mode.

- **Entry point:** `POST /requests/generate-suggestion` (Owner only)
- **Service:** `apps/api/src/requests/packing-list-suggestion.service.ts`
- **UI:** `apps/web/app/requests/suggest/page.tsx`
- **Shared schema:** `packages/shared/src/requests.ts` (search for `generateSuggestion*`)

The engine is deterministic and rule-based. No ML, no LLM. Every recommendation traces to specific data and a specific formula.

---

## 1. Inputs

| Input | Required | Purpose |
|-------|----------|---------|
| `locationId` | yes | Which market the packing list is for |
| `targetMode` | yes | One of `MATCH_LAST_YEAR`, `GROW_PCT`, `CUSTOM_UNITS`, `CUSTOM_REVENUE`, `INITIAL_SHIPMENT` |
| `growthPct` | when `GROW_PCT` | Integer, `-100` to `+500` |
| `targetUnits` | when `CUSTOM_UNITS` | Positive integer total unit budget |
| `targetRevenueDollars` | when `CUSTOM_REVENUE` | Positive integer dollar budget |
| `initialShipmentPct` | when `INITIAL_SHIPMENT` | Integer `1..100`, default `85` |
| `categoryIds` | optional | Restrict to variations under these top-level categories (tree walked down) |
| `lastYearStart`, `lastYearEnd` | optional | Override the "last season" window |

## 2. Overall algorithm

```
1. Validate market and warehouse exist
2. Resolve sales window (see section 3)
3. Apply category filter (see section 4)
4. Build demand signal from three tiers (see section 5)
5. Compute price map (only for CUSTOM_REVENUE — see section 6)
6. Compute per-variation target quantity (see section 7)
7. Cap by warehouse on-hand (see section 8)
8. Discount by cross-market competing demand (see section 9)
9. Split each variation across colours (see section 10)
10. Round, filter zero-quantity lines
11. Attach confidence + rationale to each line (see sections 11–12)
12. Sort by real market demand (see section 13)
```

---

## 3. Sales window resolution

Priority chain in `resolveLastYearWindow(input, seasonStart, seasonEnd)`:

1. **Explicit override:** if the operator passed both `lastYearStart` and `lastYearEnd`, use them.
2. **Season-based:** if `Location.seasonStart` and `Location.seasonEnd` are set, take those two dates and shift back one year:
   ```
   start = seasonStart - 1 year
   end   = seasonEnd - 1 year
   ```
3. **Trailing 12 months, one year ago (fallback):**
   ```
   end   = today - 1 year
   start = end - 1 year
   ```
   So the default is a 12-month window that ended exactly one year before today.

The seed CLI writes events into this default window so the operator can leave the picker blank and still see data.

---

## 4. Category filter (`resolveCategoryFilter`)

If the operator picks category IDs, the engine walks the category tree top-down from each picked ID and collects every descendant.

**Algorithm:**
```
expanded = new Set()
queue = [...pickedCategoryIds]
while queue not empty:
  id = queue.dequeue()
  if id in expanded: continue
  expanded.add(id)
  queue.push(...children_of(id))

allowedVariationIds = all variations whose itemGroup.categoryId ∈ expanded
```

Anything not in `allowedVariationIds` is filtered out before the target math runs.

**Empty categoryIds → no filter (all variations considered).**

---

## 5. Demand signal — sales only

The "demand" here means "units sold at this market" — the ground truth the engine tries to match, grow, or scale. **Only SALE events count.** Dispatches are shipping activity, not demand, and were removed as a fallback (2026-09-03) after an operator review — mixing the two masked whether a number came from real customer purchases.

### Tier A — Local sales

Aggregates `LedgerEvent` rows at this market where `type = 'SALE'`, within the window.

```
demand[variationId] = max(0, -Σ(SALE.quantity))
                       for locationId = market
                       AND occurredAt ∈ window
                       AND variationId ∈ allowedVariationIds
```

Sales are stored with **negative** quantity (a sale removes stock). The negation flips them to positive units-sold.

**Confidence:** HIGH for lines that use this tier (subject to sparse-observation and growth-extrapolation downgrades — see §11).

### Tier B — Cross-market inference (only for empty markets)

If Tier A is empty for this market (a new market, or one that opened after our data starts), the engine looks at *sales* at other markets:

```
crossDemand[variationId] = max(0, -Σ(SALE.quantity))
                             for locationId ≠ this market
                             AND location.kind = 'MARKET'
                             AND window / category filters

perMarketEstimate[v] = max(1, round(crossDemand[v] / count_other_markets))

demand[v] = perMarketEstimate[v]
```

Deliberately **undershoots** by dividing by market count — better to under-ship a new market than over-commit. No dispatch fallback: if no other market has sold the item either, it's excluded.

**Confidence:** LOW for every line. A prominent note at the top of the result explains what happened.

### Tier C — Nothing anywhere

If Tier A and Tier B are both empty in the window:
- Returns empty `lines: []`
- Note: `"No sales data anywhere in the window ..."`

Empty is honest. The engine never invents numbers.

---

## 6. Price map (CUSTOM_REVENUE only)

Uses `WarehouseVariant.unitCostCents` from the local catalog. Family-level price = average across the family's warehouse variants that have a price set.

```
for each variation v:
  prices = [wv.unitCostCents for wv in v.warehouseVariants if wv.unitCostCents ≠ null]
  if prices is nonempty:
    priceCents[v] = round(sum(prices) / count(prices))
```

Variations with no unit cost data on any WV are excluded from the revenue calculation, with a note explaining why.

**No Square API dependency.** Everything reads from local Prisma tables.

---

## 7. Target math per mode

Let:
- `demand[v]` = tier-resolved units sold for variation `v`
- `totalDemand = Σ demand[v]` across all candidate variations
- `SANITY_MULTIPLIER = 3` (protects growth modes from runaway numbers)

### MATCH_LAST_YEAR

```
target[v] = demand[v]
```

If a variation sold 40, target is 40. That's it.

### GROW_PCT

```
raw = round(demand[v] × (1 + growthPct / 100))
target[v] = min(raw, round(demand[v] × SANITY_MULTIPLIER))
```

A `+500%` grow on a variation that sold 40 → raw = 240, capped at 40 × 3 = 120. Never exceeds 3× the baseline.

### CUSTOM_UNITS

```
target[v] = round(targetUnits × demand[v] / totalDemand)
```

Distributes the total unit budget proportionally to each variation's share of last year's sales.

**Sum of all targets = targetUnits** (up to rounding).

### CUSTOM_REVENUE

Prices from section 6. Let `totalRevenueCents = Σ(demand[v] × priceCents[v])`.

```
revenueShare[v] = (demand[v] × priceCents[v]) / totalRevenueCents

target[v] = round((targetRevenueDollars × 100 × revenueShare[v]) / priceCents[v])
         = round(targetRevenueDollars × 100 × demand[v] / totalRevenueCents)
```

Distributes dollars by past **revenue** mix, then converts each variation's dollar allocation back to units at its own price. A $50k target with cheap products means many units; with pricey products, fewer.

### INITIAL_SHIPMENT

The CEO's "80-90% of stock" opening shipment.

```
warehouseCandidateStock = Σ warehouseOnHand[wv]
                          for wv where wv.variationId ∈ candidateVariations

initialShipmentBudget = floor(warehouseCandidateStock × initialShipmentPct / 100)

target[v] = round(initialShipmentBudget × demand[v] / totalDemand)
```

Sizes the total budget as `pct%` of current warehouse stock (default 85%). Then distributes that budget proportionally by last-season mix at this market.

---

## 8. Warehouse cap

Per family:

```
warehouseForFamily = Σ warehouseOnHand[wv] for wv in family
```

Then per line, `qty` is capped at that warehouse variant's own on-hand (`Math.min(raw, onHand)`).

**No line ever exceeds physical warehouse stock.**

---

## 9. Cross-market competing demand

If other markets have DRAFT or OPEN request lines for the same variation, they compete for the same warehouse pool. To keep the engine fair, it scales down proportionally:

```
competing[v]  = Σ qtyRequested from DRAFT/OPEN request lines at other markets for v

available[v]  = max(0, warehouseForFamily[v] - competing[v])

scaleFactor   = min(1, available[v] / familyTarget[v])

scaledTarget  = floor(familyTarget × scaleFactor)
```

If Denver wants 100 and Atlanta already has a DRAFT for 80 out of a 150-unit warehouse pool, Denver's request gets scaled down to fit what's left — no first-come-first-served.

---

## 10. Colour split per family

Once we have a family-level `scaledTarget`, we split it across colours using this priority chain (in `colourSplitProvenance`):

1. **`LOCAL_SALES`** — real per-colour SALE events at this market (`type = 'SALE'`, `warehouseVariantId ≠ null`). Best signal.
2. **`CROSS_SALES`** — cross-market per-colour sales (new-market case only, when the whole market has no local sales).
3. **Even split** across the family's warehouse variants (last resort — Square catalog mapped at family level only).

Dispatches are **not** used for colour split. Families whose Square catalog isn't mapped per-SKU fall straight to the even-split path — the rationale calls this out explicitly.

### 10a. Direct per-colour math for MATCH / GROW

When mode is `MATCH_LAST_YEAR` or `GROW_PCT` **and** the split source is real `LOCAL_SALES`:

```
for each warehouseVariant wv in family:
  colourSold[wv] = SALE_count[wv]  // per-colour local sales

  if MATCH_LAST_YEAR:
    perColourTarget[wv] = colourSold[wv]

  if GROW_PCT:
    raw = round(colourSold[wv] × (1 + growthPct/100))
    perColourTarget[wv] = min(raw, round(colourSold[wv] × SANITY_MULTIPLIER))

  perColourRaw[wv] = perColourTarget[wv] × scaleFactor
```

**Why this branch exists:** for these modes, "family target × colour share" is arithmetically the same as "colour sold" (both proportional to sales), but the direct path expresses the operator's mental model literally. If Black sold 8, MATCH mode recommends 8 Black — not "family target × 28%".

### 10b. Proportional split for budget modes (or fallback)

For `CUSTOM_UNITS`, `CUSTOM_REVENUE`, `INITIAL_SHIPMENT`, or when direct colour sales aren't available:

```
mixTotal = Σ colourMix[wv] for wv in family

perColourRaw[wv] = scaledTarget × (colourMix[wv] / mixTotal)
```

If `mixTotal = 0` (no colour signal at all), even split:

```
perColourRaw[wv] = scaledTarget / familyVariantCount
```

### 10c. Warehouse cap per colour

```
finalQty[wv] = round(min(perColourRaw[wv], warehouseOnHand[wv]))
```

Zero-quantity lines are omitted from the result. No `0`s in the UI.

---

## 11. Confidence per line (`decideConfidence`)

Rules, in order:
1. **`usedCrossMarket`** → always `LOW`
2. Observed sales `< 5` → `MEDIUM` (sparse data)
3. `GROW_PCT` with `|growthPct| > 50` → `MEDIUM` (extrapolating aggressively)
4. `mixTotal = 0` (no per-item sales → colour mix estimated evenly) → `MEDIUM`
5. Otherwise → `HIGH`

Displayed as a chip next to each colour name: pine (HIGH) / signal (MEDIUM) / rust (LOW).

---

## 12. Rationale per line (`buildRationale`)

Human-readable sentence, semicolon-separated. Built from these parts:

**Opening — where the demand signal came from:**

| Path | Sentence |
|------|----------|
| Cross-market inference | `No local sales at {marketName} — estimated from other markets' sales` |
| Local per-item sales, MATCH/GROW | `Sold 8 of this item last season` |
| Local per-item sales, budget mode | `Sold 8 of this item last season (28% of this style's item sales)` |
| No item-level, family only | `Style sold 45 last season (item mix estimated evenly — Square records this style's sales at family level only)` |

**Middle — target mode context:**

- `GROW_PCT +N%` → `growing target by N%`
- `GROW_PCT -N%` → `shrinking target by N%`
- `CUSTOM_UNITS` → `scaled to fit your custom unit budget`
- `CUSTOM_REVENUE` → `scaled to hit your revenue target`
- `INITIAL_SHIPMENT` → `sized as a share of current warehouse stock (initial shipment)`

**Cross-market note (when relevant):**

- `{competing} units also requested by other markets`

**Closing — warehouse status:**

- `warehouse has {onHand} available`

Joined with `; ` and terminated with `.`.

---

## 13. Sorting

Lines are sorted by real market demand — highest first — regardless of target mode.

**Sort keys (in order):**

```
1. familyLastYearSold DESC      // real demand at this market
2. qtyRecommended     DESC      // tiebreaker
3. lastYearSold       DESC      // per-colour demand within a family
4. variationId        ASC       // deterministic tiebreaker
```

Frontend groups lines into families and re-sorts by:

```
1. familyLastYearSold DESC
2. totalRecommendedForFamily DESC
3. variationId        ASC
```

Same result: bestseller **products** always lead, then within a product bestselling **colours** lead. Custom-revenue no longer surfaces expensive-but-slow-moving items above high-demand cheap ones.

---

## 14. Reliability guardrails

Summary of every safety mechanism:

| Guardrail | Effect |
|-----------|--------|
| `SANITY_MULTIPLIER = 3` in `GROW_PCT` | Never recommend more than 3× last year |
| Warehouse cap per WV | Never recommend more than physical stock |
| Cross-market scaling | Never starve another market |
| No zero-qty lines | Only lines the engine believes in are shown |
| Confidence badges | Visual cue when a line rests on thin data |
| Missing prices in `CUSTOM_REVENUE` | Excluded from calc, note surfaces |
| Missing warehouse stock in `INITIAL_SHIPMENT` | Note surfaces |
| Empty demand data | Empty result + note, not a guess |
| Deterministic sort keys | Same inputs → same output every run |

---

## 15. Endpoint contract

**Request:** `POST /requests/generate-suggestion`

```typescript
{
  locationId: string,
  targetMode: 'MATCH_LAST_YEAR' | 'GROW_PCT' | 'CUSTOM_UNITS'
            | 'CUSTOM_REVENUE' | 'INITIAL_SHIPMENT',
  growthPct?:            number,   // required for GROW_PCT
  targetUnits?:          number,   // required for CUSTOM_UNITS
  targetRevenueDollars?: number,   // required for CUSTOM_REVENUE
  initialShipmentPct?:   number,   // default 85 for INITIAL_SHIPMENT
  categoryIds?:          string[],
  lastYearStart?:        Date,
  lastYearEnd?:          Date,
}
```

**Response:**

```typescript
{
  locationId: string,
  targetMode: string,
  window: { start: Date, end: Date },
  lines: [{
    variationId: string,
    warehouseVariantId: string | null,
    qtyRecommended: number,
    lastYearSold: number,             // per-item sales last season
    familyLastYearSold: number,       // family-level sales, drives sort
    warehouseOnHand: number,
    otherLocationDemand: number,
    rationale: string,
    confidence: 'HIGH' | 'MEDIUM' | 'LOW',
  }],
  totals: {
    variationsCovered: number,
    totalRecommendedUnits: number,
    totalLastYearUnits: number,
  },
  notes: string[],
}
```

---

## 16. Approve vs Save Draft

The UI shows two primary actions after generation:

- **Save as draft** — `POST /requests` with `initialState: 'DRAFT'`. Creates a DRAFT request. Requester still has to click Submit later.
- **Approve → send N units** — `POST /requests` with `initialState: 'OPEN'`. Creates DRAFT and transitions to OPEN in one atomic transaction, emitting two audit rows (DRAFT creation + DRAFT→OPEN transition). Warehouse sees it in their queue immediately.

Both write the same edited `lines`. Both accept per-line qty edits, added items, removed families.

---

## 17. Concrete end-to-end example

**Scenario:** Owner picks Atlanta, Custom units mode, budget = 500.

Atlanta's last-year sales at family level:

| Style | Sold |
|-------|------|
| Alpaca Beanie | 40 |
| Sport Socks Small | 28 |
| Lap Blanket | 45 |
| Merino Scarf | 12 |
| Others | 75 |
| **Total** | **200** |

**Step 1: Family targets** (Custom units formula):
```
Alpaca Beanie      → round(500 × 40/200) = 100
Sport Socks Small  → round(500 × 28/200) =  70
Lap Blanket        → round(500 × 45/200) = 113
Merino Scarf       → round(500 × 12/200) =  30
Others             → round(500 × 75/200) = 187
```

**Step 2: Colour split — Alpaca Beanie**

Per-colour SALES exist for Alpaca Beanie:
- Navy 20 sold, Charcoal 12 sold, Rust 8 sold
- Mix total = 40, shares = 50% / 30% / 20%

```
Navy     = 100 × 50% = 50
Charcoal = 100 × 30% = 30
Rust     = 100 × 20% = 20
```

**Step 3: Warehouse cap**

Warehouse has: Navy 40, Charcoal 55, Rust 25.

```
Navy     = min(50, 40) = 40
Charcoal = min(30, 55) = 30
Rust     = min(20, 25) = 20
```

Family total after cap = 90 (was 100). Shortfall 10 not redistributed.

**Step 4: Cross-market fairness**

Denver has DRAFT for 50 Alpaca Beanies (family level). Warehouse family stock is 120 total.

```
competing = 50
available = max(0, 120 - 50) = 70
scaleFactor = min(1, 70 / 100) = 0.7
```

Each colour scaled by 0.7:
```
Navy     = 40 × 0.7 = 28
Charcoal = 30 × 0.7 = 21
Rust     = 20 × 0.7 = 14
Family total = 63
```

**Step 5: Confidence + rationale**

Local per-colour sales, `mixTotal > 0`, MATCH-style modes not applied (CUSTOM_UNITS), no low-data or extreme-growth triggers → **HIGH**.

Rationale for Navy:
```
Sold 20 of this item last season (50% of this style's item sales);
scaled to fit your custom unit budget;
50 units also requested by other markets;
warehouse has 40 available.
```

**Step 6: Sorting**

Families sorted by `familyLastYearSold` desc:
1. Lap Blanket (45 sold)
2. Alpaca Beanie (40 sold)
3. Sport Socks Small (28 sold)
4. Merino Scarf (12 sold)
5. Others...

Bestselling product leads, regardless of dollar allocation or budget share.

---

## 18. Test data seeding

To generate a full test dataset for the engine, use the CLIs:

```bash
# 1. Optional: wipe existing ledger events for a clean slate
pnpm --filter api cli:wipe-fake-sales -- --apply

# 2. Seed comprehensive test data
pnpm --filter api cli:seed-suggest-test-data -- --apply
```

The seed CLI writes:
- Warehouse baseline INTAKE (500 units per WV)
- **RICH markets** (first ~50%): dense per-colour SALEs (with paired INTAKEs) + DISPATCHes → HIGH confidence
- **MEDIUM markets** (next 2): sparse per-colour SALEs + DISPATCHes → MEDIUM confidence (few observations)
- **EMPTY markets** (next 2): nothing → LOW confidence (cross-market inference)
- Every SALE paired with an INTAKE 1ms earlier so market on-hand stays non-negative
- DISPATCHes are written for parity with real market flow but are **not** consumed by the recommendation engine (sales-only, see §5)

See `apps/api/src/cli/seed-suggest-test-data.ts` for details.

---

## 19. Where to change things

| Concern | File | Notes |
|---------|------|-------|
| Add a new target mode | `packing-list-suggestion.service.ts` (target math switch), `packages/shared/src/requests.ts` (enum), `page.tsx` (UI segment) | 3 places |
| Adjust `SANITY_MULTIPLIER` | `packing-list-suggestion.service.ts` line ~262 | Constant |
| Change sales window default | `resolveLastYearWindow` in `packing-list-suggestion.service.ts` | Bottom of file |
| Add a colour split source | `colourSplitSourceByVariation` block + `colourSplitProvenance` union | Two spots |
| Change confidence rules | `decideConfidence` at bottom of service | Ordered predicates |
| Change rationale wording | `buildRationale` at bottom of service | Only text change |
| Change sorting | `lines.sort` in service + `hydrateFamilies` in `page.tsx` | Two spots |
| Add a new price source (e.g., Square retail) | `priceCentsByVariation` block in service | Extend with fallback chain |

---

## 20. What this engine deliberately does NOT do

- **No ML / no LLM.** Deterministic rules only. Auditable, explainable, no hallucinations.
- **Never invents numbers.** Empty data → empty result + note, not a guess.
- **Never trains on our own request history.** Only Square sales. Our own requests were themselves generated from prior recommendations — using them would create a self-reinforcing loop.
- **Never uses dispatches as a demand signal.** Dispatches are shipping activity, not customer intent. Mixing them into "demand" hides whether a suggested number came from real purchases — the operator wanted a pure sales-based recommendation.
- **No seasonality decomposition.** Same window used regardless of when in the year we're planning. Could be added later via statistical methods (Prophet, seasonal-trend decomposition) — see section 19 for the change points.
- **No trend detection.** A product that's been growing 30% each of the last 3 seasons is treated the same as one that's been flat. Same "later" note applies.

The engine is a floor, not a ceiling. Improving accuracy comes from better data (Square backfill, per-colour catalog mapping) — not from adding more layers of algorithm.
