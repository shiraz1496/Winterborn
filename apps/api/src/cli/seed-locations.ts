import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The API package doesn't own its own .env; the repo-root .env is
// authoritative, matching how apps/api/src/main.ts and the other CLIs
// reach it. Loading `dotenv/config` alone would look in cwd (which
// `pnpm --filter api` sets to apps/api/), which is empty, hence the
// explicit path.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
import { PrismaClient, type LocationKind } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Seeds the warehouse plus every market Winterborn currently operates.
 * Kept as a plain list here rather than an env variable so a fresh
 * `prisma migrate reset` produces a working environment in one command
 * -- the alternative (source-of-truth in .env) means every new developer
 * has to know which env var to set before the app is useful.
 *
 * Idempotent: rows are matched by name and upserted, so a re-run either
 * refills what a reset dropped or updates a timezone in place. Nothing
 * here writes ledger events, boxes, requests, or thresholds -- those
 * are seeded by the Sortly import (INTAKE + Threshold from Min Level)
 * and by the app's own flows.
 */
interface LocationSpec {
  name: string
  kind: LocationKind
  timezone: string
}

const LOCATIONS: LocationSpec[] = [
  { name: 'Main Warehouse', kind: 'WAREHOUSE', timezone: 'America/Denver' },
  { name: 'Atlanta', kind: 'MARKET', timezone: 'America/New_York' },
  // Aurora IL (Chicago suburb). Aurora CO would collide with Denver.
  { name: 'Aurora', kind: 'MARKET', timezone: 'America/Chicago' },
  { name: 'Baltimore', kind: 'MARKET', timezone: 'America/New_York' },
  { name: 'Boston (Snowport)', kind: 'MARKET', timezone: 'America/New_York' },
  // Carmel IN (Christkindlmarkt), not Carmel CA.
  { name: 'Carmel', kind: 'MARKET', timezone: 'America/Indiana/Indianapolis' },
  { name: 'Chicago (Daley Plaza)', kind: 'MARKET', timezone: 'America/Chicago' },
  { name: 'Chicago (Wrigley)', kind: 'MARKET', timezone: 'America/Chicago' },
  { name: 'Cullman, AL', kind: 'MARKET', timezone: 'America/Chicago' },
  { name: 'Denver', kind: 'MARKET', timezone: 'America/Denver' },
  { name: 'Grand Rapids', kind: 'MARKET', timezone: 'America/Detroit' },
  { name: 'Philadelphia', kind: 'MARKET', timezone: 'America/New_York' },
  { name: 'Savannah, GA', kind: 'MARKET', timezone: 'America/New_York' },
  { name: 'Seattle', kind: 'MARKET', timezone: 'America/Los_Angeles' },
  { name: 'Washington DC', kind: 'MARKET', timezone: 'America/New_York' },
]

async function main(): Promise<void> {
  for (const spec of LOCATIONS) {
    const row = await prisma.location.upsert({
      where: { name: spec.name },
      create: { name: spec.name, kind: spec.kind, timezone: spec.timezone },
      update: { kind: spec.kind, timezone: spec.timezone },
    })
    console.log(`seeded ${spec.kind.padEnd(9)} ${spec.name.padEnd(24)} tz=${spec.timezone.padEnd(32)} id=${row.id}`)
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
