import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { AuditReadService } from './audit-read.service.js'

/// Read-only audit endpoint for the owner's dashboard. Every state and
/// configuration change (AuditLog) plus every inventory movement
/// (LedgerEvent) is merged chronologically and paged with a timestamp
/// cursor, so the owner can trace exactly who did what, where, when, why
/// and how without opening a database console.
@Controller('audit')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER')
export class AuditController {
  constructor(private readonly read: AuditReadService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('entity') entity?: string,
    @Query('actorId') actorId?: string,
    @Query('origin') origin?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('source') source?: string,
  ) {
    return this.read.list({
      cursor,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      entity,
      actorId,
      origin: origin === 'AUDIT_LOG' || origin === 'LEDGER_EVENT' ? origin : undefined,
      from,
      to,
      source,
    })
  }
}
