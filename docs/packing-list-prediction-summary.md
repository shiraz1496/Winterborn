# Packing List Prediction: What We Built

Summary of the suggestion engine (`packing-list-suggestion.service.ts`) and the
Suggest page that renders it. For full implementation detail see
`packing-list-suggestion.md`.

## The requirements

1. **Existing markets**: predict from that market's own sales history, respect
   total warehouse stock, and don't let one market drain shelves other markets
   need.
2. **New markets**: infer starting demand from what's popular across every
   other location.
3. **Explain itself**: every number on screen must be traceable to the data and
   rules that produced it, in plain English.
4. **Pack like a human would**: round quantities, no single-unit lines, and a
   buffer so the booth isn't bare the moment the target is met.

## The demand ladder

The engine never dead-ends. It walks down these rungs and uses the first that
produces anything, recording which one it landed on:

| # | Source | When it fires |
|---|---|---|
| 1 | `LOCAL_SALES` | This market's own sales inside the chosen window |
| 2 | `LOCAL_SALES_WIDENED` | Chosen window was empty, so it widened to all sales history we hold |
| 3 | `CROSS_MARKET` | Market has no sales of its own; other markets' sales ÷ market count |
| 4 | `CROSS_MARKET_WIDENED` | Same, over all history |
| 5 | `WAREHOUSE_STOCK` | Nothing has ever sold in scope, so it is sized from warehouse stock, split evenly across all active markets |

**A date range outside the season no longer returns "no sales data found."** It
widens automatically, and the panel's Window row says so.

## Pack shape

Raw arithmetic produces 21 and 1. Neither is a pack.

- **`roundToNearest`** (default 5): every quantity lands on a multiple of it.
- **`minPackQty`** (default 5): the floor for a line that survives.
  - Demand that rounds up to at least one pack is raised to the minimum.
  - Demand too small to round up to a pack at all is **dropped, not bumped**.
    Otherwise a style selling 3 units across 10 colours would ship 10 minimum
    packs (50 units).
  - Budget modes drop the whole sub-minimum tail and **redistribute its budget**
    across the survivors, so a $30,000 target still allocates $30,000.
  - A line the warehouse cannot fill to the minimum is dropped and counted, not
    shipped as a token unit.

Locked in by `test/packing-list-pack-shape.spec.ts`.

## Shelf buffer

A revenue figure is a **sell-through goal**, not a shipping value. Ship exactly
the units that reach it and the table is bare on the last day. `shelfBufferPct`
defaults to 0% on every mode. The operator sets it themselves in the form;
inflating their number for them is the wrong fix. When set, it is applied on
top of the target before allocation.

The panel states the goal, the send target and the allocation as three separate
numbers (`targetDisplay`, `sendTargetDisplay`, `allocatedDisplay`) precisely so
the buffer is legible: a $25,000 goal at 20% reads as "$30,000 of stock to send".

## Hitting the budget

Budget modes run a **water fill**, not a single proportional pass:

1. Scale every line's target by a common factor and cap it at stock.
2. Lines pinned at their cap stay pinned; the remainder keeps flowing to the
   lines that still have room. Repeat until the budget is met or everything is
   capped.
3. Drop anything still under `minPackQty` and refill, so the dropped tail's
   budget genuinely reaches the survivors.
4. Round to pack sizes, then add or remove whole packs (`balanceToBudget`) to
   close the gap rounding just opened. It never trims below the target and
   never tops up past a cap or below `minPackQty`.

The fill is measured **in the budget's own currency**: cents for a revenue
target, units for a unit target. Measuring in units while the budget is in
dollars is what made a $25,000 goal come out at $18,481.

When the target genuinely cannot be reached, `budget.shortfall` says by how much
and that stock is the reason. Locked in by
`test/packing-list-budget-fill.spec.ts`.

## Five target modes

