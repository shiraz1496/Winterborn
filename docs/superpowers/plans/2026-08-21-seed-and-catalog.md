# Seed and Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the client's real warehouse export into a seeded catalog: 564 items parsed, 248 colour values assigned to till families, both SKU levels generated and collision-checked, warehouse groups joined to Square items, and a scripted catalog restructure proven against sandbox.

**Architecture:** CLI commands in `apps/api`, driven by Prisma. Every command is idempotent and re-runnable. Catalog writes to Square follow a strict plan-then-apply-then-verify cycle: `plan` prints a full diff and mutates nothing, `apply` executes it, `verify` re-reads from Square and asserts what survived.

**Tech Stack:** TypeScript, NestJS CLI context, Prisma, PostgreSQL, Zod, Vitest, `square` SDK (sandbox only in this plan).

**Spec:** `docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md` — especially §6 (colour model), §8 (catalog restructuring).

**Prior work this depends on:**
- `docs/superpowers/decisions/2026-08-19-flat-item-migration.md` — settles how the migration must behave. **Read it before Task 5.** It is the authority, not this plan.
- Plan 2 delivered the schema, `LedgerService`, and the shared Zod contract.

**Client data on disk, gitignored:**
- `data/sortly.csv` — 564 items, 42,428 units, 248 colour values, 559 photo URLs
- `data/catalog-item-library-export.csv` — 143 Square rows across 14 locations
- `data/square-2025/` — 41,226 transactions, 52,343 item lines

## Global Constraints

- **Sandbox only.** No production Square token is used anywhere in this plan. The production catalog run is a separate, gated exercise.
- **Plan before apply.** No command mutates Square without a preceding `plan` whose diff has been read.
- **Read-modify-write, always.** Constructing a Square catalog object from scratch drops `locationOverrides` and `present_at_location_ids`. The decision record proves the former is preserved by spreading and lost by reconstruction.
- **New variations do not inherit overrides.** The decision record's headline consequence: a migration preserves the legacy row's per-location price but creates new variations with none. Any apply command must reapply them explicitly, and `verify` must fail the run if they are missing.
- **Colour is never free-typed.** Variant names come from the Sortly parse or from a controlled creation path that forces family assignment.
- **`LedgerService` remains the sole writer to `ledger_event`.** Seeding writes catalog rows, never ledger rows.
- **Client data never leaves the machine.** `data/` is gitignored. No export, no fixture, and no test may embed real client sales figures in a committed file.
- Node 20+. pnpm. Money in integer cents.

## Testing Policy

Same posture as Plan 2, narrow and deliberate.

**Test:** the parse against known totals from the real file, SKU collision behaviour, family-assignment determinism, the Sortly-to-Square join, and that a catalog `apply` preserves overrides and availability.

**Do not test:** Prisma behaviour, CSV library behaviour, or Square SDK behaviour already established by Plan 1's prototypes.

---

### Task 1: Carry-forward hardening

Three items scheduled at the close of Plan 2, deliberately recorded rather than absorbed. Doing them first, before catalog data lands, because two get materially more expensive once rows exist.

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*/migration.sql` (generated)
- Modify: `apps/api/test/ledger-derive.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything from Plan 2
- Produces: `LedgerReadService.recomputeByVariant(locationId?)` alongside the existing `recompute()`

- [ ] **Step 1: Add the missing foreign keys (S1)**

Spec §5.4 specifies `variation_id → Variation` and `warehouse_variant_id → WarehouseVariant` on `LedgerEvent`. The schema has only the `Location` relation. `RestockRequestLine` and `Threshold` in the same file both carry the relations `LedgerEvent` omits, so this is inconsistency, not a considered exception.

It matters more now than it did before the append-only trigger landed: a row referencing a variation that does not exist inserts silently, permanently skews every derivation, and **cannot be deleted**. The only remedy is an offsetting `CORRECTION` plus a permanent orphan in the event stream.

Add both relations to `LedgerEvent` in `schema.prisma`:

```prisma
  variation        Variation         @relation(fields: [variationId], references: [id])
  warehouseVariant WarehouseVariant? @relation(fields: [warehouseVariantId], references: [id])
```

Add the reciprocal `ledgerEvents LedgerEvent[]` on both `Variation` and `WarehouseVariant`.

