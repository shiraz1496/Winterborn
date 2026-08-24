import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import type { CreateAdminUserInput, UpdateAdminUserInput } from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { AdminUsersService } from './admin-users.service.js'

@Controller('admin/users')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list() {
    return this.users.list()
  }

  @Post()
  create(@Body() body: CreateAdminUserInput) {
    return this.users.create(body)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateAdminUserInput, @CurrentUser() actor: CurrentUserPayload) {
    return this.users.update(id, body, actor.id)
  }
}
