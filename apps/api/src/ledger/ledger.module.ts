import { Module } from '@nestjs/common'
import { LedgerService } from './ledger.service.js'
import { LedgerReadService } from './ledger-read.service.js'

@Module({
  providers: [LedgerService, LedgerReadService],
  exports: [LedgerService, LedgerReadService],
})
export class LedgerModule {}
