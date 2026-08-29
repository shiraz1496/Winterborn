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
/// points at rows of this shape. `photoUrl` is the first Sortly-archived photo
/// for this SKU (WarehouseVariant.photoUrls[0]) with the ColourVariant.photoUrl
/// backfill as fallback — surfaced so browse screens can render a thumbnail
/// without a second call.
export const warehouseVariantSummarySchema = z.object({
  id: z.string(),
  variationId: z.string(),
  itemGroupName: z.string(),
  colourVariantName: z.string(),
  sizeOptionName: z.string(),
  warehouseSku: z.string(),
  photoUrl: z.string().nullable(),
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
/// Per-warehouse-variant mapping. One row per stock SKU (Earmuffs / Black),
/// nested under the parent Variation. `squareVariationId` is nullable — set
/// it when the Square catalog exposes a distinct variation per colour, leave
/// null for family-level items where only the parent Variation carries a
/// squareVariationId (still supported as a fallback in the mapper).
export const squareMappingWarehouseVariantSchema = z.object({
  warehouseVariantId: z.string(),
  colourVariantName: z.string(),
  sizeOptionName: z.string(),
  warehouseSku: z.string(),
  squareVariationId: z.string().nullable(),
})
export type SquareMappingWarehouseVariant = z.infer<typeof squareMappingWarehouseVariantSchema>

export const squareMappingRowSchema = z.object({
  variationId: z.string(),
  itemGroupId: z.string(),
  itemGroupName: z.string(),
  categoryName: z.string(),
  colourFamilyName: z.string(),
  sizeOptionName: z.string(),
  squareItemId: z.string().nullable(),
  squareVariationId: z.string().nullable(),
  warehouseVariants: z.array(squareMappingWarehouseVariantSchema),
})
export type SquareMappingRow = z.infer<typeof squareMappingRowSchema>

/// Row for the /admin/square-mapping product-list screen. One per ItemGroup,
/// with progress info so the operator can see at a glance which products
/// still need attention.
export const itemGroupMappingProgressSchema = z.object({
  itemGroupId: z.string(),
  itemGroupName: z.string(),
  categoryName: z.string(),
  squareItemId: z.string().nullable(),
  totalSkus: z.number().int(),
  mappedSkus: z.number().int(),
  attributeCount: z.number().int(),
})
export type ItemGroupMappingProgress = z.infer<typeof itemGroupMappingProgressSchema>

/// One axis on the product-detail response — Color / Size / Style / custom.
export const itemGroupAttributeSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayOrder: z.number().int(),
  values: z.array(
    z.object({
      id: z.string(),
      value: z.string(),
      displayOrder: z.number().int(),
    }),
  ),
})
export type ItemGroupAttribute = z.infer<typeof itemGroupAttributeSchema>

/// One SKU row in the mapping modal, with its resolved attribute values and
/// current Square binding. `attributeValues` lists the value IDs the SKU
/// carries (one per axis), which the modal uses to display "Broad Stripes /
/// Pink/Purple / Small" without a second lookup.
export const itemGroupSkuSchema = z.object({
  warehouseVariantId: z.string(),
  warehouseSku: z.string(),
  colourVariantName: z.string(),
  sizeOptionName: z.string(),
  squareVariationId: z.string().nullable(),
  attributeValueIds: z.array(z.string()),
})
export type ItemGroupSku = z.infer<typeof itemGroupSkuSchema>

/// Everything the mapping modal needs for one product. Includes any pre-cached
/// Square candidates so the dropdown is populated without a second call.
export const itemGroupDetailSchema = z.object({
  itemGroupId: z.string(),
  itemGroupName: z.string(),
  categoryName: z.string(),
  squareItemId: z.string().nullable(),
  attributes: z.array(itemGroupAttributeSchema),
  skus: z.array(itemGroupSkuSchema),
  squareItemCandidates: z.array(z.object({ squareItemId: z.string(), name: z.string(), isBoundElsewhere: z.boolean() })),
  squareVariationCandidates: z.array(
    z.object({
      squareVariationId: z.string(),
      squareItemId: z.string(),
      name: z.string(),
      /// This Square variation is already the target of a WarehouseVariant
      /// (or a Variation) mapping outside the ItemGroup being edited. Modal
      /// hides it from the dropdown so the DB's unique constraint can never
      /// bite the operator at save time.
      isBoundElsewhere: z.boolean(),
    }),
  ),
})
export type ItemGroupDetail = z.infer<typeof itemGroupDetailSchema>

