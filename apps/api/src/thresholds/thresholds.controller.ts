import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common'
import type { EvaluateThresholdInput } from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { ThresholdsService } from './thresholds.service.js'

@Controller('thresholds')
@UseGuards(JwtGuard, RolesGuard)
export class ThresholdsController {
  constructor(
    private readonly thresholds: ThresholdsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Query('locationId') locationId?: string) {
    return this.prisma.threshold.findMany({ where: locationId ? { locationId } : undefined })
  }

  @Get('decision-queue')
  decisionQueue() {
    return this.thresholds.decisionQueue()
  }

  /// Manual/scripted trigger for one pair. Everyone who can see the
  /// dashboard may re-check a single line; only warehouse-side roles may
  /// sweep every configured threshold at once (evaluate-all touches every
  /// market's request queue, not just the one the caller is looking at).
  @Post('evaluate')
  evaluate(@Body() body: EvaluateThresholdInput) {
    return this.thresholds.evaluate(body.variationId, body.locationId)
  }

  @Post('evaluate-all')
  @Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR')
  evaluateAll() {
    return this.thresholds.evaluateAll()
  }
}
