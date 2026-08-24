import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import type { IntakeInput } from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { IntakeService } from './intake.service.js'

@Controller('intake')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Post()
  receive(@Body() body: IntakeInput, @CurrentUser() user: CurrentUserPayload) {
    return this.intake.receive(body, user)
  }
}
