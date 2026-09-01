import { Module } from '@nestjs/common'
import { LedgerModule } from '../ledger/ledger.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { ThresholdsService } from './thresholds.service.js'
import { ThresholdsController } from './thresholds.controller.js'
import { VelocitySeeder } from './velocity-seeder.js'

// AuditService is provided globally by AuditModule (see app.module.ts),
// so it can be injected here without any explicit import.
@Module({
  imports: [LedgerModule, AuthModule],
  controllers: [ThresholdsController],
  providers: [ThresholdsService, VelocitySeeder],
  exports: [ThresholdsService, VelocitySeeder],
})
export class ThresholdsModule {}
