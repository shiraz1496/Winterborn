import { Module } from '@nestjs/common'
import { LedgerModule } from '../ledger/ledger.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { AuditService } from '../requests/audit.service.js'
import { ThresholdsService } from './thresholds.service.js'
import { ThresholdsController } from './thresholds.controller.js'
import { VelocitySeeder } from './velocity-seeder.js'

@Module({
  imports: [LedgerModule, AuthModule],
  controllers: [ThresholdsController],
  // AuditService is imported directly rather than by importing RequestsModule:
  // it is a stateless writer (takes the caller's own transaction client, see
  // its docstring) with no dependency of its own, so a second instance here
  // is cheap and avoids pulling RequestsController/RequestsService into a
  // module that has no business routing requests HTTP traffic.
  providers: [ThresholdsService, VelocitySeeder, AuditService],
  exports: [ThresholdsService, VelocitySeeder],
})
export class ThresholdsModule {}
