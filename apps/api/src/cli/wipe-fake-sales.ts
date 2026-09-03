import './load-env.js'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Nukes the entire `LedgerEvent` table. Use before reseeding
 * `/requests/suggest` test data so the engine sees a completely clean
 * slate — no stacked layers from prior seed runs, no reversal ghost rows,
 * no historical drift.
 *
 * How it works — TRUNCATE, not DELETE:
 *   The ledger has a `BEFORE UPDATE OR DELETE` trigger
 *   (migration 20260820064642_ledger_append_only) that blocks row-level
 *   deletes. TRUNCATE does NOT fire row-level triggers in Postgres, so
 *   it succeeds — this is called out explicitly in the trigger's own
 *   comment ("TRUNCATE is unaffected").
 *
 * What gets destroyed:
 *   - Every SALE (script AND real Square-sourced)
 *   - Every INTAKE (warehouse baseline AND paired-with-sale)
 *   - Every DISPATCH, RETURN, WRITE_OFF, CORRECTION — everything
 *   - Full history. After this runs, on-hand at every location = 0.
 *
 * What you'll need to do after:
 *   1. Reseed test data:
 *        pnpm --filter api cli:seed-suggest-test-data -- --apply
 *   2. If you had real Square data you cared about, backfill it again:
 *        pnpm --filter api cli:backfill-square-sales -- --start … --apply
 *
 * Safety:
 *   - Dry run by default (prints the counts, no writes).
 *   - `--apply` writes but ALSO refuses to run if there are any non-SCRIPT
 *     rows (real Square-sourced sales) unless `--force` is also passed.
 *     That's the "you're about to destroy real production data" gate.
 *
 * Usage:
 *   pnpm --filter api cli:wipe-fake-sales                    # dry run
 *   pnpm --filter api cli:wipe-fake-sales -- --apply         # dev/synthetic only
 *   pnpm --filter api cli:wipe-fake-sales -- --apply --force # override real-data guard
 */

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const force = process.argv.includes('--force')
  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    console.log(`\nWipe LedgerEvent  [${apply ? 'APPLY' : 'DRY RUN'}${force ? ', FORCE' : ''}]`)

    const [total, bySource] = await Promise.all([
      prisma.ledgerEvent.count(),
      prisma.ledgerEvent.groupBy({
        by: ['source', 'type'],
        _count: { _all: true },
      }),
    ])

    console.log(`\n  total rows: ${total}`)
    if (total === 0) {
      console.log('  nothing to wipe.')
      return
    }

    console.log('  by (source, type):')
    for (const row of bySource) {
      console.log(`    ${row.source.padEnd(8)} ${row.type.padEnd(10)}  ${row._count._all}`)
    }

    const nonScript = bySource.filter((r) => r.source !== 'SCRIPT').reduce((s, r) => s + r._count._all, 0)
    if (nonScript > 0) {
      console.log(`\n  ⚠  ${nonScript} row(s) are NOT script-sourced (came from Square webhook / poll / UI).`)
      console.log('     Truncating destroys them too — real sales history included.')
    }

    if (!apply) {
      console.log('\nDry run — pass --apply to write.')
      if (nonScript > 0) console.log('If you really mean it with real data present: --apply --force')
      return
    }

    if (nonScript > 0 && !force) {
      console.error(
        `\nRefusing to truncate: ${nonScript} non-SCRIPT row(s) present. ` +
          `Pass --force to override, or use a more targeted cleanup.`,
      )
      process.exitCode = 1
      return
    }

    // TRUNCATE bypasses the append-only row-level trigger by design (per
    // the trigger's own comment). No CASCADE needed — nothing references
    // LedgerEvent as a foreign key (LedgerEvent only holds outgoing FKs).
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerEvent"')

    console.log(`\n  truncated. ${total} row(s) removed. On-hand at every location is now zero.`)
    console.log('\nNext: reseed with')
    console.log('  pnpm --filter api cli:seed-suggest-test-data -- --apply')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
