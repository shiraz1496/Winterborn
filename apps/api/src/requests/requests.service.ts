import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common'
import type { RequestState } from '@prisma/client'
import {
  createRequestInputSchema,
  createRequestLineInputSchema,
  updateRequestLineInputSchema,
  type CreateRequestInput,
  type CreateRequestLineInput,
  type UpdateRequestLineInput,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { AuditService } from './audit.service.js'

/// A request may only be edited (lines added/changed) before packing starts.
/// Once packing begins the manifest is what's real; the request lines are
/// history from that point on (spec §9.3, §9.4).
const EDITABLE_STATES: readonly RequestState[] = ['DRAFT', 'OPEN']

/**
 * The one explicit map of legal transitions (spec §9.3):
 * DRAFT -> OPEN -> PACKING -> DISPATCHED -> (ARRIVED) -> CLOSED.
 * ARRIVED is optional -- nothing in the math depends on it -- so DISPATCHED
 * may close directly. Every other pair, including a state "transitioning"
 * to itself, is illegal.
 */
export const REQUEST_TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  DRAFT: ['OPEN'],
  OPEN: ['PACKING'],
  PACKING: ['DISPATCHED'],
  DISPATCHED: ['ARRIVED', 'CLOSED'],
  ARRIVED: ['CLOSED'],
  CLOSED: [],
}

@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateRequestInput, actor: CurrentUserPayload) {
    const parsed = createRequestInputSchema.parse(input)
    this.assertLocationAccess(actor, parsed.locationId)

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.restockRequest.create({
        data: {
          locationId: parsed.locationId,
          createdFrom: parsed.createdFrom,
          createdById: actor.id,
          lines: {
            create: parsed.lines.map((l) => ({
              variationId: l.variationId,
              warehouseVariantId: l.warehouseVariantId ?? null,
              qtyRequested: l.qtyRequested,
            })),
          },
        },
        include: { lines: true },
      })
      await this.audit.record(tx, {
        entity: 'RestockRequest',
        entityId: request.id,
        field: 'state',
        oldValue: null,
        newValue: request.state,
        actorId: actor.id,
      })
      return request
    })
  }

  async list(actor: CurrentUserPayload) {
    const where = actor.role === 'MARKET_MANAGER' ? { locationId: actor.locationId ?? '__none__' } : {}
    return this.prisma.restockRequest.findMany({ where, include: { lines: true }, orderBy: { createdAt: 'desc' } })
  }

  async get(id: string, actor: CurrentUserPayload) {
    const request = await this.prisma.restockRequest.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    this.assertLocationAccess(actor, request.locationId)
    return request
  }

  async addLine(requestId: string, input: CreateRequestLineInput, actor: CurrentUserPayload) {
    const parsed = createRequestLineInputSchema.parse(input)

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.restockRequest.findUniqueOrThrow({ where: { id: requestId } })
      this.assertLocationAccess(actor, request.locationId)
      this.assertEditable(request.state)

      const line = await tx.restockRequestLine.create({
        data: {
          requestId,
          variationId: parsed.variationId,
          warehouseVariantId: parsed.warehouseVariantId ?? null,
          qtyRequested: parsed.qtyRequested,
        },
      })
      await this.audit.record(tx, {
        entity: 'RestockRequestLine',
        entityId: line.id,
        field: 'qtyRequested',
        oldValue: null,
        newValue: String(parsed.qtyRequested),
        actorId: actor.id,
      })
      return line
    })
  }

  async updateLine(requestId: string, lineId: string, input: UpdateRequestLineInput, actor: CurrentUserPayload) {
    const parsed = updateRequestLineInputSchema.parse(input)

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.restockRequest.findUniqueOrThrow({ where: { id: requestId } })
      this.assertLocationAccess(actor, request.locationId)
      this.assertEditable(request.state)

      const existing = await tx.restockRequestLine.findUniqueOrThrow({ where: { id: lineId } })

      const changingQty = parsed.qtyRequested !== undefined && parsed.qtyRequested !== existing.qtyRequested
      const changingVariant =
        parsed.warehouseVariantId !== undefined && parsed.warehouseVariantId !== existing.warehouseVariantId

      const updated = await tx.restockRequestLine.update({
        where: { id: lineId },
        data: {
          ...(changingQty ? { qtyRequested: parsed.qtyRequested } : {}),
          ...(changingVariant ? { warehouseVariantId: parsed.warehouseVariantId } : {}),
        },
      })

      if (changingQty) {
        await this.audit.record(tx, {
          entity: 'RestockRequestLine',
          entityId: lineId,
          field: 'qtyRequested',
          oldValue: String(existing.qtyRequested),
          newValue: String(updated.qtyRequested),
          actorId: actor.id,
        })
      }
      if (changingVariant) {
        await this.audit.record(tx, {
          entity: 'RestockRequestLine',
          entityId: lineId,
          field: 'warehouseVariantId',
          oldValue: existing.warehouseVariantId,
          newValue: updated.warehouseVariantId,
          actorId: actor.id,
        })
      }
      return updated
    })
  }

  async transition(requestId: string, toState: RequestState, actor: CurrentUserPayload) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.restockRequest.findUniqueOrThrow({ where: { id: requestId } })
      this.assertLocationAccess(actor, request.locationId)

      const allowed = REQUEST_TRANSITIONS[request.state]
      if (!allowed.includes(toState)) {
        throw new BadRequestException(`illegal transition ${request.state} -> ${toState}`)
      }

      const updated = await tx.restockRequest.update({
        where: { id: requestId },
        data: { state: toState, closedAt: toState === 'CLOSED' ? new Date() : undefined },
      })
      await this.audit.record(tx, {
        entity: 'RestockRequest',
        entityId: requestId,
        field: 'state',
        oldValue: request.state,
        newValue: toState,
        actorId: actor.id,
      })
      return updated
    })
  }

  private assertLocationAccess(actor: CurrentUserPayload, locationId: string): void {
    if (actor.role === 'MARKET_MANAGER' && actor.locationId !== locationId) {
      throw new ForbiddenException("cannot access another location's request")
    }
  }

  private assertEditable(state: RequestState): void {
    if (!EDITABLE_STATES.includes(state)) {
      throw new BadRequestException(`request lines cannot be edited once packing has started (state=${state})`)
    }
  }
}