/// POST /catalog/item-groups/:id/attributes — create a new axis on this
/// ItemGroup ("Color", "Size", "Style", or an operator-typed custom name).
/// P2002 collision surfaces as a Conflict (axis already exists on this product).
export const createProductAttributeInputSchema = z.object({
  name: z.string().trim().min(1).max(50),
  displayOrder: z.number().int().optional(),
})
export type CreateProductAttributeInput = z.infer<typeof createProductAttributeInputSchema>

/// POST /catalog/item-groups/:id/attributes/:attrId/values — add a new
/// allowed value on an existing axis (e.g. "XL" on the Size axis).
export const createProductAttributeValueInputSchema = z.object({
  value: z.string().trim().min(1).max(100),
  displayOrder: z.number().int().optional(),
})
export type CreateProductAttributeValueInput = z.infer<typeof createProductAttributeValueInputSchema>

/// Body of PATCH /catalog/item-groups/:id/mapping. Atomically saves everything
/// the modal edited: squareItemId, per-SKU squareVariationIds. Null clears a
/// field. Missing keys leave the current value.
export const updateItemGroupMappingSchema = z.object({
  squareItemId: z.union([z.string(), z.null()]).optional(),
  skus: z
    .array(
      z.object({
        warehouseVariantId: z.string(),
        squareVariationId: z.union([z.string(), z.null()]),
      }),
    )
    .optional(),
})
export type UpdateItemGroupMappingInput = z.infer<typeof updateItemGroupMappingSchema>

/// Locally-cached Square catalog item (result of GET /catalog/square-items).
/// Populated by the Square catalog sync; the sync page shows the list, the
/// mapping modal uses this as the source for its item dropdown.
export const squareCatalogItemSchema = z.object({
  squareItemId: z.string(),
  name: z.string(),
  categoryName: z.string().nullable(),
  variationCount: z.number().int(),
  lastSyncedAt: z.string(),
})
export type SquareCatalogItemDto = z.infer<typeof squareCatalogItemSchema>

/// Variation under a cached Square catalog item (result of
/// GET /catalog/square-items/:squareItemId/variations). Feeds the per-SKU
/// dropdown in the mapping modal.
export const squareCatalogVariationSchema = z.object({
  squareVariationId: z.string(),
  squareItemId: z.string(),
  name: z.string(),
  priceCents: z.number().int().nullable(),
})
export type SquareCatalogVariationDto = z.infer<typeof squareCatalogVariationSchema>

/// Result of POST /catalog/sync-square — counts of what was upserted /
/// pruned. `syncedAt` is the pass timestamp; the sync page renders "synced
/// N minutes ago" against it.
export const squareCatalogSyncResultSchema = z.object({
  itemsSynced: z.number().int(),
  variationsSynced: z.number().int(),
  itemsRemoved: z.number().int(),
  variationsRemoved: z.number().int(),
  pages: z.number().int(),
  syncedAt: z.string(),
})
export type SquareCatalogSyncResult = z.infer<typeof squareCatalogSyncResultSchema>

/// Result of GET /catalog/square-mapping-orphans. Both directions of
/// unlinked items — Square-only and Winterborn-only.
export const squareMappingOrphansSchema = z.object({
  squareOnly: z.array(z.object({ squareItemId: z.string(), name: z.string() })),
  winterbornOnly: z.array(
    z.object({ itemGroupId: z.string(), name: z.string(), categoryName: z.string() }),
  ),
})
export type SquareMappingOrphans = z.infer<typeof squareMappingOrphansSchema>

/// One row in the Sortly-style folder browser at either the category or
/// item-group level. `subfolderCount` is 0 for item-group rows (the leaf
/// level below is items, not more folders). `previewPhotoUrl` is the first
/// available photo in that folder — used as the folder tile's thumbnail.
/// Quantity and value are aggregated across warehouse-kind locations only,
/// mirroring Sortly's "IN STOCK" root.
export const catalogFolderRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  subfolderCount: z.number().int(),
  itemCount: z.number().int(),
  totalQty: z.number().int(),
  totalValueCents: z.number().int(),
  previewPhotoUrl: z.string().nullable(),
})
export type CatalogFolderRow = z.infer<typeof catalogFolderRowSchema>

