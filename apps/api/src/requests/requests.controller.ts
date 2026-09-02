import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import {
  generateSuggestionInputSchema,
  type CreateRequestInput,
  type CreateRequestLineInput,
  type GenerateSuggestionInput,
  type TransitionRequestInput,
  type UpdateRequestLineInput,
} from '@winterborn/shared'
import { JwtGuard } from '../auth/jwt.guard.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { Roles } from '../auth/roles.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { RequestsService } from './requests.service.js'
import { RequestAnalysisService } from './request-analysis.service.js'
import { PackingListSuggestionService } from './packing-list-suggestion.service.js'

@Controller('requests')
@UseGuards(JwtGuard, RolesGuard)
@Roles('OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER')
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly analysis: RequestAnalysisService,
    private readonly suggestion: PackingListSuggestionService,
  ) {}

  @Post()
  create(@Body() body: CreateRequestInput, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.create(body, user)
  }

  /// Draft-a-whole-packing-list endpoint (CEO ask, voice notes 2026-09-01).
  /// Owner only — the packing list draws on cross-market data (warehouse
  /// stock, competing demand from other markets, colour mix per market)
  /// and drives allocation decisions across the whole network. That's an
  /// Owner-scope decision, not a per-market one. Market Managers can still
  /// submit requests manually from `/requests/new`; they just do not get
  /// the auto-generate path.
  @Post('generate-suggestion')
  async generateSuggestion(
    @Body() body: GenerateSuggestionInput,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    if (user.role !== 'OWNER') {
      throw new ForbiddenException(`${user.role} may not generate packing lists — Owner only`)
    }
    const parsed = generateSuggestionInputSchema.parse(body)
    return this.suggestion.generate(parsed)
  }

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.requests.list(user)
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.get(id, user)
  }

  /// Doc 3 §3.3 recommendation + §3.4 overallocation guard, in one call so
  /// the UI never renders one figure against a stale snapshot of the other.
  /// Access control mirrors `get`: MARKET_MANAGER only sees their own market.
  @Get(':id/analysis')
  async getAnalysis(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    await this.requests.get(id, user)
    return this.analysis.analyse(id)
  }

  @Post(':id/lines')
  addLine(@Param('id') id: string, @Body() body: CreateRequestLineInput, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.addLine(id, body, user)
  }

  @Patch(':id/lines/:lineId')
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: UpdateRequestLineInput,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.requests.updateLine(id, lineId, body, user)
  }

  @Post(':id/transition')
  transition(
    @Param('id') id: string,
    @Body() body: TransitionRequestInput,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.requests.transition(id, body.state, user)
  }

  /// Market Manager flags a dispatched request as never arrived. Writes
  /// an AuditLog row that surfaces in the notification feed for the
  /// warehouse to investigate. Deliberately does NOT change the request
  /// state — the box may still turn up; the MM can click "Received"
  /// later once it does.
  @Post(':id/report-missing')
  reportMissing(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.reportMissing(id, user)
  }

  /// Warehouse-side "undo pack" — discards every solo PACKING box on
  /// this request and lets the auto-reconcile in BoxesService pull the
  /// request state back from PACKED to PACKING. Shared boxes are left
  /// alone and reported in `sharedSkipped` so the client can route the
  /// operator to the shipment view for those.
  @Post(':id/unpack')
  unpack(@Param('id') id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.requests.unpack(id, user)
  }
}
