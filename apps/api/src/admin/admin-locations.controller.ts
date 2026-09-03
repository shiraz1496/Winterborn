import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common'
import {
  createAdminLocationInputSchema,
  updateAdminLocationInputSchema,
  type CreateAdminLocationInput,
  type UpdateAdminLocationInput,
} from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { AdminLocationsService } from './admin-locations.service.js'

/// Location admin surface. The public /locations endpoint is read-only
/// and does not expose squareLocationId; this controller does, and only
/// to the two roles that manage the Square integration.
@Controller('admin/locations')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE_MANAGER')
export class AdminLocationsController {
  constructor(private readonly locations: AdminLocationsService) {}

  @Get()
  list() {
    return this.locations.list()
  }

  /// Create a new local Location and (for MARKETs with syncToSquare=true)
  /// simultaneously push it to Square, storing the returned Square id
  /// on the local row. **Owner only** — creating a location is a
  /// structural decision that should sit with the operator who owns the
  /// business, not with warehouse staff.
  @Post()
  @Roles('OWNER')
  create(@Body() body: CreateAdminLocationInput) {
    const parsed = createAdminLocationInputSchema.parse(body)
    return this.locations.createLocation(parsed)
  }

  /// Edit a location (any field except kind + squareLocationId). Mirrors
  /// applicable fields to Square when linked. **Owner only** — covers
  /// both the full-form edit path and the active/inactive toggle since
  /// they use the same endpoint.
  @Patch(':id')
  @Roles('OWNER')
  update(@Param('id') id: string, @Body() body: UpdateAdminLocationInput) {
    const parsed = updateAdminLocationInputSchema.parse(body)
    return this.locations.updateLocation(id, parsed)
  }

  /// Read-through to Square: current address for a Square-linked
  /// location, so the Edit modal can pre-fill instead of asking the
  /// operator to type an address they can already see in the Square
  /// Dashboard.
  @Get(':id/square-details')
  squareDetails(@Param('id') id: string) {
    return this.locations.getSquareAddress(id)
  }

  /// POST rather than GET because it writes to the Location table.
  /// 200 (not 202) because the sync is synchronous and returns its
  /// summary; there is no background job to poll.
  @Post('sync')
  @HttpCode(200)
  sync() {
    return this.locations.syncFromSquare()
  }
}
