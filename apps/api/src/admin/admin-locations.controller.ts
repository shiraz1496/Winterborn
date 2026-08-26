import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'
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

  /// POST rather than GET because it writes to the Location table.
  /// 200 (not 202) because the sync is synchronous and returns its
  /// summary; there is no background job to poll.
  @Post('sync')
  @HttpCode(200)
  sync() {
    return this.locations.syncFromSquare()
  }
}
