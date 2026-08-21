import { resolve } from 'node:path'
import { PrismaService } from '../prisma/prisma.service.js'
import { VelocitySeeder } from '../thresholds/velocity-seeder.js'

/**
 * `cli:seed-thresholds -- --dir <path-to-item-detail-csvs>` -- seeds
 * `Threshold.minLevel` from real 2025 velocity per spec §9.7. Defaults to
 * `../../data/square-2025/item-detail`, resolved against `apps/api` (this
 * package's cwd under `pnpm --filter`), since that is the only real season
 * export in this repo.
 */
function parseArgs(argv: string[]): { dir: string } {
  const idx = argv.indexOf('--dir')
  const dir = idx === -1 ? '../../data/square-2025/item-detail' : argv[idx + 1]
  if (!dir) throw new Error('usage: cli:seed-thresholds -- --dir <path-to-item-detail-csvs>')
  return { dir }
}

async function main(): Promise<void> {
  const { dir } = parseArgs(process.argv.slice(2))
  const path = resolve(process.cwd(), dir)

  const prisma = new PrismaService()
  await prisma.$connect()
  const seeder = new VelocitySeeder(prisma)

  try {
    const startedAt = Date.now()
    const result = await seeder.seedFromSeason(path)
    const wallClockMs = Date.now() - startedAt

    console.log(`\nThreshold seeding: ${path}`)
    console.log(`  weeks read:              ${result.weeksRead}`)
    console.log(`  lines read:              ${result.linesRead}`)
    console.log(`  (item, location) pairs resolved:   ${result.pairsResolved}`)
    console.log(`  (item, location) pairs unresolved: ${result.pairsUnresolved}`)
    console.log(`  thresholds created:      ${result.thresholdsCreated}`)
    console.log(`  thresholds updated:      ${result.thresholdsUpdated}`)
    console.log(`  thresholds unchanged:    ${result.thresholdsUnchanged}`)
    console.log(`  thresholds skipped (MANUAL, left alone): ${result.thresholdsSkippedManual}`)
    console.log(`  wall clock:              ${(wallClockMs / 1000).toFixed(1)}s`)

    console.log(`\n  distribution (minLevel -> Threshold rows at that level):`)
    for (const [level, count] of Object.entries(result.distribution).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`    ${level.padStart(4)}  x${count}`)
    }

    console.log(`\n  top ten (item, location) pairs by minLevel:`)
    for (const t of result.topTen) {
      console.log(`    ${String(t.minLevel).padStart(4)}  ${t.itemGroupName} @ ${t.locationName}`)
    }
    console.log('')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