Do **not** add a relation for `actorId`. Ledger rows must survive a user being deleted, and a required `User` relation would either block that deletion or cascade into the event log. Add a comment saying so, or the next reader will "fix" the inconsistency.

Then migrate:

```bash
export DATABASE_URL="postgresql://winterborn:winterborn@localhost:5432/winterborn"
pnpm --filter @winterborn/api exec prisma migrate dev --name ledger_foreign_keys
```

**Existing test rows will violate the new constraint.** `seedDevCatalog` truncates before every test, so the test suite is unaffected, but a populated dev database will refuse the migration. If it does, reset it (`prisma migrate reset`) rather than weakening the constraint.

- [ ] **Step 2: Verify the foreign keys reject an orphan**

Add to `apps/api/test/ledger-append.spec.ts`:

```typescript
it('rejects a ledger row referencing a variation that does not exist', async () => {
  // Before the FK existed this inserted silently, skewed every derivation
  // that touched the variation, and could not be deleted because of the
  // append-only trigger. The only remedy was an offsetting CORRECTION plus
  // a permanent orphan in the event stream.
  await expect(
    ledger.append({
      type: 'SALE',
      locationId: seed.denverId,
      variationId: 'var_does_not_exist',
      quantity: -1,
      occurredAt: new Date(),
      source: 'WEBHOOK',
      idempotencyKey: saleKey('order_orphan', 'line_1'),
    }),
  ).rejects.toThrow()
  expect(await prisma.ledgerEvent.count()).toBe(0)
})
```

- [ ] **Step 3: Add a randomised replay check for variant-level derivation (S2)**

`onHandByVariant()` is a genuinely different query from `onHandByFamily()`: different `WHERE`, different `GROUP BY`. It backs box manifests and the season-close `sent − returned` sell-through report, which the spec calls the first colour-level demand data this business has ever had. Its entire protection today is one fixed scenario asserting `40`.

Add `recomputeByVariant()` to `LedgerReadService`, as hand-written SQL, mirroring how `recompute()` relates to `onHandByFamily()`:

```typescript
  /**
   * Variant-level counterpart to recompute(). Hand-written SQL against the
   * table, so it and onHandByVariant() are two independent implementations
   * that must always agree. Same reasoning as recompute(): a derivation-logic
   * bug in either is caught by their disagreement.
   */
  async recomputeByVariant(locationId?: string): Promise<StockLevel[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ warehouseVariantId: string; variationId: string; locationId: string; onHand: bigint }>
    >`
      SELECT "warehouseVariantId", "variationId", "locationId", SUM("quantity")::bigint AS "onHand"
      FROM "LedgerEvent"
      WHERE "warehouseVariantId" IS NOT NULL
      ${locationId ? Prisma.sql`AND "locationId" = ${locationId}` : Prisma.empty}
      GROUP BY "warehouseVariantId", "variationId", "locationId"
    `
    return rows.map((r) => ({
      variationId: r.variationId,
      warehouseVariantId: r.warehouseVariantId,
      locationId: r.locationId,
      onHand: Number(r.onHand),
    }))
  }
```

Then extend the existing replay property test in `ledger-derive.spec.ts` so each round asserts variant-level agreement as well as family-level, reusing the same generated history and the same seeded LCG. Normalise on `warehouseVariantId|locationId|onHand`.

- [ ] **Step 4: Widen the sole-writer CI guard (F5)**

The guard greps for `prisma.ledgerEvent.create(` only. A `createMany(...)` bypasses it entirely, and bulk sale ingestion in the next plan is exactly where someone reaches for `createMany`.

