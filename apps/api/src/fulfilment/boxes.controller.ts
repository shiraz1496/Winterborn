import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { BoxesService, type PackBoxInput, type PackBoxLineInput } from './boxes.service.js'

@Controller('boxes')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE', 'OPERATOR')
export class BoxesController {
  constructor(private readonly boxes: BoxesService) {}

  @Post()
  pack(@Body() body: PackBoxInput, @CurrentUser() user: CurrentUserPayload) {
    return this.boxes.pack(body, user)
  }

  @Get()
  list(@Query('requestId') requestId?: string, @Query('destinationLocationId') destinationLocationId?: string) {
    return this.boxes.list({ requestId, destinationLocationId })
  }

  @Get('by-token/:qrToken')
  getByToken(@Param('qrToken') qrToken: string) {
    return this.boxes.getByToken(qrToken)
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.boxes.get(id)
  }

  @Post(':id/lines')
  addLine(@Param('id') id: string, @Body() body: PackBoxLineInput) {
    return this.boxes.addLine(id, body)
  }

  @Post(':id/dispatch')
  dispatch(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.boxes.dispatch(id, user)
  }

  @Get(':id/label')
  label(@Param('id') id: string) {
    return this.boxes.getLabel(id)
  }
}
