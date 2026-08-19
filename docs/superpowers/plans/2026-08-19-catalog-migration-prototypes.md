# Catalog Migration Prototypes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove which Square Catalog API sequence converts a flat item into a variation-structured item without orphaning its sales history, and decide how two-dimension items (size × pattern) are restructured.

**Architecture:** A throwaway `prototypes/` workspace, separate from the production monorepo, running Vitest tests against a live Square **sandbox** merchant. Each test seeds its own catalog objects and orders with a unique run ID, performs a candidate migration, then asserts against the Orders and Catalog APIs that historical line items still resolve. Findings are written to a decision record that Plan 3 consumes.

**Tech Stack:** TypeScript, tsx, Vitest, `square` Node SDK, Square Sandbox.

**Spec:** `docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md` — especially §8.1 (verified catalog state), §8.2 (the trap), §8.3 (mandatory protocol), §8.6 (two-dimension items).

## Global Constraints

- **Sandbox only.** `SQUARE_ENV` must be `sandbox` for every task in this plan. No task here touches production, and no task uses Joel's token.
- **This code is throwaway.** Its output is an answer, not a library. Production catalog scripts are written fresh in Plan 3 from the decision record.
- **Every run is isolated.** All created catalog objects carry a `RUN_ID` suffix so repeated runs never collide and never depend on prior state.
- **Assert programmatically, not visually.** Verification uses the Orders and Catalog APIs. The sandbox Dashboard is for eyeballing only, never for a pass/fail claim.
- **Preserve-and-relabel is the leading hypothesis** (§8.3): add variations to the existing item object, keep `item_id`, and never delete the original variation. Tasks 4–6 test it against the alternatives rather than assuming it.
- **Check `res.errors` after every Square call.** The SDK surfaces API-level
  failures in the response body without throwing. `client.ts` exports
  `assertNoErrors(res, context)` for this; every Square call in every task
  passes its response through it. A silently-errored response that reads as an
  empty result is the worst failure mode available to this plan, because
  "the catalog object is absent" is the exact signal Task 4 measures.
- Node 20+. pnpm.

---

### Task 1: Prototype harness and sandbox connectivity

Establishes the workspace and — critically — **pins the SDK version and confirms its client shape** before any later task depends on it. The `square` package restructured its export surface across major versions; every later task in this plan is written against what this task prints, so run it first and adjust the import in `client.ts` if it reports something different.

**Files:**
- Create: `prototypes/package.json`
- Create: `prototypes/tsconfig.json`
- Create: `prototypes/vitest.config.ts`
- Create: `prototypes/src/client.ts`
- Test: `prototypes/src/connectivity.test.ts`

**Interfaces:**
- Consumes: `.env` at repo root (`SQUARE_ENV`, `SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`)
- Produces:
  - `square` — a configured SDK client instance
  - `RUN_ID: string` — a per-process unique suffix, format `p<epoch-ms base36>`
  - `assertSandbox(): void` — throws unless `SQUARE_ENV === 'sandbox'`
  - `mainLocationId(): Promise<string>` — the sandbox merchant's first location ID

- [ ] **Step 1: Create the workspace files**

`prototypes/package.json`:

```json
{
  "name": "winterborn-prototypes",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "square": "^43.0.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`prototypes/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`prototypes/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Live sandbox calls are slow; these are integration tests, not units.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sandbox is shared mutable state. Never run these files in parallel.
    fileParallelism: false,
  },
})
```

- [ ] **Step 2: Write the client module**

`prototypes/src/client.ts`:

```typescript
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import dotenv from 'dotenv'
import { SquareClient, SquareEnvironment } from 'square'

// .env lives at the repo root, but vitest runs with cwd = prototypes/.
// Resolve explicitly rather than relying on the working directory.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

export function assertSandbox(): void {
  if (process.env.SQUARE_ENV !== 'sandbox') {
    throw new Error(
      `Refusing to run: SQUARE_ENV is "${process.env.SQUARE_ENV}", expected "sandbox". ` +
        `These prototypes must never touch production.`,
    )
  }
  const appId = process.env.SQUARE_APPLICATION_ID ?? ''
  if (!appId.startsWith('sandbox-')) {
    throw new Error(
      `Refusing to run: SQUARE_APPLICATION_ID does not start with "sandbox-". ` +
        `Got "${appId.slice(0, 12)}...". Check the environment toggle in the Developer Console.`,
    )
  }
}

assertSandbox()

export const square = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN!,
  environment: SquareEnvironment.Sandbox,
})

/** Unique per process, so repeated runs never collide in the shared sandbox. */
export const RUN_ID = `p${Date.now().toString(36)}`

let cachedLocationId: string | undefined

export async function mainLocationId(): Promise<string> {
  if (cachedLocationId) return cachedLocationId
  const res = await square.locations.list()
  const id = res.locations?.[0]?.id
  if (!id) throw new Error('Sandbox merchant has no locations')
  cachedLocationId = id
  return id
}
```

