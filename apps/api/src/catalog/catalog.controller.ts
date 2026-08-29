import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type { AssignColourFamilyInput, CreateCategoryInput, CreateProductAttributeInput, CreateProductAttributeValueInput, CreateProductInput, CreateWarehouseVariantInput, SetSquareIdInput, StockCorrectionInput, UpdateItemGroupMappingInput } from '@winterborn/shared'
import { createCategoryInputSchema, createProductAttributeInputSchema, createProductAttributeValueInputSchema, createProductInputSchema, createWarehouseVariantInputSchema, setSquareIdInputSchema, stockCorrectionInputSchema, updateItemGroupMappingSchema } from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { CatalogReadService } from './catalog-read.service.js'
import { SquareCatalogSyncService } from './square-catalog-sync.service.js'
import { StockCorrectionService } from './stock-correction.service.js'
import { ProductCreationService } from './product-creation.service.js'
import { CloudinarySignatureService } from './cloudinary-signature.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'

/// Read-only catalog/stock/location surface for the frontend, plus the one
/// write the /admin/colours screen needs. Everyone authenticated may read
/// (a market manager deciding what to request needs family names and stock
/// just as much as the warehouse does); only warehouse-side roles may
/// reassign a colour family.
@Controller()
@UseGuards(JwtGuard, RolesGuard)
export class CatalogController {
  constructor(
    private readonly catalog: CatalogReadService,
    private readonly ledgerRead: LedgerReadService,
    private readonly squareCatalogSync: SquareCatalogSyncService,
    private readonly stockCorrection: StockCorrectionService,
    private readonly productCreation: ProductCreationService,
    private readonly cloudinarySignature: CloudinarySignatureService,
  ) {}

  @Get('locations')
  locations() {
    return this.catalog.listLocations()
  }

  @Get('catalog/variations')
  variations() {
    return this.catalog.listVariations()
  }

  @Get('catalog/warehouse-variants')
  warehouseVariants(@Query('variationId') variationId?: string) {
    return this.catalog.listWarehouseVariants(variationId)
  }

  @Post('catalog/warehouse-variants')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  createWarehouseVariant(@Body() body: CreateWarehouseVariantInput) {
    const parsed = createWarehouseVariantInputSchema.parse(body)
    return this.catalog.createWarehouseVariant(parsed)
  }

  @Get('catalog/categories')
  categories() {
    return this.catalog.listCategories()
  }

  /// Create a folder anywhere in the tree. Warehouse-side roles only —
  /// non-warehouse roles have no reason to create catalog structure.
  @Post('catalog/categories')
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
  createCategory(@Body() body: CreateCategoryInput) {
    const parsed = createCategoryInputSchema.parse(body)
    return this.catalog.createCategory({ parentId: parsed.parentId ?? null, name: parsed.name })
  }

  /// Full product creation from the intake modal — folder chain has
  /// already been walked (categoryId points at the leaf), and this
  /// endpoint upserts everything below in one transaction. Returns the
  /// new WarehouseVariantSummary so the modal can slot it straight into
  /// the intake queue.
  @Post('catalog/products')
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
  createProduct(@Body() body: CreateProductInput, @CurrentUser() user: CurrentUserPayload) {
    return this.productCreation.create(body, user)
  }

  /// Short-lived Cloudinary upload authorization for the intake modal's
  /// photo capture (mobile/tablet only). No request body -- every signed
  /// upload goes to the same server-configured folder.
  @Post('catalog/products/upload-signature')
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
  uploadSignature() {
    return this.cloudinarySignature.sign()
  }

  @Get('catalog/size-options')
  sizeOptions(@Query('categoryId') categoryId?: string) {
    return this.catalog.listSizeOptions(categoryId)
  }

  @Get('catalog/thresholds')
  thresholds(@Query('locationId') locationId?: string) {
    return this.catalog.listThresholds(locationId)
  }

