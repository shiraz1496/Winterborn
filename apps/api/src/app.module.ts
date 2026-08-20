import { Module } from '@nestjs/common'
import { PrismaModule } from './prisma/prisma.module.js'
import { LedgerModule } from './ledger/ledger.module.js'

@Module({ imports: [PrismaModule, LedgerModule] })
export class AppModule {}