- [ ] **Step 3: Write the failing connectivity test**

`prototypes/src/connectivity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { square, mainLocationId, RUN_ID } from './client.js'

describe('sandbox connectivity', () => {
  it('refuses to run outside sandbox', () => {
    expect(process.env.SQUARE_ENV).toBe('sandbox')
    expect(process.env.SQUARE_APPLICATION_ID).toMatch(/^sandbox-/)
  })

  it('lists at least one location', async () => {
    const id = await mainLocationId()
    expect(id).toBeTruthy()
    console.log('[harness] location id:', id)
    console.log('[harness] RUN_ID:', RUN_ID)
  })

  it('can read the catalog', async () => {
    const res = await square.catalog.list({ types: 'ITEM' })
    const count = res.data?.length ?? 0
    console.log('[harness] existing sandbox ITEM count:', count)
    expect(count).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 4: Install and run**

```bash
cd prototypes && pnpm install && pnpm test
```

Expected: all three pass. The console lines print the location ID, the run ID, and the sandbox item count.

**If the `square` import fails**, the installed SDK exposes a different surface. Run `node -e "console.log(Object.keys(require('square')))"` and adjust the two imports in `client.ts` to match. Do not proceed until this task's tests pass — every later task imports from here.

- [ ] **Step 5: Commit**

```bash
git add prototypes/
git commit -m "chore(prototypes): sandbox harness with environment guard"
```

---

### Task 2: Seed a flat item with sales history

Recreates the real shape from spec §8.1: a Scarves-pattern item with exactly one `Regular` variation and a single price point, then puts orders through it so there is history to preserve.

Sandbox cannot backdate orders — everything is created at "now". That is fine: the question is whether historical line items still **resolve** after a restructure, not how old they are.

**Files:**
- Create: `prototypes/src/seed.ts`
- Test: `prototypes/src/seed.test.ts`

**Interfaces:**
- Consumes: `square`, `RUN_ID`, `mainLocationId` from `./client.js`
- Produces:
  - `type SeededItem = { itemId: string; variationIds: string[]; orderIds: string[] }`
  - `seedFlatItem(name: string, priceCents: number, orderCount: number): Promise<SeededItem>`
  - `seedSizeItem(name: string, sizes: string[], priceCents: number, ordersPerSize: number): Promise<SeededItem>`

- [ ] **Step 1: Write the failing test**

`prototypes/src/seed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seedFlatItem } from './seed.js'