  @Get('catalog/colour-variants/unassigned')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  unassignedColourVariants() {
    return this.catalog.listUnassignedColourVariants()
  }

  @Get('catalog/colour-families')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  colourFamilies(@Query('categoryId') categoryId: string) {
    return this.catalog.listColourFamilies(categoryId)
  }

  @Patch('catalog/colour-variants/:id')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  assignColourFamily(@Param('id') id: string, @Body() body: AssignColourFamilyInput) {
    return this.catalog.assignColourFamily(id, body.colourFamilyId)
  }

  /// Square-mapping admin surface. Read and write are both gated to
  /// OWNER + WAREHOUSE_MANAGER by policy -- the raw Square IDs are treated
  /// as configuration data other roles have no reason to see. If a future
  /// role needs read access, relax the guard on the GET only.
  @Get('catalog/square-mapping')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  squareMapping() {
    return this.catalog.listSquareMapping()
  }

  @Patch('catalog/item-groups/:id/square-id')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  setItemGroupSquareId(@Param('id') id: string, @Body() body: SetSquareIdInput) {
    const parsed = setSquareIdInputSchema.parse(body)
    return this.catalog.setItemGroupSquareId(id, parsed.squareId)
  }

  @Patch('catalog/variations/:id/square-id')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  setVariationSquareId(@Param('id') id: string, @Body() body: SetSquareIdInput) {
    const parsed = setSquareIdInputSchema.parse(body)
    return this.catalog.setVariationSquareId(id, parsed.squareId)
  }

  @Patch('catalog/warehouse-variants/:id/square-id')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  setWarehouseVariantSquareId(@Param('id') id: string, @Body() body: SetSquareIdInput) {
    const parsed = setSquareIdInputSchema.parse(body)
    return this.catalog.setWarehouseVariantSquareId(id, parsed.squareId)
  }

  /// Manually trigger a full Square catalog sync. Owner/WM only. Not automatic —
  /// the operator runs it when they've added new items in Square that need to
  /// show up in the mapping modal's dropdowns.
  @Post('catalog/sync-square')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  syncSquare() {
    return this.squareCatalogSync.sync()
  }

  /// List every locally-cached Square item (name + id + last-synced timestamp).
  /// Feeds the sync page's "everything we know about Square" table.
  @Get('catalog/square-items')
  listSquareItems() {
    return this.catalog.listSquareCatalogItems()
  }

  /// List cached Square variations under one item — powers the SKU dropdown
  /// in the mapping modal.
  @Get('catalog/square-items/:squareItemId/variations')
  listSquareVariations(@Param('squareItemId') squareItemId: string) {
    return this.catalog.listSquareCatalogVariations(squareItemId)
  }

  /// Product-list rows for the new mapping page. Each carries progress
  /// (X of Y SKUs bound to a Square variation) so the operator can sort
  /// by "needs attention first".
  @Get('catalog/item-groups')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  listItemGroups() {
    return this.catalog.listItemGroupMappingProgress()
  }

  /// Everything the mapping modal needs for one product in a single response.
  @Get('catalog/item-groups/:id/mapping-detail')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  itemGroupDetail(@Param('id') id: string) {
    return this.catalog.getItemGroupDetail(id)
  }

  /// Batch save from the mapping modal.
  @Patch('catalog/item-groups/:id/mapping')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  updateItemGroupMapping(@Param('id') id: string, @Body() body: UpdateItemGroupMappingInput) {
    const parsed = updateItemGroupMappingSchema.parse(body)
    return this.catalog.updateItemGroupMapping(id, parsed)
  }

  /// Add a new attribute (axis) to a product. Modal fires this when operator
  /// picks "+ Add axis" from the axis selector — payload is either a canonical
  /// name (Color/Size/Style) or a custom operator-typed string.
  @Post('catalog/item-groups/:id/attributes')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  createProductAttribute(@Param('id') id: string, @Body() body: CreateProductAttributeInput) {
    const parsed = createProductAttributeInputSchema.parse(body)
    return this.catalog.createProductAttribute(id, parsed.name, parsed.displayOrder)
  }

