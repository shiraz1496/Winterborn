import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common'
import type { Prisma, RequestState } from '@prisma/client'
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
import { AuditService } from '../audit/audit.service.js'
import { BoxesService } from '../fulfilment/boxes.service.js'

/// A request may only be edited (lines added/changed) before packing starts.
/// Once packing begins the manifest is what's real; the request lines are
/// history from that point on (spec §9.3, §9.4).
const EDITABLE_STATES: readonly RequestState[] = ['DRAFT', 'OPEN']

/**
 * The one explicit map of legal transitions (spec §9.3):
 * DRAFT -> OPEN -> PACKING -> (PACKED) -> DISPATCHED -> (ARRIVED) -> CLOSED.
 * ARRIVED is optional -- nothing in the math depends on it -- so DISPATCHED
 * may close directly. PACKED is inserted between PACKING and DISPATCHED
 * for the "fully packed, waiting to ship" bucket; the pack service moves
 * a request into PACKED automatically once every requested unit is on a
 * non-dispatched box, and back to PACKING if a box is discarded.
 * PACKING can still dispatch directly (partial dispatch — the leftover
 * units are dropped, which is why the UI warns first).
 * Every other pair, including a state "transitioning" to itself, is
 * illegal.
 */
export const REQUEST_TRANSITIONS: Readonly<Record<RequestState, readonly RequestState[]>> = {
  DRAFT: ['OPEN'],
  OPEN: ['PACKING'],
  PACKING: ['PACKED', 'DISPATCHED'],
  PACKED: ['PACKING', 'DISPATCHED'],
  DISPATCHED: ['ARRIVED', 'CLOSED'],
  ARRIVED: ['CLOSED'],
  CLOSED: [],
}

/// Per-transition role gate, matched to the UI's NEXT_TRANSITION map in
/// apps/web/app/requests/[id]/page.tsx. Any change here has to change
/// there too (or the button will render but the API will 403).
///
///   Submit (DRAFT→OPEN):         MM (requester) or OWNER
///   Approve/pack (OPEN→PACKING): warehouse roles only
///   Pack complete (PACKING↔PACKED / PACKED→DISPATCHED):
///                                warehouse roles only. These are
///                                normally fired automatically by
///                                BoxesService, but the manual
///                                transition endpoint has to allow them
///                                too so a warehouse operator can force
///                                the state if e.g. a physical count
///                                overrides the automatic decision.
///   Ship (PACKING→DISPATCHED):   warehouse roles only
///   Receive (→CLOSED):           MM only — arrival is what only the
///                                destination can attest to.
// Partial: only the legal transitions are keys. Missing key = illegal,
// handled at the lookup site (see `if (!allowedRoles)` below). Without
// Partial, TS demands all State×State combinations be present.
const TRANSITION_ROLES: Readonly<Partial<Record<`${RequestState}->${RequestState}`, readonly CurrentUserPayload['role'][]>>> = {
  'DRAFT->OPEN': ['MARKET_MANAGER', 'OWNER'],
  'OPEN->PACKING': ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'],
  'PACKING->PACKED': ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'],
  'PACKED->PACKING': ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'],
  'PACKING->DISPATCHED': ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'],
  'PACKED->DISPATCHED': ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'],
  'DISPATCHED->ARRIVED': ['MARKET_MANAGER'],
  'DISPATCHED->CLOSED': ['MARKET_MANAGER'],
  'ARRIVED->CLOSED': ['MARKET_MANAGER'],
}