describe('seedFlatItem', () => {
  it('creates a flat item with one variation and orders against it', async () => {
    const seeded = await seedFlatItem('Proto Flat Scarf', 6500, 3)

    expect(seeded.itemId).toBeTruthy()
    expect(seeded.variationIds).toHaveLength(1)
    expect(seeded.orderIds).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd prototypes && pnpm vitest run src/seed.test.ts
```

Expected: FAIL — cannot resolve `./seed.js`.

- [ ] **Step 3: Implement the seeder**

`prototypes/src/seed.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { square, RUN_ID, mainLocationId } from './client.js'

export type SeededItem = {
  itemId: string
  variationIds: string[]
  orderIds: string[]
}

/** Creates an item whose variations are exactly `variationNames`, returns real IDs. */
async function createItem(
  name: string,
  variationNames: string[],
  priceCents: number,
): Promise<{ itemId: string; variationIds: string[] }> {
  const tempItemId = `#item_${RUN_ID}`
  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      type: 'ITEM',
      id: tempItemId,
      itemData: {
        name: `${name} ${RUN_ID}`,
        variations: variationNames.map((vn, i) => ({
          type: 'ITEM_VARIATION',
          id: `#var_${RUN_ID}_${i}`,
          itemVariationData: {
            itemId: tempItemId,
            name: vn,
            pricingType: 'FIXED_PRICING',
            priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
          },
        })),
      },
    },
  })

  const item = res.catalogObject
  if (!item?.id) throw new Error('Item creation returned no id')
  const variationIds = (item.itemData?.variations ?? [])
    .map((v) => v.id!)
    .filter(Boolean)
  if (variationIds.length !== variationNames.length) {
    throw new Error(
      `Expected ${variationNames.length} variations, got ${variationIds.length}`,
    )
  }
  return { itemId: item.id, variationIds }
}

/** Places one paid order per call against a specific variation. */
async function placeOrder(variationId: string, quantity: number): Promise<string> {
  const locationId = await mainLocationId()
  const res = await square.orders.create({
    idempotencyKey: randomUUID(),
    order: {
      locationId,
      lineItems: [{ catalogObjectId: variationId, quantity: String(quantity) }],
      state: 'COMPLETED',
    },
  })
  const id = res.order?.id
  if (!id) throw new Error('Order creation returned no id')
  return id
}

export async function seedFlatItem(
  name: string,
  priceCents: number,
  orderCount: number,
): Promise<SeededItem> {
  const { itemId, variationIds } = await createItem(name, ['Regular'], priceCents)
  const orderIds: string[] = []
  for (let i = 0; i < orderCount; i++) {
    orderIds.push(await placeOrder(variationIds[0], i + 1))
  }
  return { itemId, variationIds, orderIds }
}

export async function seedSizeItem(
  name: string,
  sizes: string[],
  priceCents: number,
  ordersPerSize: number,
): Promise<SeededItem> {
  const { itemId, variationIds } = await createItem(name, sizes, priceCents)
  const orderIds: string[] = []
  for (const variationId of variationIds) {
    for (let i = 0; i < ordersPerSize; i++) {
      orderIds.push(await placeOrder(variationId, 1))
    }
  }
  return { itemId, variationIds, orderIds }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd prototypes && pnpm vitest run src/seed.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prototypes/src/seed.ts prototypes/src/seed.test.ts
git commit -m "feat(prototypes): seed flat and size-variation items with order history"
```

---

### Task 3: History verification helpers

The assertions every migration test depends on. Written and proven **before** any migration runs, so a later failure is unambiguously the migration's fault and not the checker's.

**Files:**
- Create: `prototypes/src/verify.ts`
- Test: `prototypes/src/verify.test.ts`

**Interfaces:**
- Consumes: `square`, `mainLocationId` from `./client.js`; `seedFlatItem` from `./seed.js`
- Produces:
  - `type LineRef = { orderId: string; catalogObjectId: string | undefined; name: string | undefined; quantity: string }`
  - `readOrderLines(orderIds: string[]): Promise<LineRef[]>`
  - `catalogObjectExists(id: string): Promise<boolean>`
  - `resolveVariationToItem(variationId: string): Promise<string | undefined>`
  - `itemVariationNames(itemId: string): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

`prototypes/src/verify.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seedFlatItem } from './seed.js'
import {
  readOrderLines,
  catalogObjectExists,
  resolveVariationToItem,
  itemVariationNames,
} from './verify.js'

describe('verification helpers', () => {
  it('resolves seeded orders back to their catalog objects', async () => {
    const s = await seedFlatItem('Proto Verify Scarf', 6500, 2)

    const lines = await readOrderLines(s.orderIds)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.catalogObjectId).toBe(s.variationIds[0])
    }

    expect(await catalogObjectExists(s.variationIds[0])).toBe(true)
    expect(await resolveVariationToItem(s.variationIds[0])).toBe(s.itemId)
    expect(await itemVariationNames(s.itemId)).toEqual(['Regular'])
  })

  it('reports a non-existent catalog object as absent', async () => {
    expect(await catalogObjectExists('DOES_NOT_EXIST_XXXXXXXX')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd prototypes && pnpm vitest run src/verify.test.ts
```

Expected: FAIL — cannot resolve `./verify.js`.

- [ ] **Step 3: Implement the helpers**

`prototypes/src/verify.ts`:

```typescript
import { square } from './client.js'

export type LineRef = {
  orderId: string
  catalogObjectId: string | undefined
  name: string | undefined
  quantity: string
}

export async function readOrderLines(orderIds: string[]): Promise<LineRef[]> {
  const out: LineRef[] = []
  for (const orderId of orderIds) {
    const res = await square.orders.get({ orderId })
    for (const li of res.order?.lineItems ?? []) {
      out.push({
        orderId,
        catalogObjectId: li.catalogObjectId,
        name: li.name,
        quantity: li.quantity,
      })
    }
  }
  return out
}

export async function catalogObjectExists(id: string): Promise<boolean> {
  try {
    const res = await square.catalog.object.get({ objectId: id })
    return Boolean(res.object?.id)
  } catch {
    return false
  }
}

export async function resolveVariationToItem(
  variationId: string,
): Promise<string | undefined> {
  try {
    const res = await square.catalog.object.get({ objectId: variationId })
    return res.object?.itemVariationData?.itemId
  } catch {
    return undefined
  }
}

export async function itemVariationNames(itemId: string): Promise<string[]> {
  const res = await square.catalog.object.get({ objectId: itemId })
  return (res.object?.itemData?.variations ?? [])
    .map((v) => v.itemVariationData?.name ?? '')
    .filter(Boolean)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd prototypes && pnpm vitest run src/verify.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prototypes/src/verify.ts prototypes/src/verify.test.ts
git commit -m "feat(prototypes): catalog and order history verification helpers"
```

---

### Task 4: Prototype A — preserve-and-relabel migration

The leading hypothesis from §8.3. Converts a flat item to colour variations by **adding** to the existing item object, keeping `item_id`, and never deleting the original `Regular` variation — instead renaming it to an honest label and disabling it for sale.

Renaming rather than deleting matters for a reason that is easy to miss: the original variation carries every historical sale. Delete it and those lines orphan. Rename it to a colour and every historical sale is silently mislabelled as that colour, which is worse than orphaning because it looks correct. `Unspecified (pre-2026)` keeps the history attached and honestly labelled.

**Files:**
- Create: `prototypes/src/migrate-a.ts`
- Test: `prototypes/src/migrate-a.test.ts`

**Interfaces:**
- Consumes: `square` from `./client.js`; helpers from `./verify.js`; `seedFlatItem` from `./seed.js`
- Produces: `migrateFlatToVariations(itemId: string, colourNames: string[], priceCents: number, legacyLabel?: string): Promise<{ itemId: string; newVariationIds: string[]; legacyVariationId: string }>`

- [ ] **Step 1: Write the failing test**

`prototypes/src/migrate-a.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seedFlatItem } from './seed.js'
import { migrateFlatToVariations } from './migrate-a.js'
import {
  readOrderLines,
  catalogObjectExists,
  resolveVariationToItem,
  itemVariationNames,
} from './verify.js'

describe('Prototype A: flat item to colour variations', () => {
  it('preserves item_id, keeps history resolvable, and adds colour variations', async () => {
    const seeded = await seedFlatItem('Proto A Scarf', 6500, 3)
    const originalVariationId = seeded.variationIds[0]

    const before = await readOrderLines(seeded.orderIds)
    expect(before).toHaveLength(3)

    const result = await migrateFlatToVariations(
      seeded.itemId,
      ['Blue', 'Green', 'Multi'],
      6500,
    )

    // 1. item_id is unchanged
    expect(result.itemId).toBe(seeded.itemId)

    // 2. the original variation still exists and still belongs to the same item
    expect(result.legacyVariationId).toBe(originalVariationId)
    expect(await catalogObjectExists(originalVariationId)).toBe(true)
    expect(await resolveVariationToItem(originalVariationId)).toBe(seeded.itemId)

    // 3. historical order lines still point at a live catalog object
    const after = await readOrderLines(seeded.orderIds)
    expect(after).toHaveLength(3)
    for (const line of after) {
      expect(line.catalogObjectId).toBe(originalVariationId)
      expect(await catalogObjectExists(line.catalogObjectId!)).toBe(true)
    }

    // 4. the item now carries the colour variations plus the relabelled legacy one
    const names = await itemVariationNames(result.itemId)
    expect(names).toContain('Blue')
    expect(names).toContain('Green')
    expect(names).toContain('Multi')
    expect(names).toContain('Unspecified (pre-2026)')
    expect(names).not.toContain('Regular')
    expect(result.newVariationIds).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd prototypes && pnpm vitest run src/migrate-a.test.ts
```

Expected: FAIL — cannot resolve `./migrate-a.js`.

- [ ] **Step 3: Implement the migration**

`prototypes/src/migrate-a.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { square, RUN_ID } from './client.js'

export async function migrateFlatToVariations(
  itemId: string,
  colourNames: string[],
  priceCents: number,
  legacyLabel = 'Unspecified (pre-2026)',
): Promise<{ itemId: string; newVariationIds: string[]; legacyVariationId: string }> {
  // Read-modify-write. Never construct the item from scratch: unread fields
  // (location overrides, present_at_location_ids) would be silently dropped.
  const current = await square.catalog.object.get({ objectId: itemId })
  const item = current.object
  if (!item?.itemData) throw new Error(`Item ${itemId} not found or has no itemData`)

  const existing = item.itemData.variations ?? []
  if (existing.length !== 1) {
    throw new Error(
      `Expected exactly 1 existing variation on a flat item, found ${existing.length}`,
    )
  }
  const legacy = existing[0]
  const legacyVariationId = legacy.id!

  // Relabel the legacy variation and take it out of sale. Do NOT delete it:
  // it holds every historical order line for this item.
  const relabelledLegacy = {
    ...legacy,
    itemVariationData: {
      ...legacy.itemVariationData,
      name: legacyLabel,
      sellable: false,
      stockable: true,
    },
  }

  const newVariations = colourNames.map((name, i) => ({
    type: 'ITEM_VARIATION' as const,
    id: `#new_${RUN_ID}_${i}`,
    itemVariationData: {
      itemId,
      name,
      pricingType: 'FIXED_PRICING' as const,
      priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
      sellable: true,
      stockable: true,
    },
  }))

  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      ...item,
      itemData: {
        ...item.itemData,
        variations: [relabelledLegacy, ...newVariations],
      },
    },
  })

  const saved = res.catalogObject
  if (!saved?.id) throw new Error('Upsert returned no object')

  const newVariationIds = (saved.itemData?.variations ?? [])
    .filter((v) => v.id !== legacyVariationId)
    .map((v) => v.id!)

  return { itemId: saved.id, newVariationIds, legacyVariationId }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd prototypes && pnpm vitest run src/migrate-a.test.ts
