import './load-env.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'

/**
 * Populates every active MARKET location with synthetic Square-style SALE
 * events so the recommendation engine has cross-market data to work with.
 *
 * The Square sandbox only has orders concentrated at one or two locations,
 * which means only those markets get real recommendations. For a demo
 * across every market, we seed plausible sales history directly into the
 * ledger. The recommendation service reads `LedgerEvent` — it does not
 * care whether a SALE row came from Square or a script.
 *
 * Shape of seeded data:
 *   - Written at family (variationId) grain with `warehouseVariantId=null`,
 *     matching real Square's family-level sales. Colour split in the
 *     recommendation therefore falls through to the "no dispatch history →
 *     split evenly across warehouse variants" branch, which is fine for a
 *     demo. If we later want colour bias per market, layer DISPATCH events
 *     on top; that's a follow-up.
 *   - Spread across a fixed window (trailing 12 months ending one year
 *     before today) so it matches the recommendation service's default
 *     window fallback. The operator can leave the "sales window" blank in
 *     the UI and still see suggestions.
 *   - Per-variation hotness varies per market — a bestseller in Denver may
 *     be a slow mover in Boston. Makes the demo look more interesting than
 *     "every market wants the same top three products."
 *   - `source=SCRIPT`, idempotency key `seed-sale:{market}:{variation}:{n}`
 *     so the rows are distinguishable from Square-originated data and safe
 *     to rerun (dedupes cleanly, never doubles).
 *
 * Safety:
 *   - Dry-run by default. Pass `--apply` to write.
 *   - Idempotent — rerunning with the same seed produces the same keys and
 *     just dedupes.
 *   - Does NOT delete or correct anything. LedgerEvent is append-only at
 *     the DB level; if you need to remove seeded rows, use
 *     `cli:reset-db-keep-users` (nuclear) or write CORRECTION rows.
 */

interface Args {
  apply: boolean
  variationsPerMarket: number
  maxSalesPerVariation: number
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply')
  const vpm = Number(pickValue(argv, '--variations-per-market') ?? '20')
  const msv = Number(pickValue(argv, '--max-sales-per-variation') ?? '40')
  return { apply, variationsPerMarket: vpm, maxSalesPerVariation: msv }
}

function pickValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

/**
 * Deterministic pseudo-random from a string. Same input → same output, so
 * a rerun of the seeder produces the same distribution and the idempotency
 * keys line up cleanly. Not cryptographic — just enough to spread values.
 */
function hashSeed(...parts: string[]): number {
  let h = 2166136261
  const input = parts.join('|')
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // Positive int in [0, 2^31)
  return Math.abs(h) & 0x7fffffff
}

/** Reproducible pseudo-random in [0, 1) from an integer seed. */
function rand01(seed: number): number {
  // xorshift32 — cheap and reproducible
  let x = seed | 0
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) % 1_000_000) / 1_000_000
}