/// One breadcrumb step: parent id + name. The client renders these as
/// links from root down to (but not including) the currently-viewed folder.
export const catalogCrumbSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type CatalogCrumb = z.infer<typeof catalogCrumbSchema>

/// Tree-aware browse response for GET /catalog/browse?folderId=…. `folder`
/// is null at the top level (no folderId supplied) — otherwise it's the
/// current folder metadata. `breadcrumb` walks ancestors root-first,
/// EXCLUDING the current folder. `subfolders` is the direct-child Category
/// rows; `itemGroups` is the direct-child ItemGroup rows exposed with the
/// same tile shape (they render as folders in the grid). A leaf folder
/// with no children returns both arrays empty and the client redirects to
/// its item-group view.
export const catalogBrowseResponseSchema = z.object({
  folder: z
    .object({
      id: z.string(),
      name: z.string(),
      parentId: z.string().nullable(),
    })
    .nullable(),
  breadcrumb: z.array(catalogCrumbSchema),
  subfolders: z.array(catalogFolderRowSchema),
  itemGroups: z.array(catalogFolderRowSchema),
})
export type CatalogBrowseResponse = z.infer<typeof catalogBrowseResponseSchema>

/// Leaf-level row: one WarehouseVariant, with warehouse-wide on-hand and
/// unit cost. Value = onHand × unitCostCents (client renders as dollars).
export const catalogItemRowSchema = z.object({
  warehouseVariantId: z.string(),
  itemGroupId: z.string(),
  itemGroupName: z.string(),
  colourVariantName: z.string(),
  colourFamilyName: z.string(),
  sizeOptionName: z.string(),
  warehouseSku: z.string(),
  photoUrl: z.string().nullable(),
  onHand: z.number().int(),
  unitCostCents: z.number().int().nullable(),
})
export type CatalogItemRow = z.infer<typeof catalogItemRowSchema>

/// One item-group SKU-grid response: metadata about the group + its
/// breadcrumb (so the client can render the crumb trail with one call)
/// plus the leaf rows themselves.
export const catalogItemGroupPageSchema = z.object({
  itemGroup: z.object({
    id: z.string(),
    name: z.string(),
    categoryId: z.string(),
  }),
  breadcrumb: z.array(catalogCrumbSchema),
  items: z.array(catalogItemRowSchema),
})
export type CatalogItemGroupPage = z.infer<typeof catalogItemGroupPageSchema>

/// Per-warehouse on-hand slice, so the detail screen can show the count at
/// each warehouse if there are several. `locationName` is denormalised in
/// so the UI can list "Warehouse: 42" without a separate /locations lookup.
export const catalogItemStockRowSchema = z.object({
  locationId: z.string(),
  locationName: z.string(),
  onHand: z.number().int(),
})
export type CatalogItemStockRow = z.infer<typeof catalogItemStockRowSchema>

/// Full detail response for one WarehouseVariant. Includes breadcrumb parts
/// (categoryId/Name, itemGroupId/Name) so the detail page can render its
/// crumb trail from a single request; photoUrls is the whole Sortly archive
/// (not just the first), for a lightbox/gallery.
export const catalogItemDetailSchema = z.object({
  warehouseVariantId: z.string(),
  warehouseSku: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  itemGroupId: z.string(),
  itemGroupName: z.string(),
  variationId: z.string(),
  colourVariantName: z.string(),
  colourFamilyName: z.string(),
  sizeOptionName: z.string(),
  photoUrls: z.array(z.string()),
  unitCostCents: z.number().int().nullable(),
  totalOnHand: z.number().int(),
  stockByLocation: z.array(catalogItemStockRowSchema),
  /// Ancestors of the leaf Category root-first (INCLUDING the leaf
  /// category itself). Lets the item-detail page render its full crumb
  /// trail without a follow-up browse call.
  breadcrumb: z.array(catalogCrumbSchema),
})
export type CatalogItemDetail = z.infer<typeof catalogItemDetailSchema>