```

Expected: PASS.

**If assertion 3 fails** — historical lines no longer resolve — that is the single most important finding in this plan. Stop, record the exact failure in the decision record (Task 7), and do not proceed to Plan 3.

- [ ] **Step 5: Commit**

```bash
git add prototypes/src/migrate-a.ts prototypes/src/migrate-a.test.ts
git commit -m "feat(prototypes): prototype A, preserve-and-relabel flat item migration"
```

---

### Task 5: Prototype A — location overrides and availability survive

Spec §7.3 makes this the highest-consequence rule in the integration: **47 of 85 active rows carry a per-location price override**, up to $750 → $800 on `Cape (100% Baby Alpaca)`. A migration that flattens those breaks pricing at 14 markets silently.

The sandbox merchant may have only one location. If so, this task creates a second one so overrides are genuinely testable rather than vacuously passing.

**Files:**
- Create: `prototypes/src/locations.ts`
- Test: `prototypes/src/overrides.test.ts`

**Interfaces:**
- Consumes: `square`, `RUN_ID`, `mainLocationId` from `./client.js`; `migrateFlatToVariations` from `./migrate-a.js`; `seedFlatItem` from `./seed.js`
- Produces:
  - `ensureSecondLocation(): Promise<string>`
  - `setVariationOverride(variationId: string, locationId: string, priceCents: number): Promise<void>`
  - `getVariationOverrides(variationId: string): Promise<Record<string, number>>`

- [ ] **Step 1: Write the failing test**

`prototypes/src/overrides.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seedFlatItem } from './seed.js'
import { migrateFlatToVariations } from './migrate-a.js'
import {
  ensureSecondLocation,
  setVariationOverride,
  getVariationOverrides,
} from './locations.js'

