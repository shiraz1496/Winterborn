import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { LedgerModule } from '../ledger/ledger.module.js'
import { FulfilmentModule } from '../fulfilment/fulfilment.module.js'
import { RequestsService } from './requests.service.js'
import { RequestsController } from './requests.controller.js'
import { AuditService } from './audit.service.js'
import { RequestAnalysisService } from './request-analysis.service.js'

// FulfilmentModule import: RequestsService needs BoxesService to post the
// INTAKE ledger rows when a market manager closes a received request.
// FulfilmentModule does NOT import RequestsModule -- no circular dep.
@Module({
  imports: [AuthModule, LedgerModule, FulfilmentModule],
  controllers: [RequestsController],
  providers: [RequestsService, AuditService, RequestAnalysisService],
  exports: [RequestsService, AuditService, RequestAnalysisService],
})
export class RequestsModule {}
