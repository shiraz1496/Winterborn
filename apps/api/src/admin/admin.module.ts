import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { AdminUsersController } from './admin-users.controller.js'
import { AdminUsersService } from './admin-users.service.js'
import { AdminLocationsController } from './admin-locations.controller.js'
import { AdminLocationsService } from './admin-locations.service.js'

@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController, AdminLocationsController],
  providers: [AdminUsersService, AdminLocationsService],
})
export class AdminModule {}
