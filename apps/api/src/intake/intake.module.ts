import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { LedgerModule } from '../ledger/ledger.module.js'
import { IntakeController } from './intake.controller.js'
import { IntakeService } from './intake.service.js'

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [IntakeController],
  providers: [IntakeService],
})
export class IntakeModule {}