Widen the pattern in `.github/workflows/ci.yml` to catch `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany` and `upsert` against `ledgerEvent`, still excluding `ledger.service.ts`. Keep the explanatory failure message.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm build && pnpm test
```

Expected: green, with the ledger test count up by one and the property test now asserting both granularities.

```bash
git add -A
git commit -m "fix(api): ledger foreign keys, variant replay check, wider sole-writer guard"
```

---

### Task 2: Sortly import

Parse the real warehouse export into the catalog schema. This is the seed everything downstream reads.

**Files:**
- Create: `apps/api/src/catalog/sortly-parser.ts`
- Create: `apps/api/src/catalog/catalog.module.ts`
- Create: `apps/api/src/cli/import-sortly.ts`
- Create: `apps/api/test/sortly-parser.spec.ts`
- Create: `apps/api/test/fixtures/sortly-sample.csv`
- Modify: `apps/api/package.json` (add `csv-parse`, add the CLI script)

**Interfaces:**
- Consumes: Prisma models from Plan 2
- Produces:
  - `type ParsedSortlyItem = { entryName: string; sid: string; itemGroupName: string; colour?: string; style?: string; size?: string; quantity: number; minLevel?: number; unitCostCents?: number; photoUrl?: string; primaryFolder: string; subfolder1?: string; subfolder2?: string }`
  - `parseSortlyCsv(csvText: string): { items: ParsedSortlyItem[]; skipped: Array<{ row: number; reason: string }> }`
  - `pnpm --filter @winterborn/api cli:import-sortly -- --file data/sortly.csv`

- [ ] **Step 1: Write the fixture and the failing test**

**Do not commit real client data.** Build `apps/api/test/fixtures/sortly-sample.csv` by hand: the real header row, then roughly 12 rows you author yourself that reproduce the *shapes* found in the real file. Cover all of these, because each one broke a naive parser during analysis:

- attributes scattered across slots: `Attribute 1 Name` is `Color` on some rows, `Style` or `Size` on others
- a row with all three of Color, Style and Size
- a row with none (2 of 564 real rows have no attributes at all)
- a folder row, `Entry Type` of `Folder`, which must be skipped
- a quoted field containing a comma, mirroring `Cullman, AL`
- a colour value that is plainly a design name rather than a colour, e.g. `Pirate Pants (2024)`
- a zero-quantity row
- an empty `Min Level` and an empty `Price`

`apps/api/test/sortly-parser.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSortlyCsv } from '../src/catalog/sortly-parser.js'

const sample = readFileSync(join(__dirname, 'fixtures/sortly-sample.csv'), 'utf8')