/// POST /stock/correction — user-entered target on-hand for a
/// WarehouseVariant at a specific warehouse location. Server computes the
/// signed delta against the current on-hand and appends a CORRECTION ledger
/// event. `note` is captured for the audit trail (e.g. "physical count Q4
/// 2025", "damaged during move").
export const stockCorrectionInputSchema = z.object({
  warehouseVariantId: z.string().min(1),
  locationId: z.string().min(1),
  newOnHand: z.number().int().min(0),
  note: z.string().max(500).optional(),
})
export type StockCorrectionInput = z.infer<typeof stockCorrectionInputSchema>

/// `delta` is 0 when the target already equals the current on-hand — the
/// server returns `created: false` and no ledger row is appended.
export const stockCorrectionResultSchema = z.object({
  eventId: z.string().nullable(),
  created: z.boolean(),
  onHand: z.number().int(),
  delta: z.number().int(),
})
export type StockCorrectionResult = z.infer<typeof stockCorrectionResultSchema>

/// POST /catalog/categories — create a folder anywhere in the tree.
/// Upsert semantics: if a Category with the same (parentId, name) already
/// exists, the existing row is returned. Two operators naming the same
/// folder end up pointing at the same row instead of creating siblings.
export const createCategoryInputSchema = z.object({
  parentId: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(120),
})
export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>

export const categoryTreeNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
})
export type CategoryTreeNode = z.infer<typeof categoryTreeNodeSchema>

/// POST /catalog/products — bulk product creation via a matrix. The
/// modal in the intake screen collects an optional primary axis (Size /
/// Style / Custom) plus a colour list, then a qty per (primary × colour)
/// cell. Every non-zero cell becomes one WarehouseVariant + one INTAKE
/// event. `unitCostCents` applies to every created SKU. All colours and
/// primary values get ProductAttribute + ProductAttributeValue rows so
/// the Square-mapping modal sees the exact axes the operator declared.
///
/// Three shapes fit through this one schema:
///   1. Matrix: primary axis with N values × colour list with M values
///      → up to N × M SKUs
///   2. Colours only (no primary): one row × colours → up to M SKUs
///   3. Single SKU (no axes at all): `colors: []` and `primaryAxis: null`
///      → exactly one SKU
export const createProductInputSchema = z.object({
  categoryId: z.string().min(1),
  itemGroupName: z.string().trim().min(1).max(120),
  /// The row axis. Named freely so operators can label it "Yarn count",
  /// "Fit", etc. Canonical names (`Size`, `Style`) are treated no
  /// differently from custom on the server side; the UI groups them.
  primaryAxis: z
    .object({
      name: z.string().trim().min(1).max(50),
      values: z.array(z.string().trim().min(1).max(100)).min(1),
    })
    .nullable(),
  /// Colour axis values. Empty array = product has no colour axis (e.g.
  /// Dryer Balls). Otherwise every colour becomes a ProductAttributeValue
  /// under a `Color` axis and the matrix uses colours as columns.
  colors: z.array(z.string().trim().min(1).max(100)).default([]),
  /// Quantity per matrix cell. Keys are `${primaryValue ?? '__none__'}::${color ?? '__none__'}`.
  /// Only non-zero cells produce SKUs; cells omitted or set to zero are
  /// treated as "not carrying that combination yet" — a later intake
  /// flow can still create them.
  quantities: z.record(z.string(), z.number().int().min(0)),
  /// Required. Applies to every created SKU.
  unitCostCents: z.number().int().min(0),
})
export type CreateProductInput = z.input<typeof createProductInputSchema>

/// One row per SKU that actually got created (non-zero cells only).
export const createdProductSkuSchema = z.object({
  warehouseVariant: warehouseVariantSummarySchema,
  variationId: z.string(),
  quantity: z.number().int(),
  intakeEventId: z.string().nullable(),
})
export type CreatedProductSku = z.infer<typeof createdProductSkuSchema>

export const createProductResultSchema = z.object({
  itemGroupId: z.string(),
  skusCreated: z.number().int(),
  totalUnitsRecorded: z.number().int(),
  skus: z.array(createdProductSkuSchema),
})
export type CreateProductResult = z.infer<typeof createProductResultSchema>

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
