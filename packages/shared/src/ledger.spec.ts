import { describe, it, expect } from 'vitest'
import {
  appendEventInputSchema,
  transferInputSchema,
  saleKey,
  writeOffKey,
  intakeKey,
  transferKeyPrefix,
} from './ledger.js'

describe('appendEventInputSchema', () => {
  it('accepts a sale with no warehouseVariantId', () => {
    const parsed = appendEventInputSchema.parse({
      type: 'SALE',
      locationId: 'loc_1',
      variationId: 'var_1',
      quantity: -2,
      occurredAt: '2025-12-07T14:00:00.000Z',
      source: 'WEBHOOK',
      idempotencyKey: saleKey('o1', 'l1'),
    })
    expect(parsed.warehouseVariantId).toBeUndefined()
    expect(parsed.occurredAt instanceof Date).toBe(true)
  })

  it('rejects a SALE that carries a warehouseVariantId', () => {
    // Sales arrive from Square at family level; a variant on a sale is a bug
    // upstream, and the ledger must not silently accept it. Spec §5.5.
    expect(() =>
      appendEventInputSchema.parse({
        type: 'SALE',
        locationId: 'loc_1',
        variationId: 'var_1',
        warehouseVariantId: 'wv_1',
        quantity: -1,
        occurredAt: '2025-12-07T14:00:00.000Z',
        source: 'WEBHOOK',
        idempotencyKey: saleKey('o1', 'l2'),
      }),
    ).toThrow()
  })

  it('rejects a zero quantity', () => {
    expect(() =>
      appendEventInputSchema.parse({
        type: 'INTAKE',
        locationId: 'loc_1',
        variationId: 'var_1',
        warehouseVariantId: 'wv_1',
        quantity: 0,
        occurredAt: '2025-12-07T14:00:00.000Z',
        source: 'UI',
        idempotencyKey: intakeKey('1'),
      }),
    ).toThrow()
  })

  it('rejects DISPATCH, since transfers must go through transferInputSchema', () => {
    // append() is a side door: nothing stops a caller writing a lone DISPATCH
    // with no counterpart and no transferId, which the derivation cannot
    // detect as broken and no replay can repair. Spec §5.4 requires DISPATCH
    // and RETURN to always be written in pairs by LedgerService.transfer().
    expect(() =>
      appendEventInputSchema.parse({
        type: 'DISPATCH',
        locationId: 'loc_1',
        variationId: 'var_1',
        warehouseVariantId: 'wv_1',
        quantity: 40,
        occurredAt: '2025-12-07T14:00:00.000Z',
        source: 'UI',
        idempotencyKey: transferKeyPrefix('dispatch', 'box_1', 'wv_1'),
      }),
    ).toThrow(/transfer/)
  })

  it('rejects RETURN, for the same reason as DISPATCH', () => {
    expect(() =>
      appendEventInputSchema.parse({
        type: 'RETURN',
        locationId: 'loc_1',
        variationId: 'var_1',
        warehouseVariantId: 'wv_1',
        quantity: 40,
        occurredAt: '2025-12-07T14:00:00.000Z',
        source: 'UI',
        idempotencyKey: transferKeyPrefix('return', 'box_1', 'wv_1'),
      }),
    ).toThrow(/transfer/)
  })

  it('requires a reason on WRITE_OFF', () => {
    expect(() =>
      appendEventInputSchema.parse({
        type: 'WRITE_OFF',
        locationId: 'loc_1',
        variationId: 'var_1',
        warehouseVariantId: 'wv_1',
        quantity: -1,
        occurredAt: '2025-12-07T14:00:00.000Z',
        source: 'UI',
        idempotencyKey: writeOffKey('1'),
      }),
    ).toThrow()
  })
})

describe('transferInputSchema', () => {
  it('rejects a transfer whose endpoints are the same location', () => {
    expect(() =>
      transferInputSchema.parse({
        fromLocationId: 'loc_1',
        toLocationId: 'loc_1',
        variationId: 'var_1',
        warehouseVariantId: 'wv_1',
        quantity: 10,
        occurredAt: '2025-12-07T14:00:00.000Z',
        source: 'UI',
        idempotencyKeyPrefix: transferKeyPrefix('dispatch', 'box_1'),
      }),
    ).toThrow()
  })

  it('requires a positive quantity, since direction comes from the endpoints', () => {
    expect(() =>
      transferInputSchema.parse({
        fromLocationId: 'loc_1',
        toLocationId: 'loc_2',
        variationId: 'var_1',
        warehouseVariantId: 'wv_1',
        quantity: -10,
        occurredAt: '2025-12-07T14:00:00.000Z',
        source: 'UI',
        idempotencyKeyPrefix: transferKeyPrefix('dispatch', 'box_1'),
      }),
    ).toThrow()
  })
})
