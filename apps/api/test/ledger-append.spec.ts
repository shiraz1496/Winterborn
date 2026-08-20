import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { LedgerService } from '../src/ledger/ledger.service.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'

const prisma = new PrismaService()
const ledger = new LedgerService(prisma)
let seed: DevSeed

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })
beforeEach(async () => { seed = await seedDevCatalog(prisma) })

describe('append', () => {
  it('is idempotent under repeated delivery', async () => {
    const input = {
      type: 'SALE' as const,
      locationId: seed.denverId,
      variationId: seed.variationId,
      quantity: -2,
      occurredAt: new Date('2025-12-07T14:00:00Z'),
      source: 'WEBHOOK' as const,
      idempotencyKey: 'sale:order_1:line_1',
    }

    const first = await ledger.append(input)
    expect(first.created).toBe(true)

    // Square re-delivers. The poll then re-ingests the same order. Neither may
    // double-count, and the ledger is what everything downstream derives from.
    for (let i = 0; i < 25; i++) {
      const again = await ledger.append(input)
      expect(again.created).toBe(false)
      expect(again.id).toBe(first.id)
    }

    const rows = await prisma.ledgerEvent.findMany({ where: { idempotencyKey: input.idempotencyKey } })
    expect(rows).toHaveLength(1)
  })

  it('rejects a SALE carrying a warehouseVariantId', async () => {
    await expect(
      ledger.append({
        type: 'SALE',
        locationId: seed.denverId,
        variationId: seed.variationId,
        warehouseVariantId: seed.warehouseVariantId,
        quantity: -1,
        occurredAt: new Date(),
        source: 'WEBHOOK',
        idempotencyKey: 'sale:bad:1',
      } as never),
    ).rejects.toThrow()
    expect(await prisma.ledgerEvent.count()).toBe(0)
  })
})

describe('transfer', () => {
  it('writes exactly two rows sharing a transferId, signed by endpoint', async () => {
    const { transferId } = await ledger.transfer({
      fromLocationId: seed.warehouseId,
      toLocationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: 40,
      occurredAt: new Date('2025-11-21T09:00:00Z'),
      source: 'UI',
      idempotencyKeyPrefix: 'dispatch:box_1:wv_1',
      type: 'DISPATCH',
    })

    const rows = await prisma.ledgerEvent.findMany({
      where: { transferId },
      orderBy: { quantity: 'asc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.locationId).toBe(seed.warehouseId)
    expect(rows[0]?.quantity).toBe(-40)
    expect(rows[1]?.locationId).toBe(seed.denverId)
    expect(rows[1]?.quantity).toBe(40)
    expect(rows[0]?.warehouseVariantId).toBe(seed.warehouseVariantId)
  })

  it('is atomic: a failed second leg leaves no first leg behind', async () => {
    // Pre-insert the "to" leg's key so the transaction's second insert collides.
    // Without a transaction this would strand a negative row at the warehouse
    // and silently destroy stock.
    await ledger.append({
      type: 'DISPATCH',
      locationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: 40,
      occurredAt: new Date(),
      source: 'UI',
      idempotencyKey: 'dispatch:box_2:wv_1:to',
    })
    const before = await prisma.ledgerEvent.count()

    await expect(
      ledger.transfer({
        fromLocationId: seed.warehouseId,
        toLocationId: seed.denverId,
        variationId: seed.variationId,
        warehouseVariantId: seed.warehouseVariantId,
        quantity: 40,
        occurredAt: new Date(),
        source: 'UI',
        idempotencyKeyPrefix: 'dispatch:box_2:wv_1',
        type: 'DISPATCH',
      }),
    ).rejects.toThrow()

    expect(await prisma.ledgerEvent.count()).toBe(before)
  })

  it('is idempotent under repeated delivery', async () => {
    const input = {
      fromLocationId: seed.warehouseId,
      toLocationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: 15,
      occurredAt: new Date('2025-11-21T09:00:00Z'),
      source: 'UI' as const,
      idempotencyKeyPrefix: 'dispatch:box_3:wv_1',
      type: 'DISPATCH' as const,
    }
    const first = await ledger.transfer(input)
    const again = await ledger.transfer(input)
    expect(again.created).toBe(false)
    expect(again.transferId).toBe(first.transferId)
    expect(await prisma.ledgerEvent.count()).toBe(2)
  })
})
