import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
import { PrismaClient } from '@prisma/client'

/// Wipe every catalog table (and downstream ledger / boxes / requests
/// that reference them) so the xlsx importer can rebuild the folder tree
/// from a clean slate. Uses TRUNCATE ... CASCADE — the ledger's
/// append-only DELETE trigger fires per-row, TRUNCATE bypasses it, same
/// technique reset-db-keep-users.ts uses.
///
/// Preserves: User, Session, Location, and the Square catalog cache
/// (independent of our own catalog). Wipes everything downstream of
/// Category so the reseed lands on empty tables.
///
/// Guarded by --confirm so an accidental run in production is a no-op.

const CONFIRM_FLAG = '--confirm'

/// Order doesn't matter for TRUNCATE ... CASCADE — Postgres walks FKs
/// itself. Explicit list is safer than "everything except X" so a future
/// unrelated table (e.g. a new billing table) doesn't get accidentally
/// swept up.
const TABLES = [
  'LedgerEvent',
  'BoxLine',
  'Box',
  'Load',
  'RestockRequestLine',
  'RestockRequest',
  'Threshold',
  'WarehouseVariantAttribute',
  'WarehouseVariant',
  'Variation',
  'ProductAttributeValue',
  'ProductAttribute',
  'ItemGroup',
  'ColourVariant',
  'ColourFamily',
  'SizeOption',
  'Category',
]

async function main(): Promise<void> {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.error('reset-catalog is destructive. Re-run with --confirm to actually wipe.')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  await prisma.$connect()

  try {
    const quoted = TABLES.map((t) => `"${t}"`).join(', ')
    console.log(`Truncating ${TABLES.length} tables (CASCADE)…`)
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`)
    console.log('Done. Re-run `pnpm cli:import-sortly-xlsx` to seed from data/sortly-export.xlsx.')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
