import { z } from 'zod'

export const boxStateSchema = z.enum(['PACKING', 'DISPATCHED', 'ARRIVED', 'RETURNED'])
export type BoxState = z.infer<typeof boxStateSchema>

export const packBoxLineInputSchema = z.object({
  warehouseVariantId: z.string().min(1),
  quantity: z.number().int().positive(),
})
export type PackBoxLineInput = z.infer<typeof packBoxLineInputSchema>

export const packBoxInputSchema = z.object({
  destinationLocationId: z.string().min(1),
  requestId: z.string().min(1).optional(),
  lines: z.array(packBoxLineInputSchema).min(1),
})
export type PackBoxInput = z.infer<typeof packBoxInputSchema>

export const boxLineSchema = z.object({
  id: z.string(),
  boxId: z.string(),
  warehouseVariantId: z.string(),
  quantity: z.number().int(),
})
export type BoxLineDto = z.infer<typeof boxLineSchema>

export const boxSchema = z.object({
  id: z.string(),
  requestId: z.string().nullable(),
  destinationLocationId: z.string(),
  state: boxStateSchema,
  qrToken: z.string(),
  packedById: z.string().nullable(),
  packedAt: z.coerce.date().nullable(),
  dispatchedAt: z.coerce.date().nullable(),
  arrivedAt: z.coerce.date().nullable(),
  lines: z.array(boxLineSchema),
})
export type BoxDto = z.infer<typeof boxSchema>

export const boxLabelSchema = z.object({
  qrToken: z.string(),
  destinationLocationId: z.string(),
  destinationLocationName: z.string(),
  lineCount: z.number().int(),
  packedAt: z.coerce.date().nullable(),
})
export type BoxLabelDto = z.infer<typeof boxLabelSchema>

export const dispatchResultSchema = z.object({
  boxId: z.string(),
  transfers: z.array(
    z.object({
      warehouseVariantId: z.string(),
      transferId: z.string(),
      created: z.boolean(),
    }),
  ),
})
export type DispatchResult = z.infer<typeof dispatchResultSchema>

export const createLoadInputSchema = z.object({
  vehicleLabel: z.string().min(1),
  destinationLocationId: z.string().min(1),
})
export type CreateLoadInput = z.infer<typeof createLoadInputSchema>

export const loadSchema = z.object({
  id: z.string(),
  vehicleLabel: z.string(),
  destinationLocationId: z.string(),
  createdById: z.string().nullable(),
  createdAt: z.coerce.date(),
  dispatchedAt: z.coerce.date().nullable(),
})
export type LoadDto = z.infer<typeof loadSchema>

export const loadBoxSchema = z.object({
  loadId: z.string(),
  boxId: z.string(),
  scannedAt: z.coerce.date(),
})
export type LoadBoxDto = z.infer<typeof loadBoxSchema>

export const loadWithBoxesSchema = loadSchema.extend({
  boxes: z.array(loadBoxSchema),
})
export type LoadWithBoxesDto = z.infer<typeof loadWithBoxesSchema>

export const loadDispatchResultSchema = z.object({
  loadId: z.string(),
  boxes: z.array(dispatchResultSchema),
})
export type LoadDispatchResult = z.infer<typeof loadDispatchResultSchema>
