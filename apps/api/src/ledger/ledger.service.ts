import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  appendEventInputSchema,
  transferInputSchema,
  type AppendEventInput,
  type TransferInput,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

const UNIQUE_VIOLATION = 'P2002'

/**
 * The sole writer to ledger_event.
 *
 * Nothing else in the system inserts into that table. This service owns
 * idempotency, transfer pairing and validation, which is what makes the
 * derivation in LedgerReadService trustworthy: every row that exists got
 * there through one code path with one set of rules.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one event. Safe to call repeatedly with the same idempotencyKey:
   * the second and later calls return the original row with created=false.
   *
   * That property is load-bearing. The webhook path and the reconciliation
   * poll deliberately produce identical keys for the same sale, so a week of
   * missed webhooks self-heals on one poll pass without double-counting.
   */
  async append(input: AppendEventInput): Promise<{ id: string; created: boolean }> {
    const e = appendEventInputSchema.parse(input)
    try {
      const row = await this.prisma.ledgerEvent.create({
        data: {
          type: e.type,
          locationId: e.locationId,
          variationId: e.variationId,
          warehouseVariantId: e.warehouseVariantId ?? null,
          quantity: e.quantity,
          occurredAt: e.occurredAt,
          source: e.source,
          sourceRef: e.sourceRef ?? null,
          idempotencyKey: e.idempotencyKey,
          actorId: e.actorId ?? null,
          transferId: e.transferId ?? null,
          reason: e.reason ?? null,
          note: e.note ?? null,
        },
      })
      return { id: row.id, created: true }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        const existing = await this.prisma.ledgerEvent.findUniqueOrThrow({
          where: { idempotencyKey: e.idempotencyKey },
        })
        return { id: existing.id, created: false }
      }
      throw err
    }
  }

  /**
   * Writes a transfer as two rows sharing a transferId: negative at the source,
   * positive at the destination.
   *
   * Both rows are written in one transaction. A half-written transfer would
   * subtract stock from the warehouse without adding it anywhere, which the
   * derivation cannot detect and no later replay can repair, because replay
   * faithfully reproduces whatever rows exist.
   *
   * Idempotency mirrors append(): no pre-check read, just attempt the write
   * and catch the unique violation on the `:from` key. A pre-check-then-write
   * is a TOCTOU race under concurrent duplicate calls (the same retry storm
   * append() is built to absorb); relying on the DB constraint instead means
   * the loser of a race gets the same graceful {created:false} response as
   * any other repeat delivery, not an unhandled exception.
   */
  async transfer(input: TransferInput): Promise<{ transferId: string; created: boolean }> {
    const t = transferInputSchema.parse(input)
    const fromKey = `${t.idempotencyKeyPrefix}:from`
    const toKey = `${t.idempotencyKeyPrefix}:to`

    const transferId = randomUUID()
    const common = {
      type: t.type,
      variationId: t.variationId,
      warehouseVariantId: t.warehouseVariantId,
      occurredAt: t.occurredAt,
      source: t.source,
      sourceRef: t.sourceRef ?? null,
      actorId: t.actorId ?? null,
      transferId,
      note: t.note ?? null,
    }

    try {
      await this.prisma.$transaction([
        this.prisma.ledgerEvent.create({
          data: { ...common, locationId: t.fromLocationId, quantity: -t.quantity, idempotencyKey: fromKey },
        }),
        this.prisma.ledgerEvent.create({
          data: { ...common, locationId: t.toLocationId, quantity: t.quantity, idempotencyKey: toKey },
        }),
      ])
      return { transferId, created: true }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        const existing = await this.prisma.ledgerEvent.findUniqueOrThrow({
          where: { idempotencyKey: fromKey },
        })
        if (existing.transferId) {
          return { transferId: existing.transferId, created: false }
        }
      }
      throw err
    }
  }
}
