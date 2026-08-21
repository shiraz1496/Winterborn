import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { RequestsService } from './requests.service.js'
import { RequestsController } from './requests.controller.js'
import { AuditService } from './audit.service.js'

@Module({
  imports: [AuthModule],
  controllers: [RequestsController],
  providers: [RequestsService, AuditService],
  exports: [RequestsService, AuditService],
})
export class RequestsModule {}
