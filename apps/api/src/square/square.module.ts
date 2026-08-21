import { Module } from '@nestjs/common'
import { LedgerModule } from '../ledger/ledger.module.js'
import { WebhookController } from './webhook.controller.js'
import { InboxWorker, ORDER_FETCHER } from './inbox.worker.js'
import { PollService, ORDER_SEARCHER } from './poll.service.js'
import { fetchOrder, searchOrders } from './square-client.js'

/**
 * Wires the Square sync path: webhook receiver, inbox worker, and the
 * reconciliation poll. `PrismaModule` is `@Global()` so it need not be
 * imported here explicitly.
 */
@Module({
  imports: [LedgerModule],
  controllers: [WebhookController],
  providers: [
    InboxWorker,
    PollService,
    { provide: ORDER_FETCHER, useValue: fetchOrder },
    { provide: ORDER_SEARCHER, useValue: searchOrders },
  ],
  exports: [InboxWorker, PollService],
})
export class SquareModule {}
