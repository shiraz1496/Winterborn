import { Module } from '@nestjs/common'
import { PrismaModule } from './prisma/prisma.module.js'
import { LedgerModule } from './ledger/ledger.module.js'
import { SquareModule } from './square/square.module.js'

@Module({ imports: [PrismaModule, LedgerModule, SquareModule] })
export class AppModule {}