@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly boxes: BoxesService,
  ) {}

  async create(input: CreateRequestInput, actor: CurrentUserPayload) {
    const parsed = createRequestInputSchema.parse(input)
    this.assertLocationAccess(actor, parsed.locationId)
    this.assertCanEditLines(actor, parsed.locationId)

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
    // Base scope: MMs see only their own market's requests; warehouse
    // roles see every market's.
    const where: Prisma.RestockRequestWhereInput =
      actor.role === 'MARKET_MANAGER' ? { locationId: actor.locationId ?? '__none__' } : {}

    // DRAFTs are visible only to their author's side of the workflow —
    // the Market Manager who owns the market and the Owner who oversees
    // everything. Warehouse Manager / Operator have no reason to see a
    // half-composed request (they can't act on it until it's submitted),
    // and showing DRAFTs to them created the confusing UX where a WM
    // could see the row but hitting "Submit" would 403 server-side.
    if (actor.role !== 'MARKET_MANAGER' && actor.role !== 'OWNER') {
      where.state = { not: 'DRAFT' }
    }

    return this.prisma.restockRequest.findMany({ where, include: { lines: true }, orderBy: { createdAt: 'desc' } })
  }

  async get(id: string, actor: CurrentUserPayload) {
    const request = await this.prisma.restockRequest.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    this.assertLocationAccess(actor, request.locationId)
    // Match the list filter: a DRAFT is only visible to its author's side
    // (MM/Owner). Warehouse-side roles landing on the URL directly get a
    // 403 instead of a rendered but unactionable page.
    if (
      request.state === 'DRAFT' &&
      actor.role !== 'MARKET_MANAGER' &&
      actor.role !== 'OWNER'
    ) {
      throw new ForbiddenException('this request is still a draft — the market has not submitted it yet')
    }
    return request
  }

  async addLine(requestId: string, input: CreateRequestLineInput, actor: CurrentUserPayload) {
    const parsed = createRequestLineInputSchema.parse(input)

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.restockRequest.findUniqueOrThrow({ where: { id: requestId } })
      this.assertLocationAccess(actor, request.locationId)
      this.assertCanEditLines(actor, request.locationId)
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
      this.assertCanEditLines(actor, request.locationId)
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
    // Doc §6.4: closing a request from DISPATCHED/ARRIVED means "the
    // destination has physically received the shipment". Before the
    // state changes, post the INTAKE ledger rows so the market's on-
    // hand finally reflects what actually arrived. This is what makes
    // "in transit" a real concept: between DISPATCH and receive, stock
    // has left the warehouse but is not counted anywhere.
    //
    // Done OUTSIDE the transition transaction because ledger writes are
    // append-only (a nested tx would fight the append-only trigger's
    // ordering guarantee) and are idempotent, so a retry is safe.
    const before = await this.prisma.restockRequest.findUniqueOrThrow({ where: { id: requestId } })
    this.assertLocationAccess(actor, before.locationId)

    if (before.state !== toState) {
      const key = `${before.state}->${toState}` as keyof typeof TRANSITION_ROLES
      const allowedRoles = TRANSITION_ROLES[key]
      if (!allowedRoles) {
        throw new BadRequestException(`illegal transition ${before.state} -> ${toState}`)
      }
      if (!allowedRoles.includes(actor.role)) {
        throw new ForbiddenException(
          `${actor.role} may not transition a request ${before.state} -> ${toState}`,
        )
      }
    }

    if (before.state !== toState && toState === 'CLOSED' && (before.state === 'DISPATCHED' || before.state === 'ARRIVED')) {
      await this.boxes.receiveForRequest(requestId, actor)
    }

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.restockRequest.findUniqueOrThrow({ where: { id: requestId } })

      // Idempotent: if the caller asks for the state the request is
      // already in, no-op. Absorbs React StrictMode double-renders and
      // any race between two tabs -- no duplicate audit row for a
      // transition that has already happened.
      if (request.state === toState) {
        return request
      }

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

  /// Unpack every solo PACKING box for this request, dropping the state
  /// back to PACKING via reconcile. Warehouse-side only — the market
  /// never touches boxes. Shared multi-request boxes are skipped and
  /// reported back to the caller so the UI can direct the operator to
  /// the shipment view for those.
  async unpack(requestId: string, actor: CurrentUserPayload) {
    if (
      actor.role !== 'OWNER' &&
      actor.role !== 'WAREHOUSE_MANAGER' &&
      actor.role !== 'WAREHOUSE_OPERATOR'
    ) {
      throw new ForbiddenException(`${actor.role} may not unpack a request`)
    }
    const request = await this.prisma.restockRequest.findUniqueOrThrow({ where: { id: requestId } })
    this.assertLocationAccess(actor, request.locationId)
    return this.boxes.unpackForRequest(requestId, actor)
  }

  /// Flags a dispatched request as "not received" from the destination's
  /// point of view. Writes an AuditLog row that the notification feed
  /// picks up and surfaces to Owner + WM to investigate. Does not change
  /// request state — the box may still land later, in which case the MM
  /// clicks Received and the request closes normally.
  async reportMissing(requestId: string, actor: CurrentUserPayload) {
    if (actor.role !== 'MARKET_MANAGER') {
      // Reporting an in-transit box missing is an attestation from the
      // destination — only the market manager can make it. Warehouse
      // can't know whether a physical box arrived or not.
      throw new ForbiddenException('only the market manager may flag a shipment as not received')
    }
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.restockRequest.findUniqueOrThrow({ where: { id: requestId } })
      this.assertLocationAccess(actor, request.locationId)

      if (request.state !== 'DISPATCHED' && request.state !== 'ARRIVED') {
        throw new BadRequestException(
          `only DISPATCHED requests can be reported missing (state=${request.state})`,
        )
      }

      await this.audit.record(tx, {
        entity: 'RestockRequest',
        entityId: requestId,
        field: 'not_received',
        oldValue: null,
        newValue: new Date().toISOString(),
        actorId: actor.id,
      })
      return { ok: true }
    })
  }

  private assertLocationAccess(actor: CurrentUserPayload, locationId: string): void {
    if (actor.role === 'MARKET_MANAGER' && actor.locationId !== locationId) {
      throw new ForbiddenException("cannot access another location's request")
    }
  }

  /// Lines belong to the requester. Only the market's own MM or OWNER
  /// can add/change what was asked for; warehouse never edits demand.
  private assertCanEditLines(actor: CurrentUserPayload, locationId: string): void {
    if (actor.role === 'OWNER') return
    if (actor.role === 'MARKET_MANAGER' && actor.locationId === locationId) return
    throw new ForbiddenException(`${actor.role} may not edit request lines`)
  }

  private assertEditable(state: RequestState): void {
    if (!EDITABLE_STATES.includes(state)) {
      throw new BadRequestException(`request lines cannot be edited once packing has started (state=${state})`)
    }
  }
}
