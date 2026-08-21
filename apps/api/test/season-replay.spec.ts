import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { LedgerService } from '../src/ledger/ledger.service.js'
import { replaySeason } from '../src/cli/replay-season.js'
import { seedDevCatalog } from '../prisma/seed-dev.js'

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/season-replay-sample')

const prisma = new PrismaService()
const ledger = new LedgerService(prisma)

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  // seedDevCatalog's ItemGroup is literally named "Scarf (Stripes)" with
  // colour families Blue/Gray and a "Denver" market location, which is
  // exactly what the small hand-built fixture references -- no fuzzy
  // matching quirks to work around in this test.
  await seedDevCatalog(prisma)
})

describe('replaySeason', () => {
  it('replaying the same window twice produces the same counts and no duplicate rows', async () => {
    const first = await replaySeason(prisma, ledger, { dir: FIXTURE_DIR })

    expect(first.linesRead).toBe(4)
    expect(first.resolved).toBe(3)
    expect(first.unresolved).toBe(1)
    expect(first.created).toBe(3)
    expect(first.deduped).toBe(0)
    expect(first.unresolvedSamples).toContainEqual({ item: 'Unknown Product', pricePoint: 'Regular', count: 1 })

    const rowsAfterFirst = await prisma.ledgerEvent.count()
    expect(rowsAfterFirst).toBe(3)

    const second = await replaySeason(prisma, ledger, { dir: FIXTURE_DIR })

    expect(second.linesRead).toBe(first.linesRead)
    expect(second.resolved).toBe(first.resolved)
    expect(second.unresolved).toBe(first.unresolved)
    expect(second.created).toBe(0)
    expect(second.deduped).toBe(3)

    const rowsAfterSecond = await prisma.ledgerEvent.count()
    expect(rowsAfterSecond).toBe(3)
  })

  it('signs a refund line positive and a sale line negative, both resolved by item + price point name', async () => {
    await replaySeason(prisma, ledger, { dir: FIXTURE_DIR })

    const rows = await prisma.ledgerEvent.findMany({ orderBy: { sourceRef: 'asc' } })
    const sale = rows.find((r) => r.sourceRef === 'txn_1' && r.quantity === -2)
    const refund = rows.find((r) => r.sourceRef === 'txn_2')

    expect(sale).toBeDefined()
    expect(refund).toBeDefined()
    expect(refund?.quantity).toBe(1)
    expect(rows.every((r) => r.source === 'SCRIPT')).toBe(true)
  })
})
