import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  correctionKey,
  stockCorrectionInputSchema,
  type StockCorrectionInput,
  type StockCorrectionResult,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'

/// Manual reconciliation of a physical count to system. The user supplies a
/// target on-hand at a specific warehouse; we read the current, compute a
/// signed delta, and append one CORRECTION ledger row. If the delta is zero
/// nothing lands — a "confirm the same number twice" click never pollutes
/// the ledger. Idempotency key is derived from a random UUID rather than
/// the input tuple: two independent physical counts that both happen to
/// need "+3" for the same variant should both land as separate rows so the
/// audit trail is unambiguous.
@Injectable()
export class StockCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly ledgerRead: LedgerReadService,
  ) {}

  async correct(raw: StockCorrectionInput, user: CurrentUserPayload): Promise<StockCorrectionResult> {
    const input = stockCorrectionInputSchema.parse(raw)

    const wv = await this.prisma.warehouseVariant.findUnique({
      where: { id: input.warehouseVariantId },
      select: { id: true, variationId: true },
    })
    if (!wv) throw new NotFoundException(`warehouse variant ${input.warehouseVariantId} not found`)

    const location = await this.prisma.location.findUnique({
      where: { id: input.locationId },
      select: { id: true, kind: true },
    })
    if (!location) throw new NotFoundException(`location ${input.locationId} not found`)
    if (location.kind !== 'WAREHOUSE') {
      throw new BadRequestException('corrections may only be applied at WAREHOUSE-kind locations')
    }

    const current = await this.currentOnHand(input.warehouseVariantId, input.locationId)
    const delta = input.newOnHand - current

    if (delta === 0) {
      return { eventId: null, created: false, onHand: current, delta: 0 }
    }

    const originalKey = `manual-count:${randomUUID()}`
    const event = await this.ledger.append({
      type: 'CORRECTION',
      locationId: input.locationId,
      variationId: wv.variationId,
      warehouseVariantId: wv.id,
      quantity: delta,
      occurredAt: new Date(),
      source: 'UI',
      idempotencyKey: correctionKey(originalKey),
      actorId: user.id,
      note: input.note,
    })

    const onHand = await this.currentOnHand(input.warehouseVariantId, input.locationId)
    return { eventId: event.id, created: event.created, onHand, delta }
  }

  private async currentOnHand(warehouseVariantId: string, locationId: string): Promise<number> {
    const agg = await this.prisma.ledgerEvent.aggregate({
      _sum: { quantity: true },
      where: { warehouseVariantId, locationId },
    })
    return agg._sum.quantity ?? 0
  }
}