  /// Add a new allowed value to an existing axis. Note: adding a value does
  /// not create new WarehouseVariant rows — that's a separate warehouse-side
  /// action (creating physical stock). The value exists as a declared option
  /// available for mapping when the WarehouseVariant is eventually created.
  @Post('catalog/product-attributes/:attrId/values')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  createProductAttributeValue(@Param('attrId') attrId: string, @Body() body: CreateProductAttributeValueInput) {
    const parsed = createProductAttributeValueInputSchema.parse(body)
    return this.catalog.createProductAttributeValue(attrId, parsed.value, parsed.displayOrder)
  }

  /// Diagnostics for the sync page: Square items with no linked Winterborn
  /// ItemGroup, and vice versa. Both directions matter — the first is "we've
  /// synced this but haven't wired it up", the second is "we track this
  /// internally but Square doesn't sell it (or the name doesn't match)".
  @Get('catalog/square-mapping-orphans')
  @Roles('OWNER', 'WAREHOUSE_MANAGER')
  squareMappingOrphans() {
    return this.catalog.listMappingOrphans()
  }

  @Get('stock/by-family')
  stockByFamily(@Query('locationId') locationId?: string) {
    return this.ledgerRead.onHandByFamily(locationId)
  }

  @Get('stock/by-variant')
  stockByVariant(@Query('locationId') locationId?: string) {
    return this.ledgerRead.onHandByVariant(locationId)
  }

  @Get('stock/low')
  lowStock(@Query('locationId') locationId?: string) {
    return this.catalog.lowStock(locationId)
  }

  /// Family-level units sold since `now - days` (default 7 -- "this week"
  /// per spec §9.9). One bulk groupBy in LedgerReadService.salesSince,
  /// never a per-variation call.
  @Get('stock/sales-since')
  salesSince(@Query('locationId') locationId?: string, @Query('days') days?: string) {
    const parsedDays = days ? Number.parseInt(days, 10) : 7
    const windowDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    return this.ledgerRead.salesSince(since, locationId)
  }

  /// Sortly-style folder browser. Owner/WM pass an optional `locationId`
  /// to scope on-hand aggregates to a specific warehouse or market;
  /// omitting it falls back to the first WAREHOUSE-kind location so the
  /// default view stays "your main warehouse". MARKET_MANAGER is
  /// available too and is server-side pinned to their own location — a
  /// different locationId 403s so the boundary is explicit.
  @Get('catalog/browse')
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER')
  browse(
    @CurrentUser() user: CurrentUserPayload,
    @Query('folderId') folderId?: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.catalog.browseFolder(folderId ?? null, user, locationId ?? null)
  }

  /// One item-group's leaf SKUs — same locationId semantics as browse.
  @Get('catalog/browse/item-groups/:itemGroupId/items')
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER')
  browseItems(
    @CurrentUser() user: CurrentUserPayload,
    @Param('itemGroupId') itemGroupId: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.catalog.listItemGroupItems(itemGroupId, user, locationId ?? null)
  }

  @Get('catalog/browse/items/:warehouseVariantId')
  browseItemDetail(@Param('warehouseVariantId') warehouseVariantId: string) {
    return this.catalog.getCatalogItemDetail(warehouseVariantId)
  }

  /// Manual physical-count correction. User supplies a target on-hand and
  /// the server computes the signed delta. One CORRECTION ledger row, or
  /// none if the delta is zero.
  @Post('stock/correction')
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
  correctStock(@Body() body: StockCorrectionInput, @CurrentUser() user: CurrentUserPayload) {
    const parsed = stockCorrectionInputSchema.parse(body)
    return this.stockCorrection.correct(parsed, user)
  }
}
