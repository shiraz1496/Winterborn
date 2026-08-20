import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { LedgerService } from '../src/ledger/ledger.service.js'
import { LedgerReadService } from '../src/ledger/ledger-read.service.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'

const prisma = new PrismaService()
const ledger = new LedgerService(prisma)
const read = new LedgerReadService(prisma)
let seed: DevSeed

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })
beforeEach(async () => { seed = await seedDevCatalog(prisma) })

describe('derivation', () => {
  it('computes dispatched minus sold minus written off', async () => {
    await ledger.transfer({
      fromLocationId: seed.warehouseId,
      toLocationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: 40,
      occurredAt: new Date('2025-11-21T09:00:00Z'),
      source: 'UI',
      idempotencyKeyPrefix: 'dispatch:box_1:wv_1',
    })
    await ledger.append({
      type: 'SALE',
      locationId: seed.denverId,
      variationId: seed.variationId,
      quantity: -12,
      occurredAt: new Date('2025-11-23T15:00:00Z'),
      source: 'WEBHOOK',
      idempotencyKey: 'sale:o1:l1',
    })
    await ledger.append({
      type: 'WRITE_OFF',
      locationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: -3,
      occurredAt: new Date('2025-11-24T10:00:00Z'),
      source: 'UI',
      reason: 'DAMAGE',
      idempotencyKey: 'wo:1',
    })

    expect(await read.onHandFor(seed.variationId, seed.denverId)).toBe(25)
    // The warehouse gave up 40 and got nothing back.
    expect(await read.onHandFor(seed.variationId, seed.warehouseId)).toBe(-40)
  })

  it('keeps family and variant granularity separate', async () => {
    await ledger.transfer({
      fromLocationId: seed.warehouseId,
      toLocationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: 40,
      occurredAt: new Date(),
      source: 'UI',
      idempotencyKeyPrefix: 'dispatch:box_1:wv_1',
    })
    await ledger.append({
      type: 'SALE',
      locationId: seed.denverId,
      variationId: seed.variationId,
      quantity: -10,
      occurredAt: new Date(),
      source: 'POLL',
      idempotencyKey: 'sale:o2:l1',
    })

    const family = await read.onHandByFamily(seed.denverId)
    const familyRow = family.find((r) => r.variationId === seed.variationId)
    expect(familyRow?.onHand).toBe(30)

    // The sale carries no variant, so variant level still shows all 40 as sent.
    // This is the precision map in spec §5.5, not a bug: sent minus returned at
    // season close is what recovers variant-level sell-through.
    const variant = await read.onHandByVariant(seed.denverId)
    const variantRow = variant.find((r) => r.warehouseVariantId === seed.warehouseVariantId)
    expect(variantRow?.onHand).toBe(40)
  })

  it('returns a correcting event as a real adjustment', async () => {
    await ledger.append({
      type: 'SALE',
      locationId: seed.denverId,
      variationId: seed.variationId,
      quantity: -5,
      occurredAt: new Date(),
      source: 'WEBHOOK',
      idempotencyKey: 'sale:o3:l1',
    })
    await ledger.append({
      type: 'CORRECTION',
      locationId: seed.denverId,
      variationId: seed.variationId,
      quantity: 5,
      occurredAt: new Date(),
      source: 'UI',
      idempotencyKey: 'correction:sale:o3:l1',
      note: 'refunded',
    })
    expect(await read.onHandFor(seed.variationId, seed.denverId)).toBe(0)
  })
})

describe('replay property', () => {
  it('replaying from zero always equals the incremental result', async () => {
    // The guarantee the whole system rests on: a missed webhook, a duplicate
    // write or a bad deploy can never cause permanent drift, because nothing
    // is stored that cannot be recomputed. Generate random histories and
    // assert the two paths agree every time.
    const types = ['DISPATCH', 'SALE', 'WRITE_OFF', 'RETURN', 'CORRECTION'] as const
    let key = 0

    for (let round = 0; round < 40; round++) {
      seed = await seedDevCatalog(prisma)
      const opCount = 5 + (round % 12)

      for (let i = 0; i < opCount; i++) {
        const type = types[(round * 7 + i * 3) % types.length]!
        const useOther = (round + i) % 3 === 0
        const variationId = useOther ? seed.otherVariationId : seed.variationId
        const warehouseVariantId = useOther ? seed.otherWarehouseVariantId : seed.warehouseVariantId
        const magnitude = 1 + ((round * 5 + i * 11) % 37)
        const occurredAt = new Date(Date.UTC(2025, 10, 1 + (i % 27), 9 + (i % 12)))

        if (type === 'DISPATCH' || type === 'RETURN') {
          await ledger.transfer({
            fromLocationId: type === 'DISPATCH' ? seed.warehouseId : seed.denverId,
            toLocationId: type === 'DISPATCH' ? seed.denverId : seed.warehouseId,
            variationId,
            warehouseVariantId,
            quantity: magnitude,
            occurredAt,
            source: 'UI',
            idempotencyKeyPrefix: `t:${round}:${i}:${key++}`,
            type,
          })
        } else if (type === 'SALE') {
          await ledger.append({
            type: 'SALE',
            locationId: seed.denverId,
            variationId,
            quantity: -magnitude,
            occurredAt,
            source: i % 2 === 0 ? 'WEBHOOK' : 'POLL',
            idempotencyKey: `s:${round}:${i}:${key++}`,
          })
        } else if (type === 'WRITE_OFF') {
          await ledger.append({
            type: 'WRITE_OFF',
            locationId: seed.denverId,
            variationId,
            warehouseVariantId,
            quantity: -magnitude,
            occurredAt,
            source: 'UI',
            reason: 'DAMAGE',
            idempotencyKey: `w:${round}:${i}:${key++}`,
          })
        } else {
          await ledger.append({
            type: 'CORRECTION',
            locationId: seed.denverId,
            variationId,
            quantity: magnitude,
            occurredAt,
            source: 'UI',
            idempotencyKey: `c:${round}:${i}:${key++}`,
          })
        }
      }

      const incremental = await read.onHandByFamily()
      const replayed = await read.recompute()

      const norm = (rows: typeof incremental) =>
        rows
          .map((r) => `${r.locationId}|${r.variationId}|${r.onHand}`)
          .sort()
          .join('\n')

      expect(norm(replayed)).toBe(norm(incremental))
    }
  })

  it('self-heals a week of missed webhooks on one poll pass', async () => {
    // Simulate the real failure mode from spec §7.2: webhooks stop arriving,
    // the poll later re-ingests the same window, and the keys collide by design.
    const sales = Array.from({ length: 30 }, (_, i) => ({
      type: 'SALE' as const,
      locationId: seed.denverId,
      variationId: seed.variationId,
      quantity: -1,
      occurredAt: new Date(Date.UTC(2025, 11, 1 + (i % 7), 12)),
      idempotencyKey: `sale:order_${i}:line_1`,
    }))

    // Only the first ten arrived by webhook before the endpoint went down.
    for (const s of sales.slice(0, 10)) {
      await ledger.append({ ...s, source: 'WEBHOOK' })
    }
    const afterWebhooks = await read.onHandFor(seed.variationId, seed.denverId)
    expect(afterWebhooks).toBe(-10)

    // The poll re-scans the whole window, including what already landed.
    for (const s of sales) {
      await ledger.append({ ...s, source: 'POLL' })
    }

    expect(await read.onHandFor(seed.variationId, seed.denverId)).toBe(-30)
    expect(await prisma.ledgerEvent.count()).toBe(30)
  })
})
