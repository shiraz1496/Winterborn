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

/// Response shapes -- what `RequestsController` actually returns, not the
/// input schemas above. `qtyRequested` round-trips through JSON as a plain
/// number since Prisma's Int maps straight to it.
export const requestLineSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  variationId: z.string(),
  warehouseVariantId: z.string().nullable(),
  qtyRequested: z.number().int(),
})
export type RequestLineDto = z.infer<typeof requestLineSchema>

/// Fields common to every response shape. `transition()` returns exactly
/// this -- Prisma's bare `update()` result, with no `lines` relation loaded
/// -- while create/list/get include `lines` on top (see restockRequestSchema).
export const restockRequestBaseSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  state: requestStateSchema,
  createdFrom: requestOriginSchema,
  createdById: z.string().nullable(),
  createdAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
})
export type RestockRequestBaseDto = z.infer<typeof restockRequestBaseSchema>

export const restockRequestSchema = restockRequestBaseSchema.extend({
  lines: z.array(requestLineSchema),
})
export type RestockRequestDto = z.infer<typeof restockRequestSchema>
