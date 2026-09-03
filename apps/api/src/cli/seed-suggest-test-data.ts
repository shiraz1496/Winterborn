import './load-env.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'

/**
 * All-in-one seed for testing the /requests/suggest engine end-to-end.
 * Sets up the four data conditions the engine has branches for:
 *
 *   1. RICH markets      → dense per-colour SALEs (+ DISPATCHes)   → HIGH confidence
 *   2. MEDIUM markets    → sparse SALEs, 1-3 per variation         → MEDIUM confidence (observed < 5)
 *   3. EMPTY markets     → nothing                                 → LOW confidence (cross-market inference)
 *   4. Every mode        → unit prices populated                   → Custom-revenue mode works
 *
 * Note: DISPATCHes are seeded at RICH + MEDIUM markets for shipping
 * realism but the suggestion engine no longer consumes them — demand
 * is sales-only (see docs/packing-list-suggestion.md §5).
 *
 * Also seeds a warehouse baseline (INTAKE events) so there's actual stock
 * to allocate + cap against.
 *
 * Everything is idempotent via consistent idempotency keys, so rerunning
 * this against the same DB is a no-op after the first successful pass.
 *
 * Dry-run by default; pass `--apply` to write.
 *
 * Deliberately does NOT wipe or reset — it adds/updates in place, so
 * real data (from Square backfill, real dispatches, etc.) is preserved.
 *
 * Usage:
 *   pnpm --filter api cli:seed-suggest-test-data
 *   pnpm --filter api cli:seed-suggest-test-data -- --apply
 *
 * Market tiers are assigned by ordering: the first N/2 active markets get
 * RICH data, the next 2 get MEDIUM, the next 2 get EMPTY. The rest are
 * left as-is (whatever data they already have from other seeds).
 */

const RICH_COUNT_FRAC = 0.5 // first ~half of markets get rich data
const MEDIUM_COUNT = 2 // next 2 get sparse sales (1-3 per variation → MEDIUM confidence)
const EMPTY_COUNT = 2 // next 2 stay empty (for cross-market test)

// No longer capped — the seed now covers every variation in the DB so a
// generated packing list reflects every product the operator can actually
// pack. Bumped WAREHOUSE_UNITS_PER_WV to a level that comfortably absorbs
// the maximum plausible seeded sales × dispatches at any single WV
// without going negative at the warehouse.
const WAREHOUSE_UNITS_PER_WV = 500
const MAX_SALES_PER_VARIATION = 40
const MAX_DISPATCH_UNITS_PER_WV = 30

/** $10–$80 unit cost for any WarehouseVariant that has none. */
const MIN_UNIT_COST_CENTS = 1000
const MAX_UNIT_COST_CENTS = 8000

