import { Module } from '@nestjs/common'
import { PrismaModule } from './prisma/prisma.module.js'
import { LedgerModule } from './ledger/ledger.module.js'
import { SquareModule } from './square/square.module.js'
import { AuthModule } from './auth/auth.module.js'
import { RequestsModule } from './requests/requests.module.js'
import { FulfilmentModule } from './fulfilment/fulfilment.module.js'
import { CatalogModule } from './catalog/catalog.module.js'
import { ThresholdsModule } from './thresholds/thresholds.module.js'
import { HealthModule } from './health/health.module.js'
import { IntakeModule } from './intake/intake.module.js'
import { AdminModule } from './admin/admin.module.js'
import { NotificationsModule } from './notifications/notifications.module.js'

@Module({
  imports: [
    PrismaModule,
    LedgerModule,
    SquareModule,
    AuthModule,
    RequestsModule,
    FulfilmentModule,
    CatalogModule,
    ThresholdsModule,
    HealthModule,
    IntakeModule,
    AdminModule,
    NotificationsModule,
  ],
})
export class AppModule {}
