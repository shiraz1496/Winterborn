import './load-env.js'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * One-off: reclassify AuditLog rows that landed with source=SYSTEM because
 * they were written before the source column existed, or because the
 * writing CLI didn't pass source explicitly. SYSTEM is retained as the
 * schema default, but "SYSTEM with an actor logged in" is a contradiction
 * — a real actor implies a UI/API interaction. And rows matching the SKU
 * colour-strip migration pattern are almost certainly `cli:migrate-warehouse-skus`.
 *
 * Runs dry by default. Pass `--apply` to write.
 */

/// Regex for the pre-migration SKU format (`WV-<UPPER>-<8hex>`). Matches
/// anything the migration script actually rewrote.
const OLD_SKU_FORMAT = /^WV-[A-Z0-9-]+-[a-f0-9]{8}$/
const NEW_SKU_FORMAT = /^WV-[a-f0-9]{8}$/

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const prisma = new PrismaService()
  await prisma.$connect()
  try {
    const rows = await prisma.auditLog.findMany({
      where: { source: 'SYSTEM' },
      select: {
        id: true,
        actorId: true,
        field: true,
        oldValue: true,
        newValue: true,
      },
    })

    const toUi: string[] = []
    const toMigration: string[] = []

    for (const r of rows) {
      // A real actor logged in and did something → not SYSTEM.
      if (r.actorId) {
        toUi.push(r.id)
        continue
      }
      // Anonymous SKU rewrite that matches the migration signature.
      if (
        r.field === 'warehouseSku' &&
        r.oldValue &&
        r.newValue &&
        OLD_SKU_FORMAT.test(r.oldValue) &&
        NEW_SKU_FORMAT.test(r.newValue)
      ) {
        toMigration.push(r.id)
        continue
      }
      // Anything else stays as SYSTEM — genuinely no known origin.
    }

    console.log('\nAuditLog source reclassification')
    console.log(`  ${rows.length} rows currently marked SYSTEM`)
    console.log(`  → UI:        ${toUi.length}  (actor was set)`)
    console.log(`  → MIGRATION: ${toMigration.length}  (SKU colour-strip pattern)`)
    console.log(`  → left as SYSTEM: ${rows.length - toUi.length - toMigration.length}`)

    if (!apply) {
      console.log('\nDry run — pass --apply to write.')
      return
    }

    if (toUi.length > 0) {
      await prisma.auditLog.updateMany({
        where: { id: { in: toUi } },
        data: { source: 'UI' },
      })
    }
    if (toMigration.length > 0) {
      await prisma.auditLog.updateMany({
        where: { id: { in: toMigration } },
        data: { source: 'MIGRATION' },
      })
    }

    console.log(`\nApplied. ${toUi.length + toMigration.length} rows updated.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
