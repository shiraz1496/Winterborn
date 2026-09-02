import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { LedgerModule } from '../ledger/ledger.module.js'
import { FulfilmentModule } from '../fulfilment/fulfilment.module.js'
import { RequestsService } from './requests.service.js'
import { RequestsController } from './requests.controller.js'
import { RequestAnalysisService } from './request-analysis.service.js'
import { PackingListSuggestionService } from './packing-list-suggestion.service.js'

// FulfilmentModule import: RequestsService needs BoxesService to post the
// INTAKE ledger rows when a market manager closes a received request.
// FulfilmentModule does NOT import RequestsModule -- no circular dep.
// AuditService is provided by the global AuditModule (see app.module.ts)
// so no explicit import here.
@Module({
  imports: [AuthModule, LedgerModule, FulfilmentModule],
  controllers: [RequestsController],
  providers: [RequestsService, RequestAnalysisService, PackingListSuggestionService],
  exports: [RequestsService, RequestAnalysisService, PackingListSuggestionService],
})
export class RequestsModule {}
