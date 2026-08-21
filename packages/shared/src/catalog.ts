import { z } from 'zod'

export const locationKindSchema = z.enum(['MARKET', 'WAREHOUSE'])
export type LocationKind = z.infer<typeof locationKindSchema>

export const familyAssignmentSourceSchema = z.enum(['LEXICAL', 'SYNONYM', 'VISUAL', 'MANUAL'])
export type FamilyAssignmentSource = z.infer<typeof familyAssignmentSourceSchema>

/// The read surface a browser client actually needs. These describe API
/// *responses*, not Prisma rows -- every relation the client needs by name
/// (item group, colour, size, category) is flattened in rather than left
/// for a second round trip.

export const locationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: locationKindSchema,
  timezone: z.string(),
  isActive: z.boolean(),
})
export type LocationDto = z.infer<typeof locationSchema>

/// Family-level ("what the cashier taps") sellable unit. StockLevel.variationId
/// points at rows of this shape.
export const variationSummarySchema = z.object({
  id: z.string(),
  itemGroupName: z.string(),
  categoryName: z.string(),
  colourFamilyName: z.string(),
  sizeOptionName: z.string(),
  tillSku: z.string(),
})
export type VariationSummary = z.infer<typeof variationSummarySchema>

/// Variant-level ("what's actually in the box") stock unit. StockLevel.warehouseVariantId
/// points at rows of this shape.
export const warehouseVariantSummarySchema = z.object({
  id: z.string(),
  variationId: z.string(),
  itemGroupName: z.string(),
  colourVariantName: z.string(),
  sizeOptionName: z.string(),
  warehouseSku: z.string(),
})
export type WarehouseVariantSummary = z.infer<typeof warehouseVariantSummarySchema>

export const thresholdSchema = z.object({
  id: z.string(),
  variationId: z.string(),
  locationId: z.string(),
  minLevel: z.number().int(),
})
export type ThresholdDto = z.infer<typeof thresholdSchema>

export const colourFamilySchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
})
export type ColourFamilyDto = z.infer<typeof colourFamilySchema>

/// One row of the /admin/colours residual queue: a warehouse colour value
/// that has never been assigned a real till family.
export const unassignedColourVariantSchema = z.object({
  id: z.string(),
  name: z.string(),
  sortlyName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  categoryId: z.string(),
  categoryName: z.string(),
})
export type UnassignedColourVariant = z.infer<typeof unassignedColourVariantSchema>

export const assignColourFamilyInputSchema = z.object({ colourFamilyId: z.string().min(1) })
export type AssignColourFamilyInput = z.infer<typeof assignColourFamilyInputSchema>

/// PATCH /catalog/colour-variants/:id's response -- the raw ColourVariant
/// row, post-update.
export const colourVariantSchema = z.object({
  id: z.string(),
  colourFamilyId: z.string(),
  name: z.string(),
  sortlyName: z.string().nullable(),
  normalisedName: z.string(),
  photoUrl: z.string().nullable(),
  familyAssignmentSource: familyAssignmentSourceSchema,
  familyConfidence: z.number(),
})
export type ColourVariantDto = z.infer<typeof colourVariantSchema>

/// GET /stock/low: a family-level stock row paired with the threshold it
/// fell under. `onHand` and `minLevel` travel together so the dashboard
/// never has to re-join them client-side.
export const lowStockRowSchema = z.object({
  variationId: z.string(),
  locationId: z.string(),
  onHand: z.number().int(),
  minLevel: z.number().int(),
})
export type LowStockRow = z.infer<typeof lowStockRowSchema>
