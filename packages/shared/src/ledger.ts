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