function pickN<T>(pool: T[], n: number, seedBase: number): T[] {
  // Fisher-Yates with seeded RNG so the same seed picks the same subset.
  const arr = [...pool]
  for (let i = arr.length - 1; i > 0; i--) {
    const r = rand01(hashSeed(String(seedBase), String(i)))
    const j = Math.floor(r * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr.slice(0, Math.min(n, arr.length))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const prisma = new PrismaService()
  await prisma.$connect()
  const ledger = new LedgerService(prisma)

  try {
    // Window: trailing 12 months ending one year ago, matching the default
    // `resolveLastYearWindow` fallback in packing-list-suggestion.service.
    const now = new Date()
    const windowEnd = new Date(now)
    windowEnd.setFullYear(windowEnd.getFullYear() - 1)
    const windowStart = new Date(windowEnd)
    windowStart.setFullYear(windowStart.getFullYear() - 1)

    console.log(`\nSeed fake sales  [${args.apply ? 'APPLY' : 'DRY RUN'}]`)
    console.log(`  window:  ${windowStart.toISOString().slice(0, 10)}  →  ${windowEnd.toISOString().slice(0, 10)}`)
    console.log(`  variations per market: ${args.variationsPerMarket}`)
    console.log(`  max sales per variation: ${args.maxSalesPerVariation}`)

    const [markets, variations] = await Promise.all([
      prisma.location.findMany({
        where: { kind: 'MARKET', isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.variation.findMany({
        select: { id: true, itemGroupId: true },
        orderBy: { id: 'asc' },
      }),
    ])

    console.log(`  markets: ${markets.length}`)
    console.log(`  variations available: ${variations.length}`)

    if (markets.length === 0 || variations.length === 0) {
      console.error('\nNothing to seed — need at least one MARKET and one Variation.')
      process.exitCode = 1
      return
    }

    let totalEvents = 0
    let totalWritten = 0
    let totalDeduped = 0

    for (const market of markets) {
      // Deterministic-random subset of variations for this market. Two
      // markets get different (but overlapping) product mixes.
      const chosen = pickN(variations, args.variationsPerMarket, hashSeed('market-variations', market.id))
      let marketEvents = 0

      for (let i = 0; i < chosen.length; i++) {
        const variation = chosen[i]!

        // Hotness score in [0.1, 1.0] — determines sale volume for this
        // (market, variation) pair.
        const hotness = 0.1 + rand01(hashSeed('hotness', market.id, variation.id)) * 0.9
        const eventCount = Math.max(1, Math.floor(hotness * args.maxSalesPerVariation))

        for (let n = 0; n < eventCount; n++) {
          // Random date in the window.
          const t =
            windowStart.getTime() +
            rand01(hashSeed('date', market.id, variation.id, String(n))) *
              (windowEnd.getTime() - windowStart.getTime())
          const occurredAt = new Date(t)

          // Quantity: 1 or 2, weighted toward 1.
          const qty = rand01(hashSeed('qty', market.id, variation.id, String(n))) > 0.75 ? 2 : 1

          // Same correctness rule as backfill-square-sales: a SALE event
          // reduces the market's derived on-hand. Historical sales must be
          // paired with a preceding INTAKE at the same market for the net
          // effect on today's on-hand to be zero. Otherwise seeding fake
          // sales for the demo would silently drive every market's stock
          // level down — a great way to break the /pack and /requests UIs
          // right before showing them to the CEO.
          totalEvents += 2 // SALE + paired INTAKE
          marketEvents += 2

          if (!args.apply) continue

          const intakeOccurredAt = new Date(occurredAt.getTime() - 1)
          const intakeRes = await ledger.append({
            type: 'INTAKE',
            locationId: market.id,
            variationId: variation.id,
            warehouseVariantId: undefined,
            quantity: qty, // positive — restores the units the sale removes
            occurredAt: intakeOccurredAt,
            source: 'SCRIPT',
            sourceRef: 'seed-fake-sales',
            idempotencyKey: `seed-intake:${market.id}:${variation.id}:${n}`,
            note: 'synthetic balance for seeded SALE',
          })
          if (intakeRes.created) totalWritten++
          else totalDeduped++

          const saleRes = await ledger.append({
            type: 'SALE',
            locationId: market.id,
            variationId: variation.id,
            warehouseVariantId: undefined, // Family-level, matches Square
            quantity: -qty, // SALE decrements
            occurredAt,
            source: 'SCRIPT',
            sourceRef: 'seed-fake-sales',
            idempotencyKey: `seed-sale:${market.id}:${variation.id}:${n}`,
          })
          if (saleRes.created) totalWritten++
          else totalDeduped++
        }
      }

      console.log(`  → ${market.name.padEnd(28)} ${marketEvents} events across ${chosen.length} variations`)
    }

    console.log('\nSummary')
    console.log(`  ${totalEvents} SALE events ${args.apply ? 'processed' : 'would be written'}`)
    if (args.apply) {
      console.log(`  ${totalWritten} newly written`)
      console.log(`  ${totalDeduped} already present (idempotency dedupe)`)
    }
    if (!args.apply) {
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
