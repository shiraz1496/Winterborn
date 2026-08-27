import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import type { Square } from 'square'
import { saleKey } from '@winterborn/shared'
import { AppModule } from '../src/app.module.js'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { LedgerService } from '../src/ledger/ledger.service.js'
import { InboxWorker } from '../src/square/inbox.worker.js'
import { mapOrderToLedgerInputs } from '../src/square/order-mapper.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'

const SIGNING_KEY = 'test-signing-key'
const NOTIFICATION_URL = 'https://example.test/square/webhook'
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = SIGNING_KEY
process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = NOTIFICATION_URL

function sign(rawBody: string): string {
  return createHmac('sha256', SIGNING_KEY).update(NOTIFICATION_URL + rawBody).digest('base64')
}

// ---------------------------------------------------------------------------
// mapOrderToLedgerInputs -- pure, no DB, fixtures built by hand.
// ---------------------------------------------------------------------------
describe('mapOrderToLedgerInputs', () => {
  const resolveCatalog = (id: string) =>
    id === 'sq_var_1'
      ? { variationId: 'variation_1' }
      : id === 'sq_var_2'
        ? { variationId: 'variation_2' }
        : id === 'sq_wv_1'
          ? { variationId: 'variation_1', warehouseVariantId: 'warehouse_variant_1' }
          : undefined
  const resolveLocation = (id: string): string | undefined => (id === 'sq_loc_1' ? 'location_1' : undefined)

  it('maps a two-line order to two negative-quantity SALE events keyed by saleKey(orderId, lineUid)', () => {
    const order = {
      id: 'order_abc',
      state: 'COMPLETED',
      locationId: 'sq_loc_1',
      updatedAt: '2025-12-07T14:00:00Z',
      lineItems: [
        { uid: 'line_1', catalogObjectId: 'sq_var_1', quantity: '2' },
        { uid: 'line_2', catalogObjectId: 'sq_var_2', quantity: '1' },
      ],
    } as unknown as Square.Order

    const { events, deadLetters } = mapOrderToLedgerInputs(order, resolveCatalog, resolveLocation, 'WEBHOOK')

    expect(deadLetters).toHaveLength(0)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'SALE',
      locationId: 'location_1',
      variationId: 'variation_1',
      quantity: -2,
      idempotencyKey: saleKey('order_abc', 'line_1'),
    })
    expect(events[1]).toMatchObject({
      type: 'SALE',
      variationId: 'variation_2',
      quantity: -1,
      idempotencyKey: saleKey('order_abc', 'line_2'),
    })
  })

  it('dead-letters a line whose catalogObjectId matches no known Variation, without throwing or dropping the order', () => {
    const order = {
      id: 'order_def',
      state: 'COMPLETED',
      locationId: 'sq_loc_1',
      lineItems: [
        { uid: 'line_1', catalogObjectId: 'sq_var_1', quantity: '1' },
        { uid: 'line_2', catalogObjectId: 'sq_var_unknown', quantity: '1' },
      ],
    } as unknown as Square.Order

    const { events, deadLetters } = mapOrderToLedgerInputs(order, resolveCatalog, resolveLocation, 'WEBHOOK')

    expect(events).toHaveLength(1)
    expect(events[0]?.idempotencyKey).toBe(saleKey('order_def', 'line_1'))
    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0]).toMatchObject({
      orderId: 'order_def',
      lineUid: 'line_2',
      catalogObjectId: 'sq_var_unknown',
    })
  })

  it('carries warehouseVariantId on the SALE event when the resolver returns a per-SKU match', () => {
    // sq_wv_1 is the variant-level mapping fixture (WarehouseVariant.squareVariationId
    // for Earmuffs / Black, say). sq_var_1 is the family-level fallback that leaves
    // warehouseVariantId undefined — both must coexist without one clobbering the other.
    const order = {
      id: 'order_var_1',
      state: 'COMPLETED',
      locationId: 'sq_loc_1',
      lineItems: [
        { uid: 'line_family', catalogObjectId: 'sq_var_1', quantity: '1' },
        { uid: 'line_variant', catalogObjectId: 'sq_wv_1', quantity: '2' },
      ],
    } as unknown as Square.Order

    const { events } = mapOrderToLedgerInputs(order, resolveCatalog, resolveLocation, 'WEBHOOK')

    const familyEvent = events.find((e) => e.idempotencyKey === saleKey('order_var_1', 'line_family'))
    const variantEvent = events.find((e) => e.idempotencyKey === saleKey('order_var_1', 'line_variant'))
    expect(familyEvent).toMatchObject({ variationId: 'variation_1', warehouseVariantId: undefined })
    expect(variantEvent).toMatchObject({
      variationId: 'variation_1',
      warehouseVariantId: 'warehouse_variant_1',
      quantity: -2,
    })
  })

  it('drops OPEN / CANCELED / DRAFT orders — only COMPLETED writes SALE events', () => {
    const openOrder = {
      id: 'order_open',
      state: 'OPEN',
      locationId: 'sq_loc_1',
      lineItems: [{ uid: 'l', catalogObjectId: 'sq_var_1', quantity: '1' }],
    } as unknown as Square.Order

    const { events } = mapOrderToLedgerInputs(openOrder, resolveCatalog, resolveLocation, 'WEBHOOK')
    expect(events).toHaveLength(0)
  })

  it('maps a refund line to a positive-quantity SALE event with a distinct key, not a skipped one', () => {
    const order = {
      id: 'order_ghi',
      state: 'COMPLETED',
      locationId: 'sq_loc_1',
      lineItems: [{ uid: 'line_1', catalogObjectId: 'sq_var_1', quantity: '2' }],
      returns: [
        {
          returnLineItems: [
            { uid: 'return_line_1', sourceLineItemUid: 'line_1', catalogObjectId: 'sq_var_1', quantity: '1' },
          ],
        },
      ],
    } as unknown as Square.Order

    const { events, deadLetters } = mapOrderToLedgerInputs(order, resolveCatalog, resolveLocation, 'WEBHOOK')

    expect(deadLetters).toHaveLength(0)
    expect(events).toHaveLength(2)
    const refundEvent = events.find((e) => e.quantity > 0)
    expect(refundEvent).toBeDefined()
    expect(refundEvent?.idempotencyKey).toBe(saleKey('order_ghi', 'return_line_1'))
    expect(refundEvent?.idempotencyKey).not.toBe(saleKey('order_ghi', 'line_1'))
  })
})

