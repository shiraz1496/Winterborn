import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })
import { PrismaClient } from '@prisma/client'

/**
 * Truncate every table except User + Session, so we can re-seed the catalog
 * cleanly from the Sortly xlsx without wiping login credentials or logging
 * everyone out. Deliberately does NOT drop or alter schema — that's Prisma
 * migrations' job. Cascades through FKs in one transaction.
 *
 * Refuses to run unless RESET_DB_CONFIRM=yes is set, so a stray CLI call
 * on a shared environment can't wipe production catalog by accident.
 */

const KEEP_TABLES = ['User', 'Session']

async function main(): Promise<void> {
  if (process.env.RESET_DB_CONFIRM !== 'yes') {
    console.error('Refusing to run. Set RESET_DB_CONFIRM=yes to actually truncate.')
    console.error('Preserves User + Session; wipes everything else.')
    process.exit(1)
  }

  const prisma = new PrismaClient()
  await prisma.$connect()

  try {
    const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT LIKE '_prisma%'
    `
    const tablesToTruncate = rows.map((r) => r.tablename).filter((t) => !KEEP_TABLES.includes(t))

    console.log(`Truncating ${tablesToTruncate.length} tables (keeping ${KEEP_TABLES.join(', ')})…`)

    // Single TRUNCATE with CASCADE handles the FK ordering for us; RESTART
    // IDENTITY resets any serial sequences (cuids don't use them, but harmless).
    const quoted = tablesToTruncate.map((t) => `"${t}"`).join(', ')
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`)

    const remaining = await prisma.user.count()
    console.log(`Done. ${remaining} users preserved.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
