import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { LedgerModule } from '../ledger/ledger.module.js'
import { RequestsService } from './requests.service.js'
import { RequestsController } from './requests.controller.js'
import { AuditService } from './audit.service.js'
import { RequestAnalysisService } from './request-analysis.service.js'

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [RequestsController],
  providers: [RequestsService, AuditService, RequestAnalysisService],
  exports: [RequestsService, AuditService, RequestAnalysisService],
})
export class RequestsModule {}
