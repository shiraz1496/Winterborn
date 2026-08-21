import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type {
  CreateRequestInput,
  CreateRequestLineInput,
  TransitionRequestInput,
  UpdateRequestLineInput,
} from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { RequestsService } from './requests.service.js'

@Controller('requests')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE', 'MARKET_MANAGER', 'OPERATOR')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  create(@Body() body: CreateRequestInput, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.create(body, user)
  }

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.requests.list(user)
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.get(id, user)
  }

  @Post(':id/lines')
  addLine(@Param('id') id: string, @Body() body: CreateRequestLineInput, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.addLine(id, body, user)
  }

  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: UpdateRequestLineInput,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.requests.updateLine(id, lineId, body, user)
  }

  @Post(':id/transition')
  transition(
    @Param('id') id: string,
    @Body() body: TransitionRequestInput,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.requests.transition(id, body.state, user)
  }
}
