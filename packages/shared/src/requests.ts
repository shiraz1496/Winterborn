import { z } from 'zod'

export const requestStateSchema = z.enum(['DRAFT', 'OPEN', 'PACKING', 'DISPATCHED', 'ARRIVED', 'CLOSED'])
export type RequestState = z.infer<typeof requestStateSchema>

export const requestOriginSchema = z.enum(['THRESHOLD', 'REVIEW', 'MANUAL'])
export type RequestOrigin = z.infer<typeof requestOriginSchema>

export const createRequestLineInputSchema = z.object({
  variationId: z.string().min(1),
  /// Optional: a request line may be raised at family level ("60 gray") and
  /// only resolved to a concrete variant during packing (spec §9.4).
  warehouseVariantId: z.string().min(1).optional(),
  qtyRequested: z.number().int().positive(),
})
export type CreateRequestLineInput = z.infer<typeof createRequestLineInputSchema>

export const createRequestInputSchema = z.object({
  locationId: z.string().min(1),
  createdFrom: requestOriginSchema,
  lines: z.array(createRequestLineInputSchema).min(1),
})
export type CreateRequestInput = z.infer<typeof createRequestInputSchema>

export const updateRequestLineInputSchema = z
  .object({
    qtyRequested: z.number().int().positive().optional(),
    warehouseVariantId: z.string().min(1).optional(),
  })
  .refine((v) => v.qtyRequested !== undefined || v.warehouseVariantId !== undefined, {
    message: 'at least one of qtyRequested or warehouseVariantId is required',
  })
export type UpdateRequestLineInput = z.infer<typeof updateRequestLineInputSchema>

export const transitionRequestInputSchema = z.object({ state: requestStateSchema })
export type TransitionRequestInput = z.infer<typeof transitionRequestInputSchema>
