import { z } from 'zod'

export const ledgerEventTypeSchema = z.enum([
  'INTAKE',
  'DISPATCH',
  'SALE',
  'WRITE_OFF',
  'RETURN',
  'CORRECTION',
])
export type LedgerEventType = z.infer<typeof ledgerEventTypeSchema>

export const ledgerSourceSchema = z.enum(['WEBHOOK', 'POLL', 'UI', 'SCRIPT'])
export type LedgerSource = z.infer<typeof ledgerSourceSchema>

export const writeOffReasonSchema = z.enum(['DAMAGE', 'GIFT', 'SAMPLE'])
export type WriteOffReason = z.infer<typeof writeOffReasonSchema>

const baseEvent = z.object({
  type: ledgerEventTypeSchema,
  locationId: z.string().min(1),
  /// Family level. Always required, at every granularity.
  variationId: z.string().min(1),
  /// Variant level. Absent on SALE, because Square reports sales by family.
  warehouseVariantId: z.string().min(1).optional(),
  /// Signed. Zero is never a real movement and is rejected.
  quantity: z.number().int().refine((n) => n !== 0, 'quantity must not be zero'),
  occurredAt: z.coerce.date(),
  source: ledgerSourceSchema,
  sourceRef: z.string().optional(),
  idempotencyKey: z.string().min(1),
  actorId: z.string().optional(),
  transferId: z.string().optional(),
  reason: writeOffReasonSchema.optional(),
  note: z.string().optional(),
})

export const appendEventInputSchema = baseEvent
  .refine((e) => !(e.type === 'SALE' && e.warehouseVariantId !== undefined), {
    message: 'SALE events must not carry a warehouseVariantId (spec §5.5)',
    path: ['warehouseVariantId'],
  })
  .refine((e) => !(e.type === 'WRITE_OFF' && e.reason === undefined), {
    message: 'WRITE_OFF events require a reason',
    path: ['reason'],
  })
  .refine((e) => e.type !== 'DISPATCH' && e.type !== 'RETURN', {
    message: 'DISPATCH and RETURN always come in pairs sharing a transferId (spec §5.4); use LedgerService.transfer(), not append()',
    path: ['type'],
  })
/// z.input for the same reason as TransferInput: occurredAt accepts a string.
export type AppendEventInput = z.input<typeof appendEventInputSchema>

/// A transfer is two ledger rows sharing a transferId: negative at the source,
/// positive at the destination. Direction is expressed by the endpoints, so
/// quantity is always positive.
export const transferInputSchema = z
  .object({
    fromLocationId: z.string().min(1),
    toLocationId: z.string().min(1),
    variationId: z.string().min(1),
    warehouseVariantId: z.string().min(1),
    quantity: z.number().int().positive(),
    occurredAt: z.coerce.date(),
    source: ledgerSourceSchema,
    sourceRef: z.string().optional(),
    /// Row keys are derived as `${prefix}:from` and `${prefix}:to`.
    idempotencyKeyPrefix: z.string().min(1),
    actorId: z.string().optional(),
    type: z.enum(['DISPATCH', 'RETURN']).default('DISPATCH'),
    note: z.string().optional(),
  })
  .refine((t) => t.fromLocationId !== t.toLocationId, {
    message: 'a transfer must have two different endpoints',
    path: ['toLocationId'],
  })
/// z.input, not z.infer: `type` has a default and `occurredAt` is coerced, so
/// callers may legitimately omit the first and pass a string for the second.
/// Using the output type here would reject both at compile time.
export type TransferInput = z.input<typeof transferInputSchema>

export const stockLevelSchema = z.object({
  variationId: z.string(),
  warehouseVariantId: z.string().nullable(),
  locationId: z.string(),
  onHand: z.number().int(),
})
export type StockLevel = z.infer<typeof stockLevelSchema>

/// `GET /stock/sales-since`: family-level units sold in a trailing window
/// (spec §9.9's "sales today and this week by family"). `unitsSold` is
/// reported positive -- callers do not want to mentally un-negate a signed
/// ledger sum to read "we sold 12 of these".
export const salesRowSchema = z.object({
  variationId: z.string(),
  locationId: z.string(),
  unitsSold: z.number().int(),
})
export type SalesRow = z.infer<typeof salesRowSchema>

/**
 * Idempotency-key builders — the only sanctioned way to construct a
 * LedgerEvent idempotencyKey / idempotencyKeyPrefix.
 *
 * Idempotency is the ledger's entire self-healing mechanism: append() is
 * safe to call repeatedly because a second call with the same key returns
 * the original row instead of inserting a duplicate (see
 * LedgerService.append()'s docstring). That guarantee only holds if every
 * producer of a given real-world event — today's tests, tomorrow's webhook
 * handler, tomorrow's reconciliation poll — builds the *same* string for
 * the *same* event. If a webhook handler and a poll worker key the same
 * sale differently, every sale double-counts, permanently, and because
 * LedgerEvent is append-only, unwinding it means a CORRECTION row per
 * affected line. Use these builders instead of hand-assembling a key
 * literal, so the convention lives in one place instead of being
 * re-invented, and re-diverged, at every call site.
 *
 * idempotencyKey is a single unique column, so every key lives in one flat
 * namespace. Each builder below owns a distinct fixed tag ('sale:',
 * 'write_off:', 'intake:', 'correction:', 'dispatch:'/'return:') so that
 * ordinary use cannot collide across event kinds. The one deliberate
 * exception is transferKeyPrefix(): LedgerService.transfer() appends
 * ':from' and ':to' to whatever prefix it is given, so a key built by one
 * of the other functions here must never itself end in ':from' or ':to'.
 */

export function saleKey(orderId: string, lineUid: string): string {
  return `sale:${orderId}:${lineUid}`
}

export function writeOffKey(ref: string): string {
  return `write_off:${ref}`
}

export function intakeKey(ref: string): string {
  return `intake:${ref}`
}

/// `originalIdempotencyKey` is the key of the event being corrected, so the
/// correction's own key stays traceable back to what it corrects.
export function correctionKey(originalIdempotencyKey: string): string {
  return `correction:${originalIdempotencyKey}`
}

/// Pass straight through as `idempotencyKeyPrefix` to LedgerService.transfer();
/// it derives the two row keys as `${prefix}:from` and `${prefix}:to` itself.
/// Never append your own `:from`/`:to` suffix to the result.
export function transferKeyPrefix(kind: 'dispatch' | 'return', ...parts: [string, ...string[]]): string {
  return [kind, ...parts].join(':')
}
