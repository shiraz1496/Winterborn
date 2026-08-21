import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { DecisionQueueRow, EvaluateAllResult, EvaluateThresholdResult } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'
import { AuditService } from '../requests/audit.service.js'

/**
 * The threshold engine (spec §9.7). `evaluate` is the whole thing: derive
 * current on-hand for one (variation, location) pair, compare to
 * `Threshold.minLevel`, and on breach either open a new THRESHOLD request
 * for that location or add a line to the one already open there.
 *
 * Stage 1 is manual-review mode -- thresholds exist and auto-draft, but
 * nothing here sends an email, a push notification, or any other alert.
 * The operator finds what this created by looking at the dashboard's
 * decision queue. Automated alerting is Stage 2, deliberately (spec §9.7,
 * §15).
 *
 * Nothing in this file touches `ledger_event`; it only reads through
 * `LedgerReadService` and writes `RestockRequest`/`RestockRequestLine`,
 * so it does not participate in the sole-writer invariant CI enforces on
 * `LedgerService`.
 */
@Injectable()
export class ThresholdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerRead: LedgerReadService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Re-derives on-hand for one pair and auto-drafts on breach. Safe to call
   * repeatedly: a pair that is still breached but already has an open
   * THRESHOLD line returns `created: false` with the existing
   * requestId/lineId rather than stacking a second line (spec §9.7 --
   * "deduped, never stack drafts for the same line"). A pair with no
   * Threshold row at all is simply not evaluated -- there is nothing to
   * breach.
   */
  async evaluate(variationId: string, locationId: string): Promise<EvaluateThresholdResult> {
    const threshold = await this.prisma.threshold.findUnique({
      where: { variationId_locationId: { variationId, locationId } },
    })
    const onHand = await this.ledgerRead.onHandFor(variationId, locationId)

    if (!threshold || onHand >= threshold.minLevel) {
      return {
        breached: false,
        onHand,
        minLevel: threshold?.minLevel ?? null,
        created: false,
        requestId: null,
        lineId: null,
      }
    }

    const qty = Math.max(1, threshold.minLevel - onHand)
    const draft = await this.autoDraft(variationId, locationId, qty)
    return { breached: true, onHand, minLevel: threshold.minLevel, ...draft }
  }

  /** Runs `evaluate` over every configured pair. The wiring point a periodic job (or an operator's "refresh" action on the dashboard) calls -- see docs/DEPLOY.md's render.yaml for where that job runs in production. */
  async evaluateAll(): Promise<EvaluateAllResult> {
    const thresholds = await this.prisma.threshold.findMany({ select: { variationId: true, locationId: true } })
    let breached = 0
    let drafted = 0
    for (const t of thresholds) {
      const result = await this.evaluate(t.variationId, t.locationId)
      if (result.breached) breached++
      if (result.created) drafted++
    }
    return { evaluated: thresholds.length, breached, drafted }
  }

  /**
   * All THRESHOLD-origin requests still awaiting review (DRAFT or OPEN),
   * newest first, each line annotated with the on-hand/minLevel that
   * tripped it (spec §9.9's decision queue). Two bulk reads regardless of
   * how many lines exist -- never one on-hand lookup per line -- because
   * the ledger this reads over holds 40,000+ rows and a per-line query
   * pattern is exactly what a busy Sunday makes catastrophic.
   */
  async decisionQueue(): Promise<DecisionQueueRow[]> {
    const requests = await this.prisma.restockRequest.findMany({
      where: { createdFrom: 'THRESHOLD', state: { in: ['DRAFT', 'OPEN'] } },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
    })
    if (requests.length === 0) return []

    const [stock, thresholds] = await Promise.all([
      this.ledgerRead.onHandByFamily(),
      this.prisma.threshold.findMany({ select: { variationId: true, locationId: true, minLevel: true } }),
    ])
    const onHandByKey = new Map(stock.map((s) => [`${s.variationId}::${s.locationId}`, s.onHand]))
    const minLevelByKey = new Map(thresholds.map((t) => [`${t.variationId}::${t.locationId}`, t.minLevel]))

    return requests.map((r) => ({
      requestId: r.id,
      locationId: r.locationId,
      state: r.state,
      createdAt: r.createdAt,
      lines: r.lines.map((l) => {
        const key = `${l.variationId}::${r.locationId}`
        return {
          lineId: l.id,
          variationId: l.variationId,
          qtyRequested: l.qtyRequested,
          onHand: onHandByKey.get(key) ?? 0,
          minLevel: minLevelByKey.get(key) ?? 0,
        }
      }),
    }))
  }

  /**
   * Dedupe key is (locationId, variationId), scoped to the request's own
   * lines -- not a global lookup -- so every breach at one location during
   * one busy stretch lands on the SAME open THRESHOLD request instead of
   * one request per line. A dozen variations dropping below threshold on
   * a Sunday produces one request the operator reviews once, not a dozen
   * cluttering the queue.
   */
  private async autoDraft(
    variationId: string,
    locationId: string,
    qty: number,
  ): Promise<{ created: boolean; requestId: string; lineId: string }> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const open = await tx.restockRequest.findFirst({
        where: { locationId, createdFrom: 'THRESHOLD', state: { in: ['DRAFT', 'OPEN'] } },
        include: { lines: true },
        orderBy: { createdAt: 'desc' },
      })

      if (open) {
        const existingLine = open.lines.find((l) => l.variationId === variationId)
        if (existingLine) {
          return { created: false, requestId: open.id, lineId: existingLine.id }
        }
        const line = await tx.restockRequestLine.create({
          data: { requestId: open.id, variationId, qtyRequested: qty },
        })
        await this.audit.record(tx, {
          entity: 'RestockRequestLine',
          entityId: line.id,
          field: 'qtyRequested',
          oldValue: null,
          newValue: String(qty),
          actorId: null,
        })
        return { created: true, requestId: open.id, lineId: line.id }
      }

      const request = await tx.restockRequest.create({
        data: {
          locationId,
          createdFrom: 'THRESHOLD',
          lines: { create: [{ variationId, qtyRequested: qty }] },
        },
        include: { lines: true },
      })
      await this.audit.record(tx, {
        entity: 'RestockRequest',
        entityId: request.id,
        field: 'state',
        oldValue: null,
        newValue: request.state,
        actorId: null,
      })
      return { created: true, requestId: request.id, lineId: request.lines[0]!.id }
    })
  }
}
