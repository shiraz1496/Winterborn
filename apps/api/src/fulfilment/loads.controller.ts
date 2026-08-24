import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { LoadsService, type CreateLoadInput } from './loads.service.js'

@Controller('loads')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
export class LoadsController {
  constructor(private readonly loads: LoadsService) {}

  @Post()
  create(@Body() body: CreateLoadInput, @CurrentUser() user: CurrentUserPayload) {
    return this.loads.create(body, user)
  }

  @Get()
  list() {
    return this.loads.list()
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.loads.get(id)
  }

  @Post(':id/scan')
  scanBox(@Param('id') id: string, @Body() body: { boxId: string }) {
    return this.loads.scanBox(id, body.boxId)
  }

  @Post(':id/dispatch')
  dispatch(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.loads.dispatch(id, user)
  }
}
