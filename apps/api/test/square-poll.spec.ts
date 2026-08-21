import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Square } from 'square'
import { saleKey } from '@winterborn/shared'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { LedgerService } from '../src/ledger/ledger.service.js'
import { PollService, type OrderSearcher } from '../src/square/poll.service.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'

const prisma = new PrismaService()
const ledger = new LedgerService(prisma)
let seed: DevSeed

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  seed = await seedDevCatalog(prisma)
  await prisma.variation.update({ where: { id: seed.variationId }, data: { squareVariationId: 'sq_var_A' } })
})

function fakeOrder(orderId: string): Square.Order {
  return {
    id: orderId,
    locationId: 'SQ_DEN',
    updatedAt: '2025-12-10T12:00:00Z',
    lineItems: [{ uid: 'line_1', catalogObjectId: 'sq_var_A', quantity: '1' }],
  } as unknown as Square.Order
}

describe('PollService.pollLocation -- self-heal', () => {
  it('ten sales already ingested by the webhook path, then a poll covering all thirty, yields thirty events and thirty rows', async () => {
    // Orders 1-10 "already ingested by the webhook path": appended directly
    // through LedgerService with the exact key the shared mapper would
    // build, source WEBHOOK -- standing in for InboxWorker having already
    // processed them (Task 1). The self-heal property being tested here is
    // that the poll, hitting the SAME orders again, must build the SAME
    // key and therefore dedupe rather than double-count.
    for (let i = 1; i <= 10; i++) {
      const orderId = `order_${i}`
      await ledger.append({
        type: 'SALE',
        locationId: seed.denverId,
        variationId: seed.variationId,
        quantity: -1,
        occurredAt: new Date('2025-12-10T12:00:00Z'),
        source: 'WEBHOOK',
        idempotencyKey: saleKey(orderId, 'line_1'),
      })
    }
    expect(await prisma.ledgerEvent.count()).toBe(10)

    // The poll's window covers all thirty orders: the ten already-ingested
    // ones plus twenty new ones.
    const allThirtyOrders = Array.from({ length: 30 }, (_, i) => fakeOrder(`order_${i + 1}`))
    const searchOrders: OrderSearcher = async () => ({ orders: allThirtyOrders, cursor: undefined })

    const poll = new PollService(prisma, ledger, searchOrders)
    const result = await poll.pollLocation(seed.denverId)

    expect(result.ingested).toBe(20)
    expect(result.deduped).toBe(10)

    const rows = await prisma.ledgerEvent.findMany()
    expect(rows).toHaveLength(30)
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(30)
  })
})

describe('PollService.pollLocation -- cursor advance semantics', () => {
  it('advances the cursor only after a full successful pass, so a mid-pagination failure re-scans instead of skipping', async () => {
    const seenStartAts: Array<string | undefined | null> = []

    // First attempt: page 1 succeeds and hands back a cursor, page 2 throws.
    const failingSearcher: OrderSearcher = async (req) => {
      seenStartAts.push(req.query?.filter?.dateTimeFilter?.updatedAt?.startAt)
      if (!req.cursor) {
        return { orders: [fakeOrder('order_1')], cursor: 'page-2' }
      }
      throw new Error('simulated mid-pagination failure')
    }

    const pollFailing = new PollService(prisma, ledger, failingSearcher)
    await expect(pollFailing.pollLocation(seed.denverId)).rejects.toThrow('simulated mid-pagination failure')

    // Order 1's line landed (append() is called per-order as pages stream
    // in), but the pass as a whole did not complete, so the cursor row
    // must not have been created/advanced.
    const cursorAfterFailure = await prisma.squareSyncCursor.findUnique({ where: { locationId: seed.denverId } })
    expect(cursorAfterFailure).toBeNull()

    // Retry: succeeds in one page. Because lastPolledAt was never set, the
    // `since` this retry computes must be identical to the failed attempt's
    // -- confirming the retry re-scans the same window rather than
    // advancing past whatever the failed pass didn't finish.
    const succeedingSearcher: OrderSearcher = async (req) => {
      seenStartAts.push(req.query?.filter?.dateTimeFilter?.updatedAt?.startAt)
      return { orders: [fakeOrder('order_1'), fakeOrder('order_2')], cursor: undefined }
    }
    const pollSucceeding = new PollService(prisma, ledger, succeedingSearcher)
    const result = await pollSucceeding.pollLocation(seed.denverId)

    expect(result.ingested + result.deduped).toBe(2)
    expect(seenStartAts[0]).toBe(seenStartAts[2])

    const cursorAfterSuccess = await prisma.squareSyncCursor.findUnique({ where: { locationId: seed.denverId } })
    expect(cursorAfterSuccess?.lastPolledAt).not.toBeNull()
    expect(cursorAfterSuccess?.cursor).toBeNull()
  })
})

describe('PollService.pollAll', () => {
  it('polls every active market location with a squareLocationId, skipping none silently', async () => {
    const searchOrders: OrderSearcher = async () => ({ orders: [], cursor: undefined })
    const poll = new PollService(prisma, ledger, searchOrders)
    const results = await poll.pollAll()

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ locationId: seed.denverId, result: { ingested: 0, deduped: 0 } })
  })
})
