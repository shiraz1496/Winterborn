import './load-env.js'
import { SquareClient, SquareEnvironment, type Square } from 'square'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { mapOrderToLedgerInputs } from '../square/order-mapper.js'

/**
 * One-off historical backfill of Square SALE events into `LedgerEvent`.
 *
 * The recommendation engine (packing list suggestion) needs a year+ of
 * real sales-by-location data. The webhook + poll only started collecting
 * from the day this system went live, so this script pulls historical
 * orders from Square and drops them straight into our ledger with their
 * real `createdAt` dates.
 *
 * Environment is driven by SQUARE_ENV in .env:
 *   - SQUARE_ENV=sandbox    → connects to Square Sandbox
 *   - SQUARE_ENV=production → connects to Square Production
 *
 * Uses `SQUARE_ACCESS_TOKEN` for both. That token MUST match the chosen
 * environment (sandbox token for sandbox, production token for production)
 * — mismatches surface as 401 UNAUTHORIZED from Square. The CLI prints
 * which environment it resolved so a mismatch is obvious in the dry-run
 * output before any writes happen.
 *
 * Deliberately does NOT reuse `apps/api/src/square/square-client.ts` — that
 * module's `assertSandbox()` guard runs at module-load time and would fail
 * outright when SQUARE_ENV=production. This CLI is read-only against Square
 * and needs to work in both environments, so it stands up its own client.
 *
 * Uses `mapOrderToLedgerInputs` — the same mapper the webhook and poll
 * use — so idempotency keys match. If the poll later re-scans the same
 * historical window, it dedupes cleanly against these rows.
 *
 * Safety:
 *   - Dry-run by default. Pass `--apply` to write.
 *   - Read-only against Square — never writes an order or catalog object.
 *   - Idempotent via the mapper's `sale:{orderId}:{lineUid}` keys — safe
 *     to rerun with an overlapping date range.
 *   - Every SALE gets a paired INTAKE (1ms earlier) at the same market so
 *     historical sales do not silently reduce today's on-hand counts.
 *
 * Usage:
 *   pnpm --filter api cli:backfill-square-sales -- --start 2025-01-01 --end 2025-12-31
 *   pnpm --filter api cli:backfill-square-sales -- --start 2025-01-01 --apply
 */

function resolveSquareEnv(): { environment: SquareEnvironment; label: 'sandbox' | 'production' } {
  const raw = (process.env.SQUARE_ENV ?? '').trim().toLowerCase()
  if (raw === 'production' || raw === 'prod') {
    return { environment: SquareEnvironment.Production, label: 'production' }
  }
  if (raw === 'sandbox' || raw === '') {
    // Default to sandbox on unset — safer than defaulting to production.
    return { environment: SquareEnvironment.Sandbox, label: 'sandbox' }
  }
  throw new Error(`SQUARE_ENV=${JSON.stringify(process.env.SQUARE_ENV)} — expected "sandbox" or "production".`)
}

function assertNoSquareErrors(res: unknown, context: string): void {
  if (typeof res !== 'object' || res === null || !('errors' in res)) return
  const errors = (res as { errors?: Array<{ category?: string; code?: string; detail?: string }> }).errors
  if (!errors || errors.length === 0) return
  const detail = errors
    .map((e) => `${e.category ?? '?'}/${e.code ?? '?'}${e.detail ? `: ${e.detail}` : ''}`)
    .join('; ')
  throw new Error(`${context}: Square API returned errors — ${detail}`)
}

interface Args {
  start: Date
  end: Date
  apply: boolean
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply')
  const start = pickValue(argv, '--start')
  const end = pickValue(argv, '--end')
  if (!start) {
    throw new Error('Missing --start YYYY-MM-DD')
  }
  const startDate = new Date(`${start}T00:00:00Z`)
  if (Number.isNaN(startDate.getTime())) {
    throw new Error(`Invalid --start: "${start}". Expected YYYY-MM-DD.`)
  }
  const endDate = end ? new Date(`${end}T23:59:59Z`) : new Date()
  if (Number.isNaN(endDate.getTime())) {
    throw new Error(`Invalid --end: "${end}". Expected YYYY-MM-DD.`)
  }
  if (endDate < startDate) {
    throw new Error(`--end (${end}) is before --start (${start}).`)
  }
  return { start: startDate, end: endDate, apply }
}

function pickValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  return argv[i + 1]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const { environment, label: envLabel } = resolveSquareEnv()
  const token = process.env.SQUARE_ACCESS_TOKEN
  if (!token) {
    console.error('SQUARE_ACCESS_TOKEN not set in .env — required to talk to Square.')
    process.exitCode = 1
    return
  }
  // Standalone client for this CLI only — never exported, never reused.
  // Environment selection is deliberate and printed at startup so a
  // sandbox/production mismatch is obvious before any writes happen.
  const square = new SquareClient({ token, environment })

  const prisma = new PrismaService()
  await prisma.$connect()
  const ledger = new LedgerService(prisma)

  try {
    console.log(`\nSquare historical sales backfill (${envLabel})`)
    console.log(`  window:  ${args.start.toISOString()}  →  ${args.end.toISOString()}`)
    console.log(`  mode:    ${args.apply ? 'APPLY (writes to ledger)' : 'DRY RUN (no writes)'}`)

    // Same catalog + location indexes the poll uses. If a squareVariationId
    // in our DB was synced from sandbox, it won't match production and
    // orders referencing it dead-letter — that's expected and reported in
    // the summary so the operator can decide whether to abort.
    const [warehouseVariants, variations, locations] = await Promise.all([
      prisma.warehouseVariant.findMany({
        where: { squareVariationId: { not: null } },
        select: { id: true, variationId: true, squareVariationId: true },
      }),
      prisma.variation.findMany({
        where: { squareVariationId: { not: null } },
        select: { id: true, squareVariationId: true },
      }),
      prisma.location.findMany({
        where: { squareLocationId: { not: null }, kind: 'MARKET' },
        select: { id: true, name: true, squareLocationId: true, isActive: true },
      }),
    ])

    const warehouseVariantIndex = new Map(
      warehouseVariants.map((wv) => [
        wv.squareVariationId as string,
        { variationId: wv.variationId, warehouseVariantId: wv.id },
      ]),
    )
    const variationIndex = new Map(
      variations.map((v) => [v.squareVariationId as string, { variationId: v.id }]),
    )
    const locationIndex = new Map(locations.map((l) => [l.squareLocationId as string, l.id]))
    const resolveCatalog = (id: string) => warehouseVariantIndex.get(id) ?? variationIndex.get(id)

    console.log(`  catalog: ${warehouseVariants.length} warehouse variants + ${variations.length} family variations mapped to Square`)
    console.log(`  markets: ${locations.length} MARKET locations with squareLocationId`)

    if (locations.length === 0) {
      console.error('\nNo MARKET locations have a squareLocationId set — nothing to poll.')
      process.exitCode = 1
      return
    }

    let ingested = 0
    let deduped = 0
    let deadLetters = 0
    let orders = 0
    const perLocation: Array<{ name: string; orders: number; ingested: number; deduped: number; deadLetters: number }> = []

    for (const location of locations) {
      console.log(`\n  → ${location.name}${location.isActive ? '' : ' (inactive)'}`)
      let cursor: string | undefined
      let locOrders = 0
      let locIngested = 0
      let locDeduped = 0
      let locDeadLetters = 0

      do {
        const res: Square.SearchOrdersResponse = await square.orders.search({
          locationIds: [location.squareLocationId as string],
          cursor,
          query: {
            filter: {
              dateTimeFilter: {
                createdAt: {
                  startAt: args.start.toISOString(),
                  endAt: args.end.toISOString(),
                },
              },
              // Only COMPLETED orders count as sales — the mapper enforces
              // this too, but pushing the filter server-side saves paging.
              stateFilter: { states: ['COMPLETED'] },
            },
            sort: { sortField: 'CREATED_AT', sortOrder: 'ASC' },
          },
        })
        assertNoSquareErrors(res, `orders.search (${location.name})`)

        for (const order of res.orders ?? []) {
          locOrders++
          orders++
          const { events, deadLetters: dl } = mapOrderToLedgerInputs(
            order,
            resolveCatalog,
            (id) => locationIndex.get(id),
            'SCRIPT',
          )
          locDeadLetters += dl.length
          deadLetters += dl.length

          // Correctness gate for historical backfill: a SALE event lowers
          // the market's derived on-hand. If we just append the sale, the
          // ledger says "500 more units left the market than actually did"
          // — because those units already left months ago and today's
          // count already reflects that. Fix: for every SALE event, also
          // append a paired INTAKE at the same location just before the
          // sale, positive quantity of the same magnitude. Semantically:
          // "this stock was on the shelf when the historical sale
          // happened, then it was sold." Net effect on current on-hand:
          // zero. The recommendation engine still sees the SALE as demand
          // signal (it filters on type='SALE'); the INTAKE is invisible
          // to the demand queries but keeps the on-hand math honest.
          //
          // Only applies here — the webhook + poll paths do NOT need this
          // pairing, because those record sales as they happen against
          // stock that IS still on the shelf at that moment.
          const paired: typeof events = []
          for (const event of events) {
            paired.push(event)
            if (event.type === 'SALE' && event.quantity < 0) {
              const intakeOccurredAt = new Date(event.occurredAt.getTime() - 1)
              paired.push({
                type: 'INTAKE',
                locationId: event.locationId,
                variationId: event.variationId,
                warehouseVariantId: event.warehouseVariantId,
                quantity: -event.quantity, // flip sign to positive
                occurredAt: intakeOccurredAt,
                source: 'SCRIPT',
                sourceRef: event.sourceRef,
                idempotencyKey: `backfill-intake:${event.idempotencyKey}`,
                note: 'synthetic balance for historical SALE (backfill)',
              })
            }
          }

          if (!args.apply) {
            // Dry run: count what we would append. The mapper's idempotency
            // key doesn't need to be checked against the DB here — we're
            // just showing scale.
            locIngested += paired.length
            ingested += paired.length
            continue
          }
          for (const event of paired) {
            const { created } = await ledger.append(event)
            if (created) {
              locIngested++
              ingested++
            } else {
              locDeduped++
              deduped++
            }
          }
        }
        cursor = res.cursor
      } while (cursor)

      console.log(`     ${locOrders} orders → ${args.apply ? locIngested + ' ingested / ' + locDeduped + ' deduped' : locIngested + ' would ingest'}${locDeadLetters > 0 ? ` (${locDeadLetters} dead-lettered)` : ''}`)
      perLocation.push({ name: location.name, orders: locOrders, ingested: locIngested, deduped: locDeduped, deadLetters: locDeadLetters })
    }

    console.log('\nSummary')
    console.log(`  ${orders} orders scanned across ${locations.length} locations`)
    if (args.apply) {
      console.log(`  ${ingested} SALE events appended`)
      console.log(`  ${deduped} events already present (idempotency dedupe)`)
    } else {
      console.log(`  ${ingested} SALE events would be appended`)
    }
    if (deadLetters > 0) {
      console.log(`  ${deadLetters} line(s) dead-lettered — usually an unmapped catalog object (sandbox vs production ID mismatch)`)
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