describe('Prototype A: per-location price overrides survive migration', () => {
  it('keeps the override on the legacy variation after restructure', async () => {
    const secondLocation = await ensureSecondLocation()
    const seeded = await seedFlatItem('Proto Override Cape', 16500, 1)
    const variationId = seeded.variationIds[0]

    // Mirror the real Carmel premium: base 165.00, Carmel 177.00
    await setVariationOverride(variationId, secondLocation, 17700)

    const before = await getVariationOverrides(variationId)
    expect(before[secondLocation]).toBe(17700)

    await migrateFlatToVariations(seeded.itemId, ['Gray', 'Multi'], 16500)

    const after = await getVariationOverrides(variationId)
    expect(after[secondLocation]).toBe(17700)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd prototypes && pnpm vitest run src/overrides.test.ts
```

Expected: FAIL — cannot resolve `./locations.js`.

- [ ] **Step 3: Implement the location helpers**

`prototypes/src/locations.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { square, RUN_ID } from './client.js'

export async function ensureSecondLocation(): Promise<string> {
  const existing = await square.locations.list()
  const locations = existing.locations ?? []
  if (locations.length >= 2) return locations[1].id!

  const created = await square.locations.create({
    location: {
      name: `Proto Second Location ${RUN_ID}`,
      address: {
        addressLine1: '1 Test Street',
        locality: 'Denver',
        administrativeDistrictLevel1: 'CO',
        postalCode: '80202',
        country: 'US',
      },
    },
  })
  const id = created.location?.id
  if (!id) throw new Error('Failed to create a second sandbox location')
  return id
}

export async function setVariationOverride(
  variationId: string,
  locationId: string,
  priceCents: number,
): Promise<void> {
  const current = await square.catalog.object.get({ objectId: variationId })
  const variation = current.object
  if (!variation?.itemVariationData) {
    throw new Error(`Variation ${variationId} not found`)
  }

  const existing = variation.itemVariationData.locationOverrides ?? []
  const others = existing.filter((o) => o.locationId !== locationId)

  await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      ...variation,
      itemVariationData: {
        ...variation.itemVariationData,
        locationOverrides: [
          ...others,
          {
            locationId,
            priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
            pricingType: 'FIXED_PRICING',
          },
        ],
      },
    },
  })
}

export async function getVariationOverrides(
  variationId: string,
): Promise<Record<string, number>> {
  const res = await square.catalog.object.get({ objectId: variationId })
  const overrides = res.object?.itemVariationData?.locationOverrides ?? []
  const out: Record<string, number> = {}
  for (const o of overrides) {
    if (o.locationId && o.priceMoney?.amount !== undefined) {
      out[o.locationId] = Number(o.priceMoney.amount)
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd prototypes && pnpm vitest run src/overrides.test.ts
```

Expected: PASS.

**If this fails**, the production catalog scripts in Plan 3 must read every variation's overrides before writing and restore them explicitly after. Record exactly which fields were lost.

- [ ] **Step 5: Commit**

```bash
git add prototypes/src/locations.ts prototypes/src/overrides.test.ts
git commit -m "test(prototypes): prove per-location price overrides survive migration"
```

---

### Task 6: Prototype B — two-dimension items

Settles spec §8.6. The Sortly data showed Footwear is organised by **pattern**, not colour, and that Square collapses twelve warehouse pattern groups into one `Socks (Sport)` item with four sizes. The spec's proposed resolution is **item-per-pattern**, following the precedent Scarves already sets in Square.

This task compares that against the alternative — piling pattern and size into one item's variation list — and measures the thing that actually decides it: how many entries a cashier has to scan past.

**Files:**
- Create: `prototypes/src/migrate-b.ts`
- Test: `prototypes/src/migrate-b.test.ts`

**Interfaces:**
- Consumes: `square`, `RUN_ID` from `./client.js`; `seedSizeItem` from `./seed.js`; helpers from `./verify.js`
- Produces:
  - `type PatternItemResult = { createdItemIds: string[]; entriesPerItem: number }`
  - `createItemPerPattern(baseName: string, patterns: string[], sizes: string[], priceCents: number): Promise<PatternItemResult>`
  - `expandInPlace(itemId: string, patterns: string[], sizes: string[], priceCents: number): Promise<{ itemId: string; entryCount: number }>`

- [ ] **Step 1: Write the failing test**

`prototypes/src/migrate-b.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { seedSizeItem } from './seed.js'
import { createItemPerPattern, expandInPlace } from './migrate-b.js'
import { readOrderLines, catalogObjectExists, itemVariationNames } from './verify.js'

const PATTERNS = ['Nordic Stripe', 'Snowflake', 'Floral', 'Geometric']
const SIZES = ['Small', 'Medium', 'Large', 'XL']

describe('Prototype B: two-dimension items', () => {
  it('item-per-pattern keeps each till list to the size count', async () => {
    const result = await createItemPerPattern('Proto Sport Sock', PATTERNS, SIZES, 3500)

    expect(result.createdItemIds).toHaveLength(PATTERNS.length)
    expect(result.entriesPerItem).toBe(SIZES.length)
    // Spec §8.6 binding rule: selectable entries per item must be <= 16
    expect(result.entriesPerItem).toBeLessThanOrEqual(16)

    for (const id of result.createdItemIds) {
      expect(await itemVariationNames(id)).toEqual(SIZES)
    }
  })

  it('expanding in place preserves history but breaches the entry ceiling', async () => {
    const seeded = await seedSizeItem('Proto Sock Inplace', SIZES, 3500, 1)
    const before = await readOrderLines(seeded.orderIds)
    expect(before).toHaveLength(SIZES.length)

    const result = await expandInPlace(seeded.itemId, PATTERNS, SIZES, 3500)

    // History survives, because existing variations are never removed.
    const after = await readOrderLines(seeded.orderIds)
    expect(after).toHaveLength(SIZES.length)
    for (const line of after) {
      expect(await catalogObjectExists(line.catalogObjectId!)).toBe(true)
    }

    // But the till list is now pattern x size plus the originals.
    expect(result.entryCount).toBe(PATTERNS.length * SIZES.length + SIZES.length)
    expect(result.entryCount).toBeGreaterThan(16)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd prototypes && pnpm vitest run src/migrate-b.test.ts
```

Expected: FAIL — cannot resolve `./migrate-b.js`.

- [ ] **Step 3: Implement both approaches**

`prototypes/src/migrate-b.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { square, RUN_ID } from './client.js'

export type PatternItemResult = {
  createdItemIds: string[]
  entriesPerItem: number
}

/** Approach 1 (spec §8.6 recommendation): one Square item per warehouse pattern. */
export async function createItemPerPattern(
  baseName: string,
  patterns: string[],
  sizes: string[],
  priceCents: number,
): Promise<PatternItemResult> {
  const createdItemIds: string[] = []

  for (let p = 0; p < patterns.length; p++) {
    const tempItemId = `#pat_${RUN_ID}_${p}`
    const res = await square.catalog.object.upsert({
      idempotencyKey: randomUUID(),
      object: {
        type: 'ITEM',
        id: tempItemId,
        itemData: {
          name: `${baseName} - ${patterns[p]} ${RUN_ID}`,
          variations: sizes.map((size, i) => ({
            type: 'ITEM_VARIATION' as const,
            id: `#pat_${RUN_ID}_${p}_${i}`,
            itemVariationData: {
              itemId: tempItemId,
              name: size,
              pricingType: 'FIXED_PRICING' as const,
              priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
            },
          })),
        },
      },
    })
    const id = res.catalogObject?.id
    if (!id) throw new Error(`Failed to create pattern item ${patterns[p]}`)
    createdItemIds.push(id)
  }

  return { createdItemIds, entriesPerItem: sizes.length }
}

/** Approach 2 (the alternative): pattern x size concatenated onto one item. */
export async function expandInPlace(
  itemId: string,
  patterns: string[],
  sizes: string[],
  priceCents: number,
): Promise<{ itemId: string; entryCount: number }> {
  const current = await square.catalog.object.get({ objectId: itemId })
  const item = current.object
  if (!item?.itemData) throw new Error(`Item ${itemId} not found`)

  const existing = item.itemData.variations ?? []

  const added = patterns.flatMap((pattern, p) =>
    sizes.map((size, s) => ({
      type: 'ITEM_VARIATION' as const,
      id: `#exp_${RUN_ID}_${p}_${s}`,
      itemVariationData: {
        itemId,
        name: `${pattern} / ${size}`,
        pricingType: 'FIXED_PRICING' as const,
        priceMoney: { amount: BigInt(priceCents), currency: 'USD' },
      },
    })),
  )

  const res = await square.catalog.object.upsert({
    idempotencyKey: randomUUID(),
    object: {
      ...item,
      itemData: { ...item.itemData, variations: [...existing, ...added] },
    },
  })

  const saved = res.catalogObject
  if (!saved?.id) throw new Error('Upsert returned no object')
  return {
    itemId: saved.id,
    entryCount: (saved.itemData?.variations ?? []).length,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd prototypes && pnpm vitest run src/migrate-b.test.ts
```

Expected: PASS. Both approaches work technically; the test's value is quantifying the till cost — 4 entries versus 20.

- [ ] **Step 5: Commit**

```bash
git add prototypes/src/migrate-b.ts prototypes/src/migrate-b.test.ts
git commit -m "test(prototypes): prototype B, item-per-pattern vs in-place expansion"
```

---

### Task 7: Write the decision record

The deliverable of this entire plan. Plan 3 reads this file, not the prototype code. Nothing here is optional prose — Plan 3's catalog scripts are written directly from the "Decisions" section.

**Files:**
- Create: `docs/superpowers/decisions/2026-08-19-flat-item-migration.md`
- Modify: `docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md` (§8.3 and §8.6 — replace "to be settled by Prototype B" language with the actual outcome)

**Interfaces:**
- Consumes: the passing test output from Tasks 4, 5 and 6
- Produces: a decision record with a **Decisions** section that Plan 3 implements verbatim

- [ ] **Step 1: Run the full prototype suite and capture output**

```bash
cd prototypes && pnpm test 2>&1 | tee /tmp/prototype-results.txt
```

Expected: all tests pass. Keep the output — the decision record quotes real results, not remembered ones.

- [ ] **Step 2: Write the decision record**

Create `docs/superpowers/decisions/2026-08-19-flat-item-migration.md` with exactly these sections:

```markdown
# Decision: flat-item migration and two-dimension restructure

**Date:** 2026-08-19
**Status:** Accepted
**Evidence:** `prototypes/` test suite, run against Square sandbox
**Implements the gate in:** spec §8.3

## Question

Does converting a flat Square item to a variation-structured item orphan its
sales history, and how should items that already carry a size dimension be
restructured?

## What was tested

[One line per test, naming the file and what it asserted.]

## Results

[Paste the actual vitest summary. State pass or fail per assertion, especially:
item_id preserved, historical line items still resolve, location overrides
survive, entries-per-item counts for both Prototype B approaches.]

## Decisions

1. **Flat to colour variations:** read-modify-write the existing ITEM object,
   preserving `item_id`. Never delete the original variation.
2. **The legacy variation is relabelled, not reused.** Rename it to
   `Unspecified (pre-2026)` and set `sellable: false`. Renaming it to a colour
   would silently mislabel every historical sale as that colour, which is worse
   than orphaning because it looks correct.
3. **Every catalog write is read-modify-write.** Constructing an item from
   scratch drops `locationOverrides` and `present_at_location_ids`.
4. **Two-dimension items:** [item-per-pattern | in-place expansion], based on
   the measured entries-per-item figures above.
5. **Entry ceiling:** selectable entries per item stays at or below 16.

## Consequences for Plan 3

[What the production catalog scripts must do, as a numbered list. Include any
API quirk discovered during the prototypes — undocumented required fields,
response shapes that differed from the docs, rate limits hit.]

## What is still unknown

[Anything the sandbox could not answer, and how it will be confirmed on the one
live low-volume item before the bulk run.]
```

- [ ] **Step 3: Update the spec to match the outcome**

In the spec, replace the forward-looking language with the decision:

- §8.3 step 4: replace "The API path is preferred because it is per-item, controlled and testable, but the prototype should prove it rather than assume it" with the proven path and a link to the decision record.
- §8.6: replace "Prototype B (§8.3) chooses between A and C" with the chosen approach and its measured entries-per-item figures.
- §13 item 10 (two-dimension decision): mark resolved, referencing the decision record.

- [ ] **Step 4: Verify no forward-looking language remains**

```bash
grep -n "Prototype B decides\|to be settled by\|should prove it rather than assume" \
  docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md
```

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/decisions/2026-08-19-flat-item-migration.md \
        docs/superpowers/specs/2026-08-19-winterborn-restock-system-design.md
git commit -m "docs: record flat-item migration decision and close the §8.3 gate"
```

---

## Gate

**Do not start Plan 3 until Task 7 is committed.**

Spec §8.3 makes this a blocker: nothing in catalog work proceeds without sign-off on the prototype. If Task 4's assertion 3 failed — historical line items no longer resolving — the decision record says so, and the correct next move is to design a different migration approach, not to proceed with a known-broken one.

The one live low-volume item test (§8.3 step 5) happens at the start of Plan 3, once Joel's production token exists. `Socks (Tech)` is the recommended subject: three sizes, currently enabled at zero locations, so a mistake costs nothing.