// ---------------------------------------------------------------------------
// InboxWorker.processOne -- real DB, fake order fetcher.
// ---------------------------------------------------------------------------
describe('InboxWorker.processOne', () => {
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
  })

  it('appends mapped events through LedgerService and marks the row processed', async () => {
    await prisma.variation.update({ where: { id: seed.variationId }, data: { squareVariationId: 'sq_var_A' } })

    const fakeOrder = {
      id: 'order_worker_1',
      state: 'COMPLETED',
      locationId: 'SQ_DEN',
      updatedAt: '2025-12-07T14:00:00Z',
      lineItems: [{ uid: 'line_1', catalogObjectId: 'sq_var_A', quantity: '3' }],
    } as unknown as Square.Order

    await prisma.squareInboxEvent.create({
      data: {
        squareEventId: 'evt_worker_1',
        eventType: 'order.created',
        payload: { data: { type: 'order', id: 'order_worker_1', object: { order: { id: 'order_worker_1' } } } },
      },
    })

    const worker = new InboxWorker(prisma, ledger, async (orderId) => {
      expect(orderId).toBe('order_worker_1')
      return fakeOrder
    })

    const result = await worker.processOne()
    expect(result).toEqual({ processed: 1, failed: 0, deadLettered: 0 })

    const rows = await prisma.ledgerEvent.findMany({
      where: { idempotencyKey: saleKey('order_worker_1', 'line_1') },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ quantity: -3, source: 'WEBHOOK' })

    const inboxRow = await prisma.squareInboxEvent.findUnique({ where: { squareEventId: 'evt_worker_1' } })
    expect(inboxRow?.processedAt).not.toBeNull()
  })

  it('dead-letters an unmapped catalogObjectId but still marks the row processed, error visible', async () => {
    const fakeOrder = {
      id: 'order_worker_2',
      state: 'COMPLETED',
      locationId: 'SQ_DEN',
      lineItems: [{ uid: 'line_1', catalogObjectId: 'sq_var_unknown', quantity: '1' }],
    } as unknown as Square.Order

    await prisma.squareInboxEvent.create({
      data: {
        squareEventId: 'evt_worker_2',
        eventType: 'order.created',
        payload: { data: { type: 'order', id: 'order_worker_2', object: { order: { id: 'order_worker_2' } } } },
      },
    })

    const worker = new InboxWorker(prisma, ledger, async () => fakeOrder)
    const result = await worker.processOne()

    expect(result).toEqual({ processed: 1, failed: 0, deadLettered: 1 })
    const inboxRow = await prisma.squareInboxEvent.findUnique({ where: { squareEventId: 'evt_worker_2' } })
    expect(inboxRow?.processedAt).not.toBeNull()
    expect(inboxRow?.error).toContain('sq_var_unknown')
    expect(await prisma.ledgerEvent.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// POST /square/webhook -- real HTTP, real signature bytes, real DB.
// ---------------------------------------------------------------------------
describe('POST /square/webhook', () => {
  let app: INestApplication
  let prisma: PrismaService
  let baseUrl: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
    await app.listen(0)
    baseUrl = await app.getUrl()
    prisma = app.get(PrismaService)
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(async () => {
    await seedDevCatalog(prisma)
  })

  it('accepts a correctly signed payload: 200, exactly one SquareInboxEvent row, nothing else', async () => {
    const payload = {
      event_id: 'evt_signed_1',
      type: 'order.created',
      data: { type: 'order', id: 'order_signed_1', object: { order: { id: 'order_signed_1' } } },
    }
    const rawBody = JSON.stringify(payload)

    const res = await fetch(`${baseUrl}/square/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sign(rawBody) },
      body: rawBody,
    })

    expect(res.status).toBe(200)
    const rows = await prisma.squareInboxEvent.findMany({ where: { squareEventId: 'evt_signed_1' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.processedAt).toBeNull()
    expect(await prisma.ledgerEvent.count()).toBe(0)
  })

  it('rejects a tampered body with 401 and writes nothing', async () => {
    const payload = { event_id: 'evt_tampered_1', type: 'order.created', data: { type: 'order', id: 'order_x' } }
    const rawBody = JSON.stringify(payload)
    const validSignature = sign(rawBody)
    // Signature was computed over the original bytes; the body actually
    // sent differs by one field, so it must not verify.
    const tamperedBody = JSON.stringify({ ...payload, event_id: 'evt_tampered_1_HACKED' })

    const res = await fetch(`${baseUrl}/square/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': validSignature },
      body: tamperedBody,
    })

    expect(res.status).toBe(401)
    expect(await prisma.squareInboxEvent.count()).toBe(0)
  })

  it('re-delivering the same event_id writes one row, not two', async () => {
    const payload = { event_id: 'evt_redelivered', type: 'order.updated', data: { type: 'order', id: 'order_y' } }
    const rawBody = JSON.stringify(payload)
    const signature = sign(rawBody)

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/square/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
        body: rawBody,
      })
      expect(res.status).toBe(200)
    }

    const rows = await prisma.squareInboxEvent.findMany({ where: { squareEventId: 'evt_redelivered' } })
    expect(rows).toHaveLength(1)
  })
})
