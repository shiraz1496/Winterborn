import { Module } from '@nestjs/common'
import { LedgerModule } from '../ledger/ledger.module.js'
import { WebhookController } from './webhook.controller.js'
import { InboxWorker, ORDER_FETCHER } from './inbox.worker.js'
import { fetchOrder } from './square-client.js'

/**
 * Wires the Square sync path: webhook receiver and inbox worker. Task 2
 * adds `PollService` to this module's providers. `PrismaModule` is
 * `@Global()` so it need not be imported here explicitly.
 */
@Module({
  imports: [LedgerModule],
  controllers: [WebhookController],
  providers: [InboxWorker, { provide: ORDER_FETCHER, useValue: fetchOrder }],
  exports: [InboxWorker],
})
export class SquareModule {}
