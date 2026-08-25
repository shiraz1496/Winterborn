import { Controller, Get, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { NotificationsService } from './notifications.service.js'

@Controller('notifications')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() actor: CurrentUserPayload) {
    return this.notifications.list(actor)
  }
}
