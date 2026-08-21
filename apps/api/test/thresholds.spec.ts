import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { saleKey, transferKeyPrefix } from '@winterborn/shared'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { LedgerService } from '../src/ledger/ledger.service.js'
import { LedgerReadService } from '../src/ledger/ledger-read.service.js'
import { AuditService } from '../src/requests/audit.service.js'
import { ThresholdsService } from '../src/thresholds/thresholds.service.js'
import { VelocitySeeder } from '../src/thresholds/velocity-seeder.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/velocity-seed-sample')

const prisma = new PrismaService()
const ledger = new LedgerService(prisma)
const ledgerRead = new LedgerReadService(prisma)
const thresholds = new ThresholdsService(prisma, ledgerRead, new AuditService())
const seeder = new VelocitySeeder(prisma)

let seed: DevSeed

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  seed = await seedDevCatalog(prisma)
})

/** Moves `qty` units of the seeded warehouse variant from the warehouse to Denver so a test can start from a known on-hand figure. */
async function stockDenver(qty: number, ref: string): Promise<void> {
  await ledger.transfer({
    fromLocationId: seed.warehouseId,
    toLocationId: seed.denverId,
    variationId: seed.variationId,
    warehouseVariantId: seed.warehouseVariantId,
    quantity: qty,
    occurredAt: new Date('2025-11-01T00:00:00Z'),
    source: 'UI',
    idempotencyKeyPrefix: transferKeyPrefix('dispatch', ref),
  })
}

async function sell(qty: number, ref: string): Promise<void> {
  await ledger.append({
    type: 'SALE',
    locationId: seed.denverId,
    variationId: seed.variationId,
    quantity: -qty,
    occurredAt: new Date('2025-11-02T00:00:00Z'),
    source: 'UI',
    idempotencyKey: saleKey('test-order', ref),
  })
}

describe('ThresholdsService.evaluate -- auto-draft and dedupe (spec §9.7)', () => {
  it('does nothing while above threshold, drafts exactly once on breach, dedupes a repeat evaluation, and drafts again once the first draft is closed and stock drops again', async () => {
    await prisma.threshold.create({
      data: { variationId: seed.variationId, locationId: seed.denverId, minLevel: 5, source: 'SEEDED' },
    })

    // Above threshold: 10 on hand, minLevel 5 -- nothing happens.
    await stockDenver(10, 'stock-1')
    const above = await thresholds.evaluate(seed.variationId, seed.denverId)
    expect(above.breached).toBe(false)
    expect(above.created).toBe(false)
    expect(await prisma.restockRequest.count()).toBe(0)

    // Sell down to 4, below the minLevel of 5 -- exactly one draft line.
    await sell(6, 'line-1')
    const first = await thresholds.evaluate(seed.variationId, seed.denverId)
    expect(first.breached).toBe(true)
    expect(first.created).toBe(true)
    expect(first.onHand).toBe(4)
    expect(first.requestId).toBeTruthy()

    const requestsAfterFirst = await prisma.restockRequest.findMany({ include: { lines: true } })
    expect(requestsAfterFirst).toHaveLength(1)
    expect(requestsAfterFirst[0]!.createdFrom).toBe('THRESHOLD')
    expect(requestsAfterFirst[0]!.state).toBe('DRAFT')
    expect(requestsAfterFirst[0]!.lines).toHaveLength(1)
    expect(requestsAfterFirst[0]!.lines[0]!.variationId).toBe(seed.variationId)

    // Evaluating again with no ledger change creates nothing extra -- the
    // dedupe guarantee: a busy Sunday re-evaluating the same breach must
    // never stack a second draft line.
    const second = await thresholds.evaluate(seed.variationId, seed.denverId)
    expect(second.created).toBe(false)
    expect(second.requestId).toBe(first.requestId)
    expect(second.lineId).toBe(first.lineId)
    expect(await prisma.restockRequestLine.count()).toBe(1)
    expect(await prisma.restockRequest.count()).toBe(1)

    // Close the draft, then drop stock further -- a fresh breach on a
    // location with no open THRESHOLD request must open a new one.
    await prisma.restockRequest.update({ where: { id: first.requestId! }, data: { state: 'CLOSED', closedAt: new Date() } })
    await sell(1, 'line-2')
    const third = await thresholds.evaluate(seed.variationId, seed.denverId)
    expect(third.breached).toBe(true)
    expect(third.created).toBe(true)
    expect(third.requestId).not.toBe(first.requestId)

    expect(await prisma.restockRequest.count()).toBe(2)
  })
})

describe('VelocitySeeder.seedFromSeason', () => {
  it('computes a sane min level per (item, location) from the fixture, never a negative one', async () => {
    const result = await seeder.seedFromSeason(FIXTURE_DIR)

    // Denver: week 1 sells 3 (2+1), week 2 nets 5 (4+3-2) -- peak is 5.
    // Boston: a single week-1 sale of 1, floored at PEAK_WEEK_FLOOR (2).
    // Chicago: week 2 is a pure refund (net -3, floored per-week at 0)
    //   -- the floor is exactly what proves the "never negative" property.
    // "Unknown Product" matches no seeded ItemGroup and is left unresolved.
    expect(result.pairsResolved).toBe(3)
    expect(result.pairsUnresolved).toBe(1)

    const rows = await prisma.threshold.findMany()
    // Two Variations (Blue, Gray) under "Scarf (Stripes)" x three resolved locations.
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.minLevel).toBeGreaterThan(0)
      expect(row.source).toBe('SEEDED')
    }

    const denverThresholds = rows.filter((r) => r.locationId === seed.denverId)
    expect(denverThresholds.every((r) => r.minLevel === 5)).toBe(true)

    const nonDenver = rows.filter((r) => r.locationId !== seed.denverId)
    // Boston (peak 1) and Chicago (peak 0, all-refund) both floor to 2.
    expect(nonDenver.every((r) => r.minLevel === 2)).toBe(true)

    expect(result.topTen[0]).toMatchObject({ itemGroupName: 'Scarf (Stripes)', minLevel: 5 })
  })
})
