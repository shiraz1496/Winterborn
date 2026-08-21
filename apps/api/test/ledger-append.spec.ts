import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { saleKey, transferKeyPrefix } from '@winterborn/shared'
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
      idempotencyKey: saleKey('order_1', 'line_1'),
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

  it('rejects a ledger row referencing a variation that does not exist', async () => {
    // Before the FK existed this inserted silently, skewed every derivation
    // that touched the variation, and could not be deleted because of the
    // append-only trigger. The only remedy was an offsetting CORRECTION plus
    // a permanent orphan in the event stream.
    await expect(
      ledger.append({
        type: 'SALE',
        locationId: seed.denverId,
        variationId: 'var_does_not_exist',
        quantity: -1,
        occurredAt: new Date(),
        source: 'WEBHOOK',
        idempotencyKey: saleKey('order_orphan', 'line_1'),
      }),
    ).rejects.toThrow()
    expect(await prisma.ledgerEvent.count()).toBe(0)
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
        idempotencyKey: saleKey('bad', '1'),
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
      idempotencyKeyPrefix: transferKeyPrefix('dispatch', 'box_1', 'wv_1'),
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
    // and silently destroy stock. Uses INTAKE, not DISPATCH: append() rejects
    // DISPATCH/RETURN outright (spec §5.4, they only ever come from
    // transfer()), and the collision only needs a matching idempotencyKey,
    // not a matching event type. The ':to' suffix is transfer()'s own
    // namespace (see transferKeyPrefix()'s doc comment) — this is the one
    // deliberate collision into it, to prove the transaction is real.
    const prefix = transferKeyPrefix('dispatch', 'box_2', 'wv_1')
    await ledger.append({
      type: 'INTAKE',
      locationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: 40,
      occurredAt: new Date(),
      source: 'UI',
      idempotencyKey: `${prefix}:to`,
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
        idempotencyKeyPrefix: prefix,
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
      idempotencyKeyPrefix: transferKeyPrefix('dispatch', 'box_3', 'wv_1'),
      type: 'DISPATCH' as const,
    }
    const first = await ledger.transfer(input)
    const again = await ledger.transfer(input)
    expect(again.created).toBe(false)
    expect(again.transferId).toBe(first.transferId)
    expect(await prisma.ledgerEvent.count()).toBe(2)
  })

  it('is idempotent under concurrent duplicate delivery', async () => {
    // Two callers race with the same idempotencyKeyPrefix (e.g. a retried
    // dispatch request). The loser must resolve gracefully with the winner's
    // transferId, not throw a raw unique-constraint error, and the race must
    // not produce a second pair of rows.
    const input = {
      fromLocationId: seed.warehouseId,
      toLocationId: seed.denverId,
      variationId: seed.variationId,
      warehouseVariantId: seed.warehouseVariantId,
      quantity: 7,
      occurredAt: new Date('2025-11-21T09:00:00Z'),
      source: 'UI' as const,
      idempotencyKeyPrefix: transferKeyPrefix('dispatch', 'box_4', 'wv_1'),
      type: 'DISPATCH' as const,
    }

    const results = await Promise.allSettled([ledger.transfer(input), ledger.transfer(input)])

    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]?.status).toBe('fulfilled')
    const transferIds = results.map((r) => (r.status === 'fulfilled' ? r.value.transferId : undefined))
    expect(transferIds[0]).toBeDefined()
    expect(transferIds[0]).toBe(transferIds[1])
    expect(await prisma.ledgerEvent.count()).toBe(2)
  })
})

describe('append-only constraint', () => {
  it('rejects UPDATE and DELETE against an existing row, and TRUNCATE still works', async () => {
    // The no-permanent-drift guarantee rests on the schema storing no
    // balance anywhere; this trigger is what stops an UPDATE or DELETE from
    // quietly rewriting history underneath that guarantee. Enforced at the
    // database level so it applies to a migration, a console session, or a
    // future service, not just to LedgerService's own discipline.
    const { id } = await ledger.append({
      type: 'SALE',
      locationId: seed.denverId,
      variationId: seed.variationId,
      quantity: -1,
      occurredAt: new Date('2025-11-21T09:00:00Z'),
      source: 'WEBHOOK',
      idempotencyKey: saleKey('append-only-test', '1'),
    })

    await expect(
      prisma.ledgerEvent.update({ where: { id }, data: { quantity: -2 } }), // sole-writer-guard:allow-trigger-test
    ).rejects.toThrow(/append-only/)

    await expect(prisma.ledgerEvent.delete({ where: { id } })).rejects.toThrow(/append-only/) // sole-writer-guard:allow-trigger-test

    // The row survived both attempts untouched.
    const row = await prisma.ledgerEvent.findUniqueOrThrow({ where: { id } })
    expect(row.quantity).toBe(-1)

    // TRUNCATE does not fire row-level triggers, so seedDevCatalog (which
    // truncates LedgerEvent among other tables between tests) must still work.
    await expect(seedDevCatalog(prisma)).resolves.toBeDefined()
    expect(await prisma.ledgerEvent.count()).toBe(0)
  })
})
