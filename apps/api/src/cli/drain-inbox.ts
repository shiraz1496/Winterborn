import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { InboxWorker } from '../square/inbox.worker.js'
import { fetchOrder } from '../square/square-client.js'

/**
 * `cli:drain-inbox` -- the long-running process behind render.yaml's
 * "background worker draining the inbox" service (spec §7.1/§9.6).
 * `WebhookController` only ever inserts `SquareInboxEvent` rows and
 * returns 200; something has to actually call `InboxWorker.processOne()`
 * off the request path, on a schedule, forever. This is that something:
 * a plain interval loop, not a queue library -- there is no BullMQ (or
 * any other job queue) wired into this codebase despite REDIS_URL
 * existing in `.env.example` as a same-box `docker-compose` convenience;
 * do not assume Redis is load-bearing here.
 *
 * `INBOX_DRAIN_INTERVAL_MS` (default 10s) trades ingest latency against
 * database load from an empty-backlog poll -- 10s keeps the dashboard's
 * inbox backlog depth (`GET /health`) from ever growing large under
 * normal Square webhook delivery, without hammering Postgres once a
 * second doing nothing.
 */
const INTERVAL_MS = Number(process.env.INBOX_DRAIN_INTERVAL_MS ?? 10_000)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const prisma = new PrismaService()
  await prisma.$connect()
  const ledger = new LedgerService(prisma)
  const worker = new InboxWorker(prisma, ledger, fetchOrder)

  console.log(`cli:drain-inbox started, polling SquareInboxEvent every ${INTERVAL_MS}ms`)

  let shuttingDown = false
  const shutdown = () => {
    shuttingDown = true
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  while (!shuttingDown) {
    try {
      const result = await worker.processOne()
      if (result.processed > 0 || result.failed > 0 || result.deadLettered > 0) {
        console.log(`drain pass: processed=${result.processed} failed=${result.failed} deadLettered=${result.deadLettered}`)
      }
    } catch (err) {
      // One bad pass must not kill the worker -- the next interval tries
      // again, same as InboxWorker.processOne() leaving a failed row's
      // processedAt unset so it is simply retried.
      console.error('drain-inbox pass failed:', err)
    }
    await sleep(INTERVAL_MS)
  }

  await prisma.$disconnect()
  console.log('cli:drain-inbox shut down cleanly')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
