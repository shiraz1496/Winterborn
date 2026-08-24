import { Injectable, NotFoundException } from '@nestjs/common'
import { intakeInputSchema, intakeKey, type IntakeInput, type IntakeResult } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'

/// Doc 3 §3.1. Receiving goods at the warehouse is one INTAKE ledger row,
/// posted through LedgerService like every other movement so the sole-writer
/// invariant CI enforces stays intact.
///
/// Idempotency: the client sends a token generated once per "confirm" click;
/// intakeKey() wraps it into the ledger's namespaced form. A retry submits
/// the identical body and the ledger returns the original row with
/// created=false. Never build the key from the fields alone -- two intakes
/// of the same variant/qty on the same shift would collapse into one.
@Injectable()
export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly ledgerRead: LedgerReadService,
  ) {}

  async receive(raw: IntakeInput, user: CurrentUserPayload): Promise<IntakeResult> {
    const input = intakeInputSchema.parse(raw)

    const warehouseVariant = await this.prisma.warehouseVariant.findUnique({
      where: { id: input.warehouseVariantId },
      select: { id: true, variationId: true },
    })
    if (!warehouseVariant) {
      throw new NotFoundException(`warehouse variant ${input.warehouseVariantId} not found`)
    }

    const warehouse = await this.prisma.location.findFirst({ where: { kind: 'WAREHOUSE' } })
    if (!warehouse) {
      throw new NotFoundException('no WAREHOUSE location configured')
    }

    const event = await this.ledger.append({
      type: 'INTAKE',
      locationId: warehouse.id,
      variationId: warehouseVariant.variationId,
      warehouseVariantId: warehouseVariant.id,
      quantity: input.quantity,
      occurredAt: new Date(),
      source: 'UI',
      idempotencyKey: intakeKey(input.idempotencyToken),
      actorId: user.id,
      note: input.note,
    })

    const onHand = await this.ledgerRead.onHandFor(warehouseVariant.variationId, warehouse.id)

    return {
      eventId: event.id,
      created: event.created,
      onHand,
      warehouseVariantId: warehouseVariant.id,
      variationId: warehouseVariant.variationId,
    }
  }
}
