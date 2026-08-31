import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common'
import { receiveBoxInputSchema, type ReceiveBoxInput } from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { BoxesService, type PackBoxInput, type PackBoxLineInput } from './boxes.service.js'

@Controller('boxes')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
export class BoxesController {
  constructor(private readonly boxes: BoxesService) {}

  /// Scan-to-receive. Overrides the class-level @Roles guard because
  /// this endpoint is meant for market managers (the destination) — the
  /// whole warehouse side has no reason to mark a box "arrived" via
  /// scan. OWNER is included as a support/override role for the same
  /// reasons OWNER can transition any request.
  @Post('receive')
  @Roles('MARKET_MANAGER', 'OWNER')
  receive(@Body() body: ReceiveBoxInput, @CurrentUser() user: CurrentUserPayload) {
    const parsed = receiveBoxInputSchema.parse(body)
    return this.boxes.receiveByToken(parsed.qrToken, user, parsed.expectedRequestId)
  }

  @Post()
  pack(@Body() body: PackBoxInput, @CurrentUser() user: CurrentUserPayload) {
    return this.boxes.pack(body, user)
  }

  @Get()
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER')
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('requestId') requestId?: string,
    @Query('destinationLocationId') destinationLocationId?: string,
  ) {
    return this.boxes.list({ requestId, destinationLocationId }, user)
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

  /// Delete a PACKING box (re-pack flow). Owner + warehouse-side only
  /// (the class-level @Roles guard already scopes to those). DISPATCHED
  /// or later state → 400 from the service.
  @Delete(':id')
  discard(@Param('id') id: string) {
    return this.boxes.discard(id)
  }

  @Get(':id/label')
  label(@Param('id') id: string) {
    return this.boxes.getLabel(id)
  }
}
