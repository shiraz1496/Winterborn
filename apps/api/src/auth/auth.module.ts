import { Module } from '@nestjs/common'
import { AuthService } from './auth.service.js'
import { AuthController } from './auth.controller.js'
import { JwtGuard } from './jwt.guard.js'
import { RolesGuard } from './roles.guard.js'

/// Owns password auth, JWT sessions and the two guards every other
/// authenticated module (requests, fulfilment) depends on.
@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtGuard, RolesGuard],
  exports: [AuthService, JwtGuard, RolesGuard],
})
export class AuthModule {}