describe('parseSortlyCsv', () => {
  it('skips folder rows and keeps only items', () => {
    const { items } = parseSortlyCsv(sample)
    expect(items.every((i) => i.sid.length > 0)).toBe(true)
    expect(items.some((i) => i.entryName.includes('FOLDER'))).toBe(false)
  })

  it('normalises attributes regardless of which slot they occupy', () => {
    // The real export puts Color in slot 1 on 453 rows, slot 2 on 37 others,
    // and Size in slots 1, 2 and 3 depending on the row. A parser that reads
    // slot 1 as "colour" silently mislabels hundreds of items.
    const { items } = parseSortlyCsv(sample)
    const colourInSlotTwo = items.find((i) => i.entryName === 'SLOT2_COLOUR')
    expect(colourInSlotTwo?.colour).toBe('Blue')
    const sizeInSlotThree = items.find((i) => i.entryName === 'SLOT3_SIZE')
    expect(sizeInSlotThree?.size).toBe('Large')
  })

  it('handles a row with no attributes at all', () => {
    const { items } = parseSortlyCsv(sample)
    const bare = items.find((i) => i.entryName === 'NO_ATTRS')
    expect(bare).toBeDefined()
    expect(bare?.colour).toBeUndefined()
  })

  it('parses quantity and leaves blank optional numerics undefined', () => {
    const { items } = parseSortlyCsv(sample)
    const zero = items.find((i) => i.entryName === 'ZERO_QTY')
    expect(zero?.quantity).toBe(0)
    expect(zero?.minLevel).toBeUndefined()
    expect(zero?.unitCostCents).toBeUndefined()
  })

  it('survives a quoted field containing a comma', () => {
    const { items } = parseSortlyCsv(sample)
    const comma = items.find((i) => i.entryName === 'COMMA_FIELD')
    expect(comma?.subfolder1).toBe('Cullman, AL')
  })

  it('reports skipped rows rather than dropping them silently', () => {
    const { skipped } = parseSortlyCsv(sample)
    expect(Array.isArray(skipped)).toBe(true)
    expect(skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @winterborn/api test -- sortly-parser
```

Expected: FAIL, cannot resolve the parser.

- [ ] **Step 3: Implement the parser**

Use `csv-parse/sync` with `columns: true`. Key behaviours:

- Skip any row whose `Entry Type` is not `Item`, recording it in `skipped`
- Normalise attributes by scanning slots 1, 2 and 3 and keying on `Attribute N Name`, not on position
- Money in integer cents: `Price` is a decimal string, convert with rounding, blank becomes `undefined`
- `Quantity` blank becomes `0`; `Min Level` blank becomes `undefined`, which is not the same thing
- Trim every string field; treat `''` as absent
- Never throw on a malformed row. Record it in `skipped` with a reason and continue, so one bad row cannot cost the other 563

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @winterborn/api test -- sortly-parser
```

- [ ] **Step 5: Write the import CLI and run it against the real file**

`import-sortly.ts` reads a `--file` path, parses, and upserts in dependency order: `Category` from `Subfolder-level1`, `ItemGroup` from `Item Group Name`, `SizeOption`, `ColourVariant` (family assignment deferred to Task 3, so attach every variant to a per-category `Unassigned` family for now), then `WarehouseVariant`.

Idempotent: re-running must not duplicate. Upsert on the natural keys the schema already declares unique.

Print a summary: rows read, items parsed, skipped with reasons, and counts created per model.

```bash
export DATABASE_URL="postgresql://winterborn:winterborn@localhost:5432/winterborn"
pnpm --filter @winterborn/api cli:import-sortly -- --file ../../data/sortly.csv
```

**Expected against the real file, from prior analysis. Treat a mismatch as a parser bug, not as a reason to change these numbers:**

- 585 rows read, 564 items, 21 folders skipped
- 50 distinct item groups
- 248 distinct colour values
- total quantity 42,428
- 96 items at zero quantity
- 41 items with a min level
- 6 items with a price
- 559 items with a photo URL

Run it twice and confirm the second run creates nothing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): Sortly export parser and idempotent import command"
```

---

### Task 3: Colour family derivation

Assign 248 warehouse colour values to till families. Spec §6.3, rewritten after measuring the real data.

**Files:**
- Create: `apps/api/src/catalog/colour-lexicon.ts`
- Create: `apps/api/src/catalog/family-assigner.ts`
- Create: `apps/api/src/cli/assign-families.ts`
- Create: `apps/api/test/family-assigner.spec.ts`

**Interfaces:**
- Consumes: `ColourVariant` rows from Task 2
- Produces:
  - `type FamilyAssignment = { variantName: string; family: string; source: 'LEXICAL' | 'SYNONYM' | 'VISUAL' | 'MANUAL'; confidence: number }`
  - `assignFamily(variantName: string): FamilyAssignment | null` — null means the residual, needing eyes
  - `pnpm --filter @winterborn/api cli:assign-families`

**Read this before writing code.** The Sortly `Color` attribute is **not always a colour**. For Mittens and Headwear it genuinely is: `Blue`, `Brown`, `Gray`, `Pink w/ White`. For Scarves, Capes and Wraps it is a **design name**: `Pirate Pants (2024)`, `Mint Chocolate Chip`, `Ecuadorian Airlines (2024)`, `Shady Grove`, `"The Classic" v. 2`, `Creamsicle`. There is no colour token to extract, and a multi-stripe scarf does not meaningfully have one colour.

Measured across all 248 values: **208 contain a recognisable colour word, 40 do not.** Weighted by units, the residual is 1.4% of Footwear, 0.2% of Headwear, 8.1% of Garments, **15.3% of Scarves and 29.3% of Mittens**. Mittens looks worst but is easiest: almost all of it is `Multiple` and `Traditional Pattern`, 1,504 units of patterned flip mitts, which resolve to `Multi` the moment the lexicon knows those phrases. Scarves is the genuine problem.

So the derivation is **three passes, and the third is human**. Do not attempt to make the algorithm cover 100%; that is how confidently wrong data gets created.

- [ ] **Step 1: Write the failing test**

`apps/api/test/family-assigner.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { assignFamily } from '../src/catalog/family-assigner.js'

describe('lexical pass', () => {
  it('extracts a base colour word', () => {
    expect(assignFamily('Blue')?.family).toBe('Blue')
    expect(assignFamily('Dark Blue Stripes (2024)')?.family).toBe('Blue')
    expect(assignFamily('French Gray')?.family).toBe('Gray')
  })

  it('knows the trade vocabulary actually present in the export', () => {
    // These are real values from the client's warehouse. A base-colour-only
    // palette misses every one of them.
    expect(assignFamily('Almond')?.family).toBe('Cream')
    expect(assignFamily('Camel')?.family).toBe('Brown')
    expect(assignFamily('Taupe')?.family).toBe('Brown')
    expect(assignFamily('Champagne')?.family).toBe('Cream')
    expect(assignFamily('Mulberry Sheen')?.family).toBe('Purple')
    expect(assignFamily('Clementine')?.family).toBe('Orange')
    expect(assignFamily('Wheat & Honey')?.family).toBe('Cream')
  })

  it('resolves a compound by its first colour token, not its last', () => {
    // "Blue w/ Black" is a blue mitten with black trim, not a black one.
    expect(assignFamily('Blue w/ Black')?.family).toBe('Blue')
    expect(assignFamily('Pink w/ White')?.family).toBe('Pink')
  })
})

describe('synonym pass', () => {
  it('maps non-colour phrases that nonetheless have an obvious family', () => {
    expect(assignFamily('Multiple')?.family).toBe('Multi')
    expect(assignFamily('Multicolor')?.family).toBe('Multi')
    expect(assignFamily('Traditional Pattern')?.family).toBe('Multi')
    expect(assignFamily('Grayscale')?.family).toBe('Gray')
    expect(assignFamily('4-Shade Browns')?.family).toBe('Brown')
    expect(assignFamily('Assorted Beiges & Browns')?.family).toBe('Brown')
  })

  it('marks synonym matches with a lower confidence than lexical ones', () => {
    const lexical = assignFamily('Navy')
    const synonym = assignFamily('Traditional Pattern')
    expect(lexical?.source).toBe('LEXICAL')
    expect(synonym?.source).toBe('SYNONYM')
    expect(synonym!.confidence).toBeLessThan(lexical!.confidence)
  })
})

describe('residual', () => {
  it('returns null for a design name with no colour signal', () => {
    // These need a human looking at the photo. Guessing here would produce
    // confidently wrong data, which is worse than an honest gap.
    expect(assignFamily('Pirate Pants (2024)')).toBeNull()
    expect(assignFamily('Ecuadorian Airlines (2024)')).toBeNull()
    expect(assignFamily('On the Waterfront')).toBeNull()
    expect(assignFamily('"The Classic" v. 2')).toBeNull()
    expect(assignFamily('Shady Grove')).toBeNull()
  })
})

describe('determinism', () => {
  it('returns the same answer every time for the same input', () => {
    const runs = Array.from({ length: 5 }, () => assignFamily('Seafoam/Blue/Grey (2024)'))
    expect(new Set(runs.map((r) => r?.family)).size).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

```bash
pnpm --filter @winterborn/api test -- family-assigner
```

`colour-lexicon.ts` holds two tables and nothing else, so the vocabulary is reviewable in one place:

- **Palette**: base colours plus the trade vocabulary the export actually uses — `almond, camel, taupe, champagne, coco, sand, wheat, honey, mulberry, amethyst, ruby, eggplant, bourbon, clementine, pumpkin, sapphire, periwinkle, seafoam, oatmeal, denim, charcoal, ash, slate, raspberry, berry, plum, lilac, lavender, emerald, olive, moss, sage, rust, crimson, burgundy, wine, maroon, ivory, beige, tan, natural, neutral, silver`, each mapped to its family
- **Synonyms**: non-colour phrases with an obvious family — `Multiple`, `Multicolor`, `Traditional Pattern`, `Spotted`, `Houndstooth`, `Cool Tones`, `Warm Tones`, `Candy-Corn Stripes`, `Wild Stripes`, `Grayscale`, `4-Shade Browns`, `Assorted ...`

`family-assigner.ts` normalises (lowercase, strip punctuation and trailing year suffixes like `(2024)`, expand `&` and `w/`), then tries palette tokens **in order of appearance** so a compound resolves to its first colour, then synonyms, then returns `null`.

Confidence: lexical `0.9`, synonym `0.6`. Those numbers exist to sort the review queue worst-first, nothing more.

- [ ] **Step 3: Run the assigner against the real 248 values**

`assign-families.ts` reads every `ColourVariant`, assigns, creates `ColourFamily` rows per category as needed, updates `colourFamilyId`, `familyAssignmentSource` and `familyConfidence`, and leaves the residual attached to `Unassigned`.

Print, and record in the report:
- counts by source: lexical, synonym, residual
- the **full list of residual variant names**, since that is the review queue
- family sets per category, with a warning wherever a category exceeds **12 families**, since spec §6.1 targets 6 to 12

Expected: roughly 208 assigned lexically or by synonym, roughly 40 residual. **If the residual is far below 40, the lexicon is over-reaching and inventing colours for design names.** That is the failure mode to watch for, not under-coverage.

- [ ] **Step 4: Archive the photos, because the residual needs them**

The residual can only be resolved by looking at the product. 559 of 564 items carry a `Photo1` URL on `lnk.sortly.co`, which resolves to a short-lived signed S3 link and works today. **Those URLs die with the client's Sortly subscription, which the project retires in October.** They are the only visual record of the warehouse.

Add `apps/api/src/cli/archive-photos.ts`: read `data/sortly.csv`, download each `Photo1` to `data/photos/<sid>.jpg`, skip files already present so it is resumable, and write `ColourVariant.photoUrl` to the local relative path.

Be a considerate client: sequential or lightly concurrent, a short delay between requests, and a clear failure summary rather than a crash on the first 404. Roughly 95 MB total.

```bash
pnpm --filter @winterborn/api cli:archive-photos
```

`data/` is gitignored, so the images stay local. Do not commit them.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): three-pass colour family derivation and photo archival"
```

---

### Task 4: SKU generation

Both levels, collision-checked across all 564 items. Spec §5.3.

**Files:**
- Create: `apps/api/src/catalog/sku.ts`
- Create: `apps/api/src/cli/generate-skus.ts`
- Create: `apps/api/test/sku.spec.ts`

**Interfaces:**
- Consumes: `Variation` and `WarehouseVariant` rows from Tasks 2 and 3
- Produces:
  - `tillSku(category, group, family, size): string`
  - `warehouseSku(category, group, variant, size, brand): string`
  - `checkCollisions(skus: string[]): Array<{ sku: string; count: number }>`
  - `pnpm --filter @winterborn/api cli:generate-skus`

The scheme is `CAT-GROUP-COLOUR-SIZE`. The two levels differ only in what fills the colour segment: the **family** for a till SKU, the **variant** for a warehouse SKU. `[Fraas]` resale carries a brand segment; Carmel only, about $10k of season revenue, and the SKU scheme must handle it deliberately rather than as an accident.

- [ ] **Step 1: Write the failing test**

`apps/api/test/sku.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { tillSku, warehouseSku, checkCollisions } from '../src/catalog/sku.js'

describe('tillSku', () => {
  it('builds CAT-GROUP-FAMILY-SIZE', () => {
    expect(tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')).toBe('SCF-STR-BLU-R')
  })

  it('is stable across calls', () => {
    const a = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    const b = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    expect(a).toBe(b)
  })
})

describe('warehouseSku', () => {
  it('uses the variant, not the family, in the colour segment', () => {
    const till = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    const wh = warehouseSku('Scarves', 'Standard Scarves | Stripes', 'Bright Blue Variegated', 'Regular', 'OWN')
    expect(wh).not.toBe(till)
    expect(wh.startsWith('SCF-STR-')).toBe(true)
  })

  it('carries a brand segment for Fraas resale', () => {
    const own = warehouseSku('Scarves', 'Standard Scarves | Plaids', 'Bold Green', 'Regular', 'OWN')
    const fraas = warehouseSku('Scarves', 'Standard Scarves | Plaids', 'Bold Green', 'Regular', 'FRAAS')
    expect(fraas).not.toBe(own)
    expect(fraas).toContain('FR')
  })
})

describe('checkCollisions', () => {
  it('reports duplicates with their counts', () => {
    const dupes = checkCollisions(['A-B-C-D', 'A-B-C-D', 'X-Y-Z-W'])
    expect(dupes).toEqual([{ sku: 'A-B-C-D', count: 2 }])
  })

  it('reports nothing when every sku is unique', () => {
    expect(checkCollisions(['A-1', 'B-2', 'C-3'])).toEqual([])
  })
})

describe('abbreviation', () => {
  it('distinguishes names that share a prefix', () => {
    // "Standard Scarves | Stripes" and "Standard Scarves | Single Color" both
    // begin the same way. A naive first-three-letters abbreviation collapses
    // them, and the collision only surfaces after both are written to Square.
    const stripes = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    const single = tillSku('Scarves', 'Standard Scarves | Single Color', 'Blue', 'Regular')
    expect(stripes).not.toBe(single)
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

Abbreviation rules, all deterministic:
- Category to 3 characters from a fixed lookup: `Scarves→SCF`, `Mittens→MIT`, `Footwear→FTW`, `Headwear→HDW`, `Toys→TOY`, `Garments→GAR`, `Miscellaneous→MSC`, `Supplies→SUP`
- Group: take the segment after `|` if present, else the whole name; strip non-alphanumerics; uppercase; first 3 characters, extended to 4 or 5 only as needed to break a tie within the same category
- Colour and size: same treatment, 3 and 1 to 2 characters
- Brand: `FRAAS` inserts an `FR` segment after the category; `OWN` inserts nothing

Determinism matters more than elegance. These codes go into Square and become the join key between two systems, so the same inputs must produce the same SKU forever.

- [ ] **Step 3: Generate against the real catalog and prove zero collisions**

`generate-skus.ts` fills `Variation.tillSku` and `WarehouseVariant.warehouseSku`, runs `checkCollisions` over each level independently, and **exits non-zero if either level has any collision**, printing the offenders. Supplies get SKUs with `isSaleItem` false.

Report: counts generated at each level, and explicit confirmation of zero collisions at both. A collision here is a hard stop, not a warning.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(api): two-level SKU generation with collision checks"
```

---

### Task 5: Square join and catalog restructure scripts

Map warehouse groups to Square items, then build the plan/apply/verify cycle that will eventually run against production.

**Files:**
- Create: `apps/api/src/catalog/square-join.ts`
- Create: `apps/api/src/catalog/catalog-plan.ts`
- Create: `apps/api/src/cli/{join-square.ts,catalog-plan.ts,catalog-apply.ts,catalog-verify.ts}`
- Create: `apps/api/test/square-join.spec.ts`
- Create: `apps/api/test/fixtures/square-catalog-sample.csv`

**Interfaces:**
- Consumes: `ItemGroup` rows from Task 2, SKUs from Task 4
- Produces:
  - `type JoinCandidate = { sortlyGroup: string; squareItemName: string; score: number; reason: string }`
  - `proposeJoins(sortlyGroups: string[], squareItems: string[]): { matched: JoinCandidate[]; unmatchedSortly: string[]; unmatchedSquare: string[] }`
  - `pnpm --filter @winterborn/api cli:join-square`, `cli:catalog-plan`, `cli:catalog-apply`, `cli:catalog-verify`

**Read `docs/superpowers/decisions/2026-08-19-flat-item-migration.md` before writing the apply command.** It is the authority on migration behaviour, proven against sandbox in Plan 1. Two of its conclusions bind this task:

1. **Preserve and relabel.** Read-modify-write the existing item, keep `item_id`, never delete the original variation. Rename it to `Unspecified (pre-2026)` and mark it unsellable. Renaming it to a colour instead would preserve history *and silently relabel every past sale as that colour*, which is worse than orphaning because it looks correct.
2. **New variations come out with no `locationOverrides` at all.** Absent, not empty. On the real catalog that means every customer-facing variation would sell at flat price across all 14 markets while the Carmel premium sits inert on a row nobody can buy. **The apply command must reapply overrides explicitly, and verify must fail the run if they are missing.** The wire shape is an array of `{ locationId, priceMoney: { amount: bigint, currency }, pricingType: 'FIXED_PRICING' }`.

The join is genuinely hard because the names do not match: `Standard Scarves | Stripes` against `Scarf (Stripes)`, `Flip Mitts (Glittens)` against `Mittens (Flip Mitts)`. And `Stuffies` bakes size into the style string (`Alpaca (Large)`, `Bear (Medium)`) while Square splits Large/Medium/Small as variations, so it is not a clean join at all.

- [ ] **Step 1: Write the failing join test**

Build `apps/api/test/fixtures/square-catalog-sample.csv` by hand from the real header, with about 8 rows reproducing the real shapes: a flat Scarves item, a style-variation Mittens item, a size-variation Socks item, an archived row, a row enabled at zero locations, and a `[Fraas]` row.

`apps/api/test/square-join.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { proposeJoins } from '../src/catalog/square-join.js'

describe('proposeJoins', () => {
  it('matches across the naming convention gap', () => {
    // Warehouse and till name the same product differently. Exact matching
    // finds almost nothing.
    const { matched } = proposeJoins(
      ['Standard Scarves | Stripes', 'Flip Mitts (Glittens)'],
      ['Scarf (Stripes)', 'Mittens (Flip Mitts)'],
    )
    const stripes = matched.find((m) => m.sortlyGroup === 'Standard Scarves | Stripes')
    expect(stripes?.squareItemName).toBe('Scarf (Stripes)')
    const mitts = matched.find((m) => m.sortlyGroup === 'Flip Mitts (Glittens)')
    expect(mitts?.squareItemName).toBe('Mittens (Flip Mitts)')
  })

  it('does not force a match when nothing is close', () => {
    // A wrong join silently sends the wrong stock to the wrong market. An
    // honest unmatched entry is worth more than a confident bad guess.
    const { matched, unmatchedSortly } = proposeJoins(['Dryer Balls'], ['Scarf (Stripes)'])
    expect(matched).toHaveLength(0)
    expect(unmatchedSortly).toContain('Dryer Balls')
  })

  it('reports both sides of the gap', () => {
    const r = proposeJoins(['Only In Sortly'], ['Only In Square'])
    expect(r.unmatchedSortly).toEqual(['Only In Sortly'])
    expect(r.unmatchedSquare).toEqual(['Only In Square'])
  })

  it('gives every match a reason a human can check', () => {
    const { matched } = proposeJoins(['Standard Scarves | Plaids'], ['Scarf (Plaids)'])
    expect(matched[0]?.reason.length).toBeGreaterThan(0)
    expect(matched[0]?.score).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

Score on normalised token overlap: lowercase, strip punctuation and bracketed qualifiers, drop the segment before `|`, then compare token sets with a similarity measure. Accept above a threshold; below it, report unmatched. Every match carries a human-readable `reason`.

**Do not auto-apply the join.** `join-square.ts` writes a reviewable report and persists `ItemGroup.squareItemId` only for matches above the threshold, listing the rest for manual resolution.

- [ ] **Step 3: Run the join against the real data**

```bash
pnpm --filter @winterborn/api cli:join-square
```

Inputs: 50 Sortly groups against 46 active Square items from `data/catalog-item-library-export.csv`.

Report every one of: matched with scores, unmatched on each side, and any Sortly group matching more than one Square item. **Expect a meaningful unmatched set.** Sortly splits Sport Socks into twelve pattern groups where Square has one item, so a clean bijection does not exist and a join claiming one is wrong.

- [ ] **Step 4: Build plan, apply and verify**

Three commands, sharing `catalog-plan.ts`:

- **`catalog-plan --category Scarves`** — computes intended Square writes and prints a full diff: items touched, variations added, the legacy variation's relabel, SKUs, and per-location overrides to reapply. **Mutates nothing.** Writes the plan to a file the apply step consumes, so what was reviewed is what runs.
- **`catalog-apply --plan <file>`** — executes it. Read-modify-write per item. Idempotent, resumable, and it records what it did. Every Square call passes through the errors check established in Plan 1.
- **`catalog-verify --plan <file>`** — re-reads from Square and asserts: `item_id` unchanged, the legacy variation still present and unsellable, historical order lines still resolving, `present_at_location_ids` intact, and **every override in the plan present on the new variations**. Exit non-zero on any failure.

Run all three against **sandbox** on a seeded flat item. The production run is not part of this plan.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm build && pnpm test
```

```bash
git add -A
git commit -m "feat(api): Square join and catalog plan/apply/verify commands"
```

---

## Definition of Done

`pnpm typecheck && pnpm build && pnpm test` passes from the repo root, and:

1. The three carry-forward items from Plan 2 are closed: ledger foreign keys, variant-level replay check, widened sole-writer guard.
2. The real Sortly export imports to the expected totals, and re-importing creates nothing.
3. All 248 colour values are either assigned to a family or listed in a residual queue, with the residual roughly the measured 40 rather than zero.
4. The 559 photos are archived locally, before the client's Sortly subscription lapses.
5. Both SKU levels are generated with zero collisions at each level.
6. The Square join reports matches with scores and both unmatched sets, forcing nothing.
7. `catalog-plan`, `catalog-apply` and `catalog-verify` run end to end against sandbox, and verify fails the run if per-location overrides are missing from new variations.

Point 7 is the one that matters. It is the difference between a migration that preserves pricing at 14 markets and one that silently flattens it.
