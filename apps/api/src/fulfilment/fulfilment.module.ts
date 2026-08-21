import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { LedgerModule } from '../ledger/ledger.module.js'
import { BoxesService } from './boxes.service.js'
import { LoadsService } from './loads.service.js'
import { BoxesController } from './boxes.controller.js'
import { LoadsController } from './loads.controller.js'

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [BoxesController, LoadsController],
  providers: [BoxesService, LoadsService],
  exports: [BoxesService, LoadsService],
})
export class FulfilmentModule {}