Match last season · Grow by % · Custom units · Custom revenue ($ split by
revenue mix, converted back to units at each product's own price) · Initial
shipment (% of total warehouse stock).

## Warehouse-safety cases handled

| Case | Behavior |
|---|---|
| Requested qty exceeds physical stock | Hard-capped at warehouse on-hand |
| Product popular across many markets | **Fair share**: this market's % of total historical demand caps its % of that product's stock |
| Colour popular locally but the product isn't | **Per-colour fair share** from real cross-market colour-level sales, so a colour only this market sells isn't throttled by siblings |
| Other markets have open/draft requests | Subtracted before this market's allocation is split |
| Closed/inactive markets | Excluded from fair-share maths entirely |
| Growth % exceeds what the warehouse can supply | Caps at what's available; the rationale states the growth target and the shortfall |
| Runaway growth input (+500%) | Sanity capped at 3× the observed baseline |
| No per-colour sales granularity | Even split across colours, flagged MEDIUM confidence |
| No price set on a SKU (revenue mode) | Excluded from the $ allocation, called out in the notes |
| Zero-history catalog | Warehouse stock ÷ active market count, never "everything to whoever generates first" |

## Explainability

**Run level** (`explain`): demand source, headline sentence, a one-phrase
`targetSummary`, ordered plain-English mechanism steps, the window requested vs.
the window actually used, the named markets an estimate came from with their
unit counts, the settings in force, and budget target vs. allocated. Run `notes`
carry only what the facts row does not already state (missing prices, an
unreachable unit target), so the panel does not repeat itself.

**Line level**: `steps[]` (the arithmetic in order: starting point, target,
buffer, market need, other markets, fair share, colour cap, rounding, final),
`bindingConstraint` (which rule actually set the number), `rationale` (one
sentence), and `confidenceReason`.

## Confidence

Grades the **data behind the number, not the quantity chosen**. It deliberately
does not move when the operator edits a count, and the UI says so. Cross-market
estimates are graded rather than blanket-LOW: ≥3 source markets with real volume
earns MEDIUM.

## Frontend (Suggest page)

- **"How this list was built" panel**: open by default, above the lines. A
  headline, four facts (data, window, target, pack shape), the source markets,
  the mechanism steps and the notes, all visible at once. The only thing that
  collapses is the source-market list, which has a "View all N" / "View less"
  toggle because it can run to dozens of entries. Warm left edge when the run is
  an estimate rather than a measurement.
- **Pack shape controls**: shelf buffer, rounding step, minimum per item.
- **Input starts at real demand, capped at physical warehouse stock**, and never
  below the recommendation. If a colour sold 302 last season and 1,504 are in
  the warehouse, the field defaults to 302 even when fair share reserves most of
  that stock for other markets. The "Suggested" chip still carries the
  warehouse-safe figure and snaps the field to it in one click.
- **Colours sort suggested-first, once at hydration**, so relevant items lead on
  first view and rows never jump while the operator is editing.
- **Unsuggested colours still render**, dimmed, tagged "Not suggested" → "Added
  by you" when a quantity is entered.
- **Per-line "Show the maths"** expands the full step list.
- Responsive at desktop, ≤900px and ≤480px.

## Supporting tooling

- `cli:assign-catalog-prices`: auto-assigns a price to any SKU missing one
  (needed for Custom revenue mode), deterministic per SKU, dry-run by default.

## Known, accepted limitations

- Cross-market inference only triggers when a market has **zero** sales history
  overall. An existing market missing one product line won't get that product
  auto-suggested from other markets' popularity.
- Two operators generating for two markets on the same product at the same
  moment, before either saves, can compute overlapping fair-share numbers. The
  physical warehouse floor at pack/dispatch time is the independent check that
  actually prevents overselling.
- The water fill is capped at 30 iterations and the pack balance at 500 passes.
  Both converge well inside that on real catalogs, but a pathological input
  could stop slightly short of the target rather than hanging.