function hashSeed(...parts: string[]): number {
  let h = 2166136261
  const input = parts.join('|')
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) & 0x7fffffff
}
function rand01(seed: number): number {
  let x = seed | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) % 1_000_000) / 1_000_000
}
function randInt(seed: number, lo: number, hi: number): number {
  return Math.floor(rand01(seed) * (hi - lo + 1)) + lo
}
function pickN<T>(pool: T[], n: number, seedBase: number): T[] {
  const arr = [...pool]
  for (let i = arr.length - 1; i > 0; i--) {
    const r = rand01(hashSeed(String(seedBase), String(i)))
    const j = Math.floor(r * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr.slice(0, Math.min(n, arr.length))
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const wipe = process.argv.includes('--wipe')
  const prisma = new PrismaService()
  await prisma.$connect()
  const ledger = new LedgerService(prisma)

  /// Reverse (cancel) all prior seeded SCRIPT SALEs from this seed CLI.
  /// LedgerEvent is append-only at the DB level (a hand-written trigger
  /// blocks DELETE / UPDATE) so "wipe" is done by writing correcting
  /// positive-quantity SALE events — the exact same pattern the Square
  /// mapper uses for returns (spec §7.1). Net effect on demand queries
  /// per (locationId, variationId, [warehouseVariantId]): zero.
  ///
  /// Idempotent: reversal keys are derived from the original key, so a
  /// second --wipe pass finds the reversals already in place and does
  /// nothing new.
  ///
  /// After reversal, fresh SALEs get a version suffix so their idempotency
  /// keys don't collide with the (still-present) originals. Each --wipe
  /// invocation uses a fresh timestamp version.
  const seedVersion = wipe ? `-v${Date.now()}` : ''
  const salesKey = (marketId: string, variationId: string, n: number) =>
    `suggest-seed${seedVersion}:sale:${marketId}:${variationId}:${n}`
  const intakeForSaleKey = (marketId: string, variationId: string, n: number) =>
    `suggest-seed${seedVersion}:intake-for-sale:${marketId}:${variationId}:${n}`
  const mediumSalesKey = (marketId: string, variationId: string, n: number) =>
    `suggest-seed${seedVersion}:medium-sale:${marketId}:${variationId}:${n}`
  const mediumIntakeForSaleKey = (marketId: string, variationId: string, n: number) =>
    `suggest-seed${seedVersion}:medium-intake-for-sale:${marketId}:${variationId}:${n}`

  try {
    // Windows: distribute events across last year's default recommendation
    // window (trailing 12 months ending 1 year ago from today). That way
    // the engine picks them up with default settings — no sales-window
    // input required in the UI.
    const now = new Date()
    const windowEnd = new Date(now)
    windowEnd.setFullYear(windowEnd.getFullYear() - 1)
    const windowStart = new Date(windowEnd)
    windowStart.setFullYear(windowStart.getFullYear() - 1)
    // Warehouse INTAKE lands before the window so the stock is on hand
    // when dispatches happen.
    const warehouseIntakeAt = new Date(windowStart)
    warehouseIntakeAt.setMonth(warehouseIntakeAt.getMonth() - 1)

    console.log(`\nSeed suggest-test data  [${apply ? 'APPLY' : 'DRY RUN'}]`)
    console.log(`  window:                 ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)}`)
    console.log(`  warehouse intake at:    ${warehouseIntakeAt.toISOString().slice(0, 10)}`)

    // Load reference data
    const warehouse = await prisma.location.findFirst({
      where: { kind: 'WAREHOUSE' },
      select: { id: true, name: true },
    })
    if (!warehouse) throw new Error('No WAREHOUSE location — cannot seed.')

    const markets = await prisma.location.findMany({
      where: { kind: 'MARKET', isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    if (markets.length === 0) throw new Error('No active MARKET locations — cannot seed.')

    // Cover EVERY variation in the local catalog that has at least one
    // warehouse variant to receive dispatched stock. No pool cap — the
    // suggest engine should see the same product surface an operator
    // does. Sortly-imported items with no WV are skipped (nothing to
    // stock).
    const variationsRaw = await prisma.variation.findMany({
      select: {
        id: true,
        warehouseVariants: { select: { id: true } },
      },
    })
    const candidateVariations = variationsRaw.filter((v) => v.warehouseVariants.length > 0)
    if (candidateVariations.length === 0) throw new Error('No variations with warehouse variants — cannot seed.')

    // ---- 1. Fill in missing unit costs ------------------------------------
    const wvsMissingCost = await prisma.warehouseVariant.findMany({
      where: { unitCostCents: null },
      select: { id: true },
    })
    console.log(`\n  ${wvsMissingCost.length} warehouse variant(s) missing unitCostCents`)
    if (apply && wvsMissingCost.length > 0) {
      for (const wv of wvsMissingCost) {
        const cents = randInt(hashSeed('cost', wv.id), MIN_UNIT_COST_CENTS, MAX_UNIT_COST_CENTS)
        await prisma.warehouseVariant.update({ where: { id: wv.id }, data: { unitCostCents: cents } })
      }
      console.log(`  filled unitCostCents on ${wvsMissingCost.length} WV(s)`)
    }

    // ---- 1.5. --wipe: reverse prior seeded SCRIPT SALEs -------------------
    // Applied ONLY when --wipe is passed. Finds every previously-seeded
    // SALE row and writes a correcting positive-quantity SALE with a
    // derived idempotency key, so the sum-by-variation demand queries net
    // to zero. Warehouse INTAKEs are left alone — they don't affect
    // demand-signal queries and stay useful as a baseline stock.
    if (wipe) {
      // Reverse both prior seeded SALEs AND their paired market INTAKEs so
      // the net on-hand effect returns fully to zero — otherwise
      // reversing sales alone would leave the paired intakes as orphan
      // positive stock at markets. Baseline `warehouse-intake:` events
      // are explicitly excluded so warehouse stock survives the wipe.
      const priorSeeded = await prisma.ledgerEvent.findMany({
        where: {
          source: 'SCRIPT',
          idempotencyKey: { startsWith: 'suggest-seed' },
          OR: [
            { type: 'SALE' },
            // Only paired market intakes — NOT the warehouse baseline.
            { AND: [{ type: 'INTAKE' }, { idempotencyKey: { contains: ':intake-for-sale:' } }] },
          ],
          // Skip reversals so a second --wipe pass doesn't re-apply the
          // originals.
          NOT: { idempotencyKey: { startsWith: 'suggest-seed-reverse:' } },
        },
        select: {
          type: true,
          locationId: true,
          variationId: true,
          warehouseVariantId: true,
          quantity: true,
          occurredAt: true,
          idempotencyKey: true,
        },
      })
      const saleCount = priorSeeded.filter((r) => r.type === 'SALE').length
      const intakeCount = priorSeeded.filter((r) => r.type === 'INTAKE').length
      console.log(`\n  --wipe: ${saleCount} prior seeded SALE row(s) + ${intakeCount} paired INTAKE row(s) found`)
      let reversedCount = 0
      let alreadyReversedCount = 0
      if (apply) {
        for (const original of priorSeeded) {
          const { created } = await ledger.append({
            type: original.type,
            locationId: original.locationId,
            variationId: original.variationId,
            warehouseVariantId: original.warehouseVariantId ?? undefined,
            // Flip sign: reversal cancels the original's effect on on-hand.
            quantity: -original.quantity,
            occurredAt: original.occurredAt,
            source: 'SCRIPT',
            sourceRef: 'seed-suggest-test-data --wipe',
            idempotencyKey: `suggest-seed-reverse:${original.idempotencyKey}`,
            note: `reversal of prior seeded ${original.type} (--wipe)`,
          })
          if (created) reversedCount++
          else alreadyReversedCount++
        }
        console.log(`  wrote ${reversedCount} reversal row(s); ${alreadyReversedCount} already reversed on a prior --wipe`)
      } else {
        console.log(`  would write up to ${priorSeeded.length} reversal row(s)`)
      }
      if (priorSeeded.length > 0) {
        console.log(`  new SALEs written this run will use key prefix "suggest-seed${seedVersion}:sale:..."`)
      }
    }

    // ---- 2. Categorize markets --------------------------------------------
    const richCount = Math.max(1, Math.floor(markets.length * RICH_COUNT_FRAC))
    const richMarkets = markets.slice(0, richCount)
    const mediumMarkets = markets.slice(richCount, richCount + MEDIUM_COUNT)
    const emptyMarkets = markets.slice(richCount + MEDIUM_COUNT, richCount + MEDIUM_COUNT + EMPTY_COUNT)
    const untouchedMarkets = markets.slice(richCount + MEDIUM_COUNT + EMPTY_COUNT)

    console.log(`\n  RICH markets     (dense SALEs):      ${richMarkets.length}`)
    console.log(`  MEDIUM markets   (sparse SALEs):     ${mediumMarkets.length}`)
    console.log(`  EMPTY markets    (no seed data):     ${emptyMarkets.length}`)
    console.log(`  untouched:                            ${untouchedMarkets.length}`)

    console.log(`\n  RICH:    ${richMarkets.map((m) => m.name).join(', ')}`)
    console.log(`  MEDIUM:  ${mediumMarkets.map((m) => m.name).join(', ')}`)
    console.log(`  EMPTY:   ${emptyMarkets.map((m) => m.name).join(', ')}`)

    // ---- 3. Seed warehouse stock ------------------------------------------
    const allWvs: Array<{ id: string; variationId: string }> = []
    for (const v of candidateVariations) for (const wv of v.warehouseVariants) allWvs.push({ id: wv.id, variationId: v.id })

    let warehouseIntakes = 0
    if (apply) {
      for (const wv of allWvs) {
        const { created } = await ledger.append({
          type: 'INTAKE',
          locationId: warehouse.id,
          variationId: wv.variationId,
          warehouseVariantId: wv.id,
          quantity: WAREHOUSE_UNITS_PER_WV,
          occurredAt: warehouseIntakeAt,
          source: 'SCRIPT',
          sourceRef: 'seed-suggest-test-data',
          idempotencyKey: `suggest-seed:warehouse-intake:${wv.id}`,
          note: 'seed baseline warehouse stock',
        })
        if (created) warehouseIntakes++
      }
      console.log(`\n  wrote ${warehouseIntakes} warehouse INTAKE event(s) (${allWvs.length} WVs @ ${WAREHOUSE_UNITS_PER_WV} each)`)
    } else {
      console.log(`\n  would write ${allWvs.length} warehouse INTAKE events @ ${WAREHOUSE_UNITS_PER_WV} each`)
    }

    // ---- 4. RICH markets: SALEs + DISPATCHes ------------------------------
    let saleEvents = 0
    let dispatchEvents = 0
    for (const market of richMarkets) {
      // Every variation at every RICH market — full catalog coverage.
      for (const variation of candidateVariations) {
        const hotness = 0.2 + rand01(hashSeed('hotness', market.id, variation.id)) * 0.8
        const saleCount = Math.max(1, Math.floor(hotness * MAX_SALES_PER_VARIATION))
        const wvsInFamily = variation.warehouseVariants
        // Build a skewed colour distribution — first colour of the family
        // gets highest weight, decays quickly. Makes the sales-based
        // colour split actually meaningful (one colour dominates).
        const colourWeights = wvsInFamily.map((_, i) => Math.max(1, wvsInFamily.length - i))
        const totalWeight = colourWeights.reduce((a, b) => a + b, 0)
        // Seed SALEs at market with per-colour granularity (warehouseVariantId
        // set) — this simulates the ideal state where Square catalog is
        // mapped at the per-SKU level. The engine then uses these for the
        // colour split instead of falling back to dispatch history.
        for (let n = 0; n < saleCount; n++) {
          const t =
            windowStart.getTime() +
            rand01(hashSeed('sale-date', market.id, variation.id, String(n))) *
              (windowEnd.getTime() - windowStart.getTime())
          const occurredAt = new Date(t)
          const qty = rand01(hashSeed('sale-qty', market.id, variation.id, String(n))) > 0.75 ? 2 : 1
          // Pick a colour by weight so the first colour in the family
          // wins ~40%, the second ~30%, etc. — a realistic "one colour
          // is a bestseller" pattern.
          let pickedWv = wvsInFamily[0]
          if (wvsInFamily.length > 1) {
            const r = rand01(hashSeed('sale-colour', market.id, variation.id, String(n))) * totalWeight
            let acc = 0
            for (let i = 0; i < wvsInFamily.length; i++) {
              acc += colourWeights[i]!
              if (r <= acc) { pickedWv = wvsInFamily[i]; break }
            }
          }
          if (apply) {
            // Pair every SALE with an INTAKE at the same market, 1ms
            // earlier, same colour/qty. Reason: SALEs at market subtract
            // from on-hand; without a matching add, the market goes
            // negative if the fake sales exceed what dispatches supplied.
            // The paired INTAKE says "this stock was on the shelf at the
            // moment the historical sale happened" — semantically honest
            // and mechanically net-zero on today's on-hand. The engine's
            // demand queries only filter by type='SALE', so this INTAKE
            // is invisible to demand aggregation.
            const intakeAt = new Date(occurredAt.getTime() - 1)
            const intakeRes = await ledger.append({
              type: 'INTAKE',
              locationId: market.id,
              variationId: variation.id,
              warehouseVariantId: pickedWv?.id,
              quantity: qty, // positive; restores what the SALE removes
              occurredAt: intakeAt,
              source: 'SCRIPT',
              sourceRef: 'seed-suggest-test-data',
              idempotencyKey: intakeForSaleKey(market.id, variation.id, n),
              note: 'synthetic balance for seeded SALE',
            })
            if (intakeRes.created) saleEvents++ // count both halves as one logical write
            const { created } = await ledger.append({
              type: 'SALE',
              locationId: market.id,
              variationId: variation.id,
              warehouseVariantId: pickedWv?.id,
              quantity: -qty,
              occurredAt,
              source: 'SCRIPT',
              sourceRef: 'seed-suggest-test-data',
              idempotencyKey: salesKey(market.id, variation.id, n),
            })
            if (created) saleEvents++
          }
        }
        // Seed DISPATCHes for colour splits — pick a subset of the family's
        // WVs and skew the mix (some colours dominate) so the engine has
        // a meaningful mix to split by.
        if (wvsInFamily.length > 0) {
          const dispatchWvs = pickN(wvsInFamily, Math.min(3, wvsInFamily.length), hashSeed('dispatch-wv', market.id, variation.id))
          for (const wv of dispatchWvs) {
            const units = randInt(hashSeed('dispatch-qty', market.id, variation.id, wv.id), 5, MAX_DISPATCH_UNITS_PER_WV)
            const t =
              windowStart.getTime() +
              rand01(hashSeed('dispatch-date', market.id, variation.id, wv.id)) *
                (windowEnd.getTime() - windowStart.getTime())
            const occurredAt = new Date(t)
            if (apply) {
              const { created } = await ledger.transfer({
                type: 'DISPATCH',
                fromLocationId: warehouse.id,
                toLocationId: market.id,
                variationId: variation.id,
                warehouseVariantId: wv.id,
                quantity: units,
                occurredAt,
                source: 'SCRIPT',
                sourceRef: 'seed-suggest-test-data',
                idempotencyKeyPrefix: `suggest-seed:dispatch:${market.id}:${variation.id}:${wv.id}`,
              })
              if (created) dispatchEvents++
            }
          }
        }
      }
    }

    // ---- 5. MEDIUM markets: sparse SALEs + DISPATCHes ---------------------
    // Sparse (1-3 SALEs per variation) so the engine hits the
    // `observed < 5` MEDIUM confidence path. Same paired-INTAKE pattern
    // as RICH markets to keep market on-hand non-negative. DISPATCHes
    // are still written for shipping realism but the engine ignores
    // them (see docs §5).
    for (const market of mediumMarkets) {
      for (const variation of candidateVariations) {
        const wvsInFamily = variation.warehouseVariants
        if (wvsInFamily.length === 0) continue

        const saleCount = randInt(hashSeed('medium-sale-count', market.id, variation.id), 1, 3)
        for (let n = 0; n < saleCount; n++) {
          const t =
            windowStart.getTime() +
            rand01(hashSeed('medium-sale-date', market.id, variation.id, String(n))) *
              (windowEnd.getTime() - windowStart.getTime())
          const occurredAt = new Date(t)
          const qty = 1
          const pickIdx = Math.floor(
            rand01(hashSeed('medium-sale-colour', market.id, variation.id, String(n))) * wvsInFamily.length,
          )
          const pickedWv = wvsInFamily[Math.min(pickIdx, wvsInFamily.length - 1)]
          if (apply) {
            const intakeAt = new Date(occurredAt.getTime() - 1)
            const intakeRes = await ledger.append({
              type: 'INTAKE',
              locationId: market.id,
              variationId: variation.id,
              warehouseVariantId: pickedWv?.id,
              quantity: qty,
              occurredAt: intakeAt,
              source: 'SCRIPT',
              sourceRef: 'seed-suggest-test-data',
              idempotencyKey: mediumIntakeForSaleKey(market.id, variation.id, n),
              note: 'synthetic balance for seeded SALE',
            })
            if (intakeRes.created) saleEvents++
            const { created } = await ledger.append({
              type: 'SALE',
              locationId: market.id,
              variationId: variation.id,
              warehouseVariantId: pickedWv?.id,
              quantity: -qty,
              occurredAt,
              source: 'SCRIPT',
              sourceRef: 'seed-suggest-test-data',
              idempotencyKey: mediumSalesKey(market.id, variation.id, n),
            })
            if (created) saleEvents++
          }
        }

        const dispatchWvs = pickN(wvsInFamily, Math.min(2, wvsInFamily.length), hashSeed('medium-dispatch-wv', market.id, variation.id))
        for (const wv of dispatchWvs) {
          const units = randInt(hashSeed('medium-dispatch-qty', market.id, variation.id, wv.id), 5, MAX_DISPATCH_UNITS_PER_WV)
          const t =
            windowStart.getTime() +
            rand01(hashSeed('medium-dispatch-date', market.id, variation.id, wv.id)) *
              (windowEnd.getTime() - windowStart.getTime())
          const occurredAt = new Date(t)
          if (apply) {
            const { created } = await ledger.transfer({
              type: 'DISPATCH',
              fromLocationId: warehouse.id,
              toLocationId: market.id,
              variationId: variation.id,
              warehouseVariantId: wv.id,
              quantity: units,
              occurredAt,
              source: 'SCRIPT',
              sourceRef: 'seed-suggest-test-data',
              idempotencyKeyPrefix: `suggest-seed:medium-dispatch:${market.id}:${variation.id}:${wv.id}`,
            })
            if (created) dispatchEvents++
          }
        }
      }
    }

    console.log(`\n  wrote ${saleEvents} SALE/paired-INTAKE row(s) at rich + medium markets`)
    console.log(`  wrote ${dispatchEvents} DISPATCH transfer(s) (each = 1 warehouse-side + 1 market-side row)`)

    console.log('\nSummary')
    if (apply) {
      console.log(`  ${warehouseIntakes} new warehouse INTAKE row(s)`)
      console.log(`  ${saleEvents} new SALE/paired-INTAKE row(s) at rich + medium markets`)
      console.log(`  ${dispatchEvents} new DISPATCH transfer(s) at rich + medium markets`)
      console.log(`  ${wvsMissingCost.length} WV unit costs filled in`)
      console.log('\nTest plan:')
      console.log(`  • Pick a RICH market (${richMarkets[0]?.name}) → HIGH-confidence recommendations across all target modes`)
      console.log(`  • Pick a MEDIUM market (${mediumMarkets[0]?.name}) → MEDIUM-confidence (sparse sales, <5 observations)`)
      console.log(`  • Pick an EMPTY market (${emptyMarkets[0]?.name}) → LOW-confidence, cross-market inference note appears`)
      console.log('  • Custom revenue mode → prices from unitCostCents drive the allocation')
      console.log('  • Initial shipment mode → ~85% of warehouse total gets distributed')
    } else {
      console.log('\nDry run — pass --apply to write.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
