import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common'
import type { AssignColourFamilyInput } from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CatalogReadService } from './catalog-read.service.js'
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
}
