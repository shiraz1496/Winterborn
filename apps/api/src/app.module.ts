import { Module } from '@nestjs/common'
import { PrismaModule } from './prisma/prisma.module.js'
import { LedgerModule } from './ledger/ledger.module.js'
import { SquareModule } from './square/square.module.js'
import { AuthModule } from './auth/auth.module.js'

@Module({ imports: [PrismaModule, LedgerModule, SquareModule, AuthModule] })
export class AppModule {}
