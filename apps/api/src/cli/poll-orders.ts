import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { PollService } from '../square/poll.service.js'
import { searchOrders } from '../square/square-client.js'

/**
 * `cli:poll-orders` -- runs one reconciliation pass over every active
 * market location (spec §7.2). Intended to be invoked on a schedule (a
 * Render cron job every 20 minutes in production); this CLI is that
 * entrypoint run manually or from cron.
 */
async function main(): Promise<void> {
  const prisma = new PrismaService()
  await prisma.$connect()
  const ledger = new LedgerService(prisma)
  const poll = new PollService(prisma, ledger, searchOrders)

  try {
    const results = await poll.pollAll()

    let ingested = 0
    let deduped = 0
    let failed = 0
    console.log('\nSquare reconciliation poll')
    for (const r of results) {
      if (r.result) {
        ingested += r.result.ingested
        deduped += r.result.deduped
        console.log(`  ${r.locationId}  ingested=${r.result.ingested}  deduped=${r.result.deduped}`)
      } else {
        failed++
        console.log(`  ${r.locationId}  FAILED: ${r.error}`)
      }
    }
    console.log(`\n  locations: ${results.length}  ingested: ${ingested}  deduped: ${deduped}  failed: ${failed}\n`)

    if (failed > 0) process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
