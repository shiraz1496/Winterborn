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

/// Admin view of a Location, exposing the Square link the read-only
/// `locationSchema` intentionally hides. Owner + Warehouse Manager only.
export const adminLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: locationKindSchema,
  timezone: z.string(),
  isActive: z.boolean(),
  squareLocationId: z.string().nullable(),
})
export type AdminLocationDto = z.infer<typeof adminLocationSchema>

/// Result of POST /admin/locations/sync. `created` is Square markets
/// that had no local counterpart; `updated` is local markets whose Square
/// link (or name / timezone) was overwritten from Square; `linked` is
/// existing local markets whose squareLocationId was filled in via an
/// exact-name match (first sync only). `unlinked` is local MARKET rows
/// that still have no Square counterpart -- useful because the operator
/// needs to know they're not sales-connected. Warehouse rows are never
/// touched by sync and are omitted from the summary entirely.
export const syncSquareLocationsResultSchema = z.object({
  created: z.array(z.string()),
  updated: z.array(z.string()),
  linked: z.array(z.string()),
  unlinked: z.array(z.string()),
  squareTotal: z.number().int(),
})
export type SyncSquareLocationsResult = z.infer<typeof syncSquareLocationsResultSchema>

/// Family-level ("what the cashier taps") sellable unit. StockLevel.variationId
/// points at rows of this shape.
export const variationSummarySchema = z.object({
  id: z.string(),
  itemGroupName: z.string(),
  categoryName: z.string(),
  colourFamilyName: z.string(),
  sizeOptionName: z.string(),
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

/// Controlled-vocabulary rows the "create new product" flow picks from.
/// Doc 3 §3.1: an authorised user creates a missing product using the
/// existing vocabulary rather than free-typing a fresh spelling.
export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type CategoryDto = z.infer<typeof categorySchema>

export const sizeOptionSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
})
export type SizeOptionDto = z.infer<typeof sizeOptionSchema>

/// POST /catalog/warehouse-variants: everything needed to spin up a new
/// product during intake. Category / family / size are IDs from the
/// controlled vocabulary; item group and colour variant are free-text names
/// that reuse the existing row if there is one already, otherwise create
/// it. Warehouse SKU is generated server-side so a Sunday operator never
/// invents a colliding one by hand.
export const createWarehouseVariantInputSchema = z.object({
  categoryId: z.string().min(1),
  itemGroupName: z.string().trim().min(1).max(120),
  colourFamilyId: z.string().min(1),
  colourVariantName: z.string().trim().min(1).max(120),
  sizeOptionId: z.string().min(1),
})
export type CreateWarehouseVariantInput = z.infer<typeof createWarehouseVariantInputSchema>

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

/// One row of the /admin/square-mapping table: everything the operator
/// needs to identify a local Variation, plus the two Square IDs (item at
/// the ItemGroup level, variation at the Variation level) that make sales
/// resolvable by the webhook / poll paths in apps/api/src/square. Both
/// fields are nullable -- an unset ID means "no Square row is linked
/// yet". Sending null in a PATCH clears the field.
export const squareMappingRowSchema = z.object({
  variationId: z.string(),
  itemGroupId: z.string(),
  itemGroupName: z.string(),
  categoryName: z.string(),
  colourFamilyName: z.string(),
  sizeOptionName: z.string(),
  squareItemId: z.string().nullable(),
  squareVariationId: z.string().nullable(),
})
export type SquareMappingRow = z.infer<typeof squareMappingRowSchema>

/// PATCH /catalog/item-groups/:id/square-id +
/// PATCH /catalog/variations/:id/square-id. `null` clears the linkage;
/// the empty string is coerced to null so a blank input field doesn't
/// store "" and then collide on the unique constraint next time.
export const setSquareIdInputSchema = z.object({
  squareId: z
    .union([z.string().trim().max(128), z.null()])
    .transform((value) => (value === null || value === '' ? null : value)),
})
export type SetSquareIdInput = z.infer<typeof setSquareIdInputSchema>
