import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes, randomUUID } from 'node:crypto'
import { transferKeyPrefix, type ReceiveBoxResult } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'

/// Thrown when a pack or dispatch would drive warehouse stock below zero.
/// The details array lets the frontend render a clear per-line alert like
/// "Cannot send 12 of Blue / Small — only 5 available".
export interface InsufficientStockDetail {
  warehouseVariantId: string
  requested: number
  available: number
}
export class InsufficientStockException extends BadRequestException {
  constructor(public readonly details: InsufficientStockDetail[]) {
    super({
      message: 'Not enough stock to complete this action',
      code: 'INSUFFICIENT_STOCK',
      details,
    })
  }
}

export interface PackBoxLineInput {
  warehouseVariantId: string
  quantity: number
}

export interface PackBoxInput {
  destinationLocationId: string
  requestId?: string
  lines: PackBoxLineInput[]
}

export interface BoxLabelLine {
  warehouseVariantId: string
  itemGroupName: string
  colourVariantName: string
  sizeOptionName: string
  warehouseSku: string
  quantity: number
}

export interface BoxLabel {
  qrToken: string
  destinationLocationId: string
  destinationLocationName: string
  lineCount: number
  packedAt: Date | null
  lines: BoxLabelLine[]
}

/**
 * Packing, box manifests, and dispatch to the ledger (spec §9.4).
 *
 * The packer resolves a family-level request line ("60 gray") into concrete
 * warehouse variants ("40 Charcoal + 20 Ash"); the box manifest (BoxLine)
 * only ever records variant level -- that resolution is what makes this the
 * point where variant precision enters the ledger.
 */
@Injectable()
export class BoxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly ledgerRead: LedgerReadService,
  ) {}

  /// Compute how many units of each warehouse variant can still be committed
  /// to a new box line at the warehouse. Deducts quantities already committed
  /// to boxes that are packed but not yet dispatched (state = PACKING) — those
  /// units are reserved even though the ledger doesn't reflect them yet.
  ///
  /// Returns a Map keyed by warehouseVariantId with the available count.
  /// Missing keys mean "no stock recorded" (0 on-hand, 0 reserved).
  async availableAtWarehouse(warehouseVariantIds: string[]): Promise<Map<string, number>> {
    if (warehouseVariantIds.length === 0) return new Map()
    const warehouse = await this.prisma.location.findFirst({ where: { kind: 'WAREHOUSE' } })
    if (!warehouse) return new Map()

    const [onHandRows, reservedRows] = await Promise.all([
      this.prisma.ledgerEvent.groupBy({
        by: ['warehouseVariantId'],
        _sum: { quantity: true },
        where: {
          locationId: warehouse.id,
          warehouseVariantId: { in: warehouseVariantIds },
        },
      }),
      this.prisma.boxLine.groupBy({
        by: ['warehouseVariantId'],
        _sum: { quantity: true },
        where: {
          warehouseVariantId: { in: warehouseVariantIds },
          box: { state: 'PACKING' },
        },
      }),
    ])

    const onHandById = new Map<string, number>()
    for (const r of onHandRows) {
      if (r.warehouseVariantId) onHandById.set(r.warehouseVariantId, r._sum.quantity ?? 0)
    }
    const reservedById = new Map<string, number>()
    for (const r of reservedRows) {
      if (r.warehouseVariantId) reservedById.set(r.warehouseVariantId, r._sum.quantity ?? 0)
    }

    const available = new Map<string, number>()
    for (const wvId of warehouseVariantIds) {
      const on = onHandById.get(wvId) ?? 0
      const reserved = reservedById.get(wvId) ?? 0
      available.set(wvId, on - reserved)
    }
    return available
  }

  async pack(input: PackBoxInput, actor: CurrentUserPayload) {
    if (input.lines.length === 0) throw new BadRequestException('a box must be packed with at least one line')
    for (const line of input.lines) {
      if (line.quantity <= 0) throw new BadRequestException('box line quantity must be positive')
    }

    // Prevent packing more than the warehouse can supply. Rolls up any
    // duplicate warehouseVariantIds in the same request first so committing
    // two lines of 5 against 8 on-hand fails before either row lands.
    const requestedByVariant = new Map<string, number>()
    for (const line of input.lines) {
      requestedByVariant.set(
        line.warehouseVariantId,
        (requestedByVariant.get(line.warehouseVariantId) ?? 0) + line.quantity,
      )
    }
    const available = await this.availableAtWarehouse(Array.from(requestedByVariant.keys()))
    const shortfall: InsufficientStockDetail[] = []
    for (const [warehouseVariantId, requested] of requestedByVariant) {
      const avail = available.get(warehouseVariantId) ?? 0
      if (requested > avail) shortfall.push({ warehouseVariantId, requested, available: avail })
    }
    if (shortfall.length > 0) throw new InsufficientStockException(shortfall)

    // Opaque, carries no contents -- the QR encodes this token only (spec
    // §9.4). Contents live entirely in BoxLine, so editing the manifest
    // before dispatch never orphans the printed label.
    const qrToken = randomBytes(16).toString('base64url')

    return this.prisma.box.create({
      data: {
        requestId: input.requestId ?? null,
        destinationLocationId: input.destinationLocationId,
        qrToken,
        packedById: actor.id,
        packedAt: new Date(),
        lines: { create: input.lines.map((l) => ({ warehouseVariantId: l.warehouseVariantId, quantity: l.quantity })) },
      },
      include: { lines: true },
    })
  }

  /// Filters are AND'd together; both are optional so /pack/[requestId] can
  /// ask "boxes for this request" and a plain box browser can ask "boxes
  /// headed to this market" without two endpoints.
  async list(
    filter: { requestId?: string; destinationLocationId?: string },
    actor?: CurrentUserPayload,
  ) {
    // Market managers are scoped to their own market's boxes — the UI
    // shows box progress for a request they're closing, and they have
    // no reason to see other markets' boxes. Warehouse roles see
    // everything and don't get filtered.
    const scopedLocationId =
      actor?.role === 'MARKET_MANAGER' ? actor.locationId ?? undefined : undefined
    return this.prisma.box.findMany({
      where: {
        ...(filter.requestId ? { requestId: filter.requestId } : {}),
        ...(filter.destinationLocationId ? { destinationLocationId: filter.destinationLocationId } : {}),
        ...(scopedLocationId ? { destinationLocationId: scopedLocationId } : {}),
      },
      include: { lines: true },
      orderBy: { packedAt: 'desc' },
    })
  }

  async get(id: string) {
    return this.prisma.box.findUniqueOrThrow({ where: { id }, include: { lines: true } })
  }

  /// The QR label encodes `qrToken` only (spec §9.4) -- this is how a scan
  /// resolves that opaque string back to the box and its manifest, for the
  /// human to confirm before /scan calls dispatch.
  async getByToken(qrToken: string) {
    return this.prisma.box.findUniqueOrThrow({ where: { qrToken }, include: { lines: true } })
  }

  async addLine(boxId: string, input: PackBoxLineInput) {
    if (input.quantity <= 0) throw new BadRequestException('box line quantity must be positive')
    const box = await this.prisma.box.findUniqueOrThrow({ where: { id: boxId } })
    if (box.state !== 'PACKING') {
      throw new BadRequestException(`box lines cannot be edited once dispatched (state=${box.state})`)
    }
    const available = await this.availableAtWarehouse([input.warehouseVariantId])
    const avail = available.get(input.warehouseVariantId) ?? 0
    if (input.quantity > avail) {
      throw new InsufficientStockException([
        { warehouseVariantId: input.warehouseVariantId, requested: input.quantity, available: avail },
      ])
    }
    return this.prisma.boxLine.create({
      data: { boxId, warehouseVariantId: input.warehouseVariantId, quantity: input.quantity },
    })
  }

  /**
   * Doc §6.4 — dispatch is now HALF a transfer. It writes only the
   * negative-at-source ledger row. The positive-at-destination row is
   * written later by `receiveForRequest()` when the market manager
   * confirms arrival. Stock that has left the warehouse but not yet been
   * received is "in transit": it is decremented at the warehouse but is
   * not yet counted at the market, so a market's on-hand only reflects
   * what the market physically has.
   *
   * Idempotency: each line's DISPATCH row uses the key
   * `dispatch:${boxId}:${wvId}:from`, stable across calls. A re-dispatch
   * of the same box is a no-op, not a double-decrement. The matching
   * INTAKE row uses `dispatch:${boxId}:${wvId}:to` so the two rows share
   * a transferId and can be joined later.
   */
  async dispatch(boxId: string, actor?: CurrentUserPayload) {
    const box = await this.prisma.box.findUnique({ where: { id: boxId }, include: { lines: true } })
    if (!box) throw new NotFoundException(`box ${boxId} not found`)

    const warehouse = await this.prisma.location.findFirstOrThrow({ where: { kind: 'WAREHOUSE' } })
    const now = new Date()

    // Safety net: even after the pack-time reservation guard, verify that
    // physical ledger on-hand still covers this box's lines. Race conditions
    // (two boxes packed simultaneously against the same shrinking pool, or
    // an out-of-band SALE while a box sat in PACKING) could otherwise let a
    // dispatch drive stock below zero. Idempotent re-dispatches are exempt
    // because their DISPATCH row already exists and the ledger append is a
    // no-op — check state before enforcing.
    if (box.state !== 'DISPATCHED') {
      const perLineRequested = new Map<string, number>()
      for (const line of box.lines) {
        perLineRequested.set(
          line.warehouseVariantId,
          (perLineRequested.get(line.warehouseVariantId) ?? 0) + line.quantity,
        )
      }
      const shortfall: InsufficientStockDetail[] = []
      for (const [warehouseVariantId, requested] of perLineRequested) {
        const onHand = await this.ledgerRead.onHandForWarehouseVariant(warehouseVariantId, warehouse.id)
        if (requested > onHand) shortfall.push({ warehouseVariantId, requested, available: onHand })
      }
      if (shortfall.length > 0) throw new InsufficientStockException(shortfall)
    }

    // One transferId per box, so both the DISPATCH row (now) and the
    // eventual INTAKE row (on receive) can be joined.
    const transferId = box.dispatchedAt ? undefined : randomUUID()

    const posted: { warehouseVariantId: string; created: boolean }[] = []
    for (const line of box.lines) {
      const wv = await this.prisma.warehouseVariant.findUniqueOrThrow({ where: { id: line.warehouseVariantId } })
      const result = await this.ledger.append({
        type: 'DISPATCH',
        locationId: warehouse.id,
        variationId: wv.variationId,
        warehouseVariantId: wv.id,
        quantity: -line.quantity,
        occurredAt: now,
        source: 'UI',
        sourceRef: boxId,
        idempotencyKey: `${transferKeyPrefix('dispatch', boxId, wv.id)}:from`,
        actorId: actor?.id,
        transferId,
      })
      posted.push({ warehouseVariantId: wv.id, created: result.created })
    }

    if (box.state !== 'DISPATCHED') {
      await this.prisma.box.update({ where: { id: boxId }, data: { state: 'DISPATCHED', dispatchedAt: now } })
    }

    // Auto-advance the parent request to DISPATCHED on first box send.
    if (box.requestId) {
      const request = await this.prisma.restockRequest.findUnique({ where: { id: box.requestId } })
      if (request && request.state === 'PACKING') {
        await this.prisma.$transaction([
          this.prisma.restockRequest.update({
            where: { id: box.requestId },
            data: { state: 'DISPATCHED' },
          }),
          this.prisma.auditLog.create({
            data: {
              entity: 'RestockRequest',
              entityId: box.requestId,
              field: 'state',
              oldValue: 'PACKING',
              newValue: 'DISPATCHED',
              actorId: actor?.id ?? null,
            },
          }),
        ])
      }
    }

    return { boxId, dispatched: posted }
  }

  /**
   * Doc §6.4 — arrival confirmation. Called when the market manager
   * clicks "Received & close" on a dispatched request. For each of the
   * request's boxes that were dispatched, writes the positive-at-
   * destination INTAKE row with the SAME transferId the DISPATCH row
   * used, so the two rows can be joined and the market's on-hand
   * finally reflects the delivered stock. Also marks each box ARRIVED.
   *
   * Idempotent: the INTAKE row uses key `dispatch:${boxId}:${wvId}:to`.
   * Re-receiving the same request is a no-op. This means a box that was
   * dispatched under the OLD atomic-transfer code (which wrote both
   * rows at dispatch time using the same keys) will be recognised here
   * as already received -- no double-add.
   */
  async receiveForRequest(requestId: string, actor?: CurrentUserPayload): Promise<{ boxesReceived: number; linesPosted: number }> {
    const boxes = await this.prisma.box.findMany({
      where: { requestId, state: { in: ['DISPATCHED', 'ARRIVED'] } },
      include: { lines: true },
    })

    let boxesReceived = 0
    let linesPosted = 0
    const now = new Date()

    for (const box of boxes) {
      // The transferId lives on the DISPATCH row already appended for this
      // box. Fish one out to reuse it, so DISPATCH and INTAKE stay paired.
      const existing = await this.prisma.ledgerEvent.findFirst({
        where: { sourceRef: box.id, type: 'DISPATCH' },
        select: { transferId: true },
      })
      const transferId = existing?.transferId ?? undefined

      for (const line of box.lines) {
        const wv = await this.prisma.warehouseVariant.findUniqueOrThrow({ where: { id: line.warehouseVariantId } })
        const result = await this.ledger.append({
          type: 'INTAKE',
          locationId: box.destinationLocationId,
          variationId: wv.variationId,
          warehouseVariantId: wv.id,
          quantity: line.quantity,
          occurredAt: now,
          source: 'UI',
          sourceRef: box.id,
          idempotencyKey: `${transferKeyPrefix('dispatch', box.id, wv.id)}:to`,
          actorId: actor?.id,
          transferId,
        })
        if (result.created) linesPosted++
      }

      if (box.state !== 'ARRIVED') {
        await this.prisma.box.update({ where: { id: box.id }, data: { state: 'ARRIVED', arrivedAt: now } })
      }
      boxesReceived++
    }

    return { boxesReceived, linesPosted }
  }

  async getLabel(boxId: string): Promise<BoxLabel> {
    const box = await this.prisma.box.findUniqueOrThrow({
      where: { id: boxId },
      include: {
        destinationLocation: true,
        lines: {
          include: {
            warehouseVariant: {
              include: {
                itemGroup: { select: { name: true } },
                colourVariant: { select: { name: true } },
                sizeOption: { select: { name: true } },
              },
            },
          },
        },
      },
    })
    return {
      qrToken: box.qrToken,
      destinationLocationId: box.destinationLocationId,
      destinationLocationName: box.destinationLocation.name,
      lineCount: box.lines.length,
      packedAt: box.packedAt,
      lines: box.lines.map((l) => ({
        warehouseVariantId: l.warehouseVariantId,
        itemGroupName: l.warehouseVariant.itemGroup.name,
        colourVariantName: l.warehouseVariant.colourVariant.name,
        sizeOptionName: l.warehouseVariant.sizeOption.name,
        warehouseSku: l.warehouseVariant.warehouseSku,
        quantity: l.quantity,
      })),
    }
  }

  /// Market-manager scans a box QR. Looks up the box by qrToken, verifies
  /// the scanner is at the destination, marks the box ARRIVED, and posts
  /// an INTAKE ledger row for each line. If this was the last unreceived
  /// box for the parent request, the request auto-closes.
  ///
  /// Fully idempotent: re-scanning an already-ARRIVED box returns the
  /// existing state (`alreadyReceived: true`) without duplicate ledger
  /// rows — the INTAKE idempotencyKey matches `receiveForRequest`'s, so
  /// bulk-receive-then-scan or scan-then-bulk-receive both converge on
  /// exactly one INTAKE per line.
  async receiveByToken(
    qrToken: string,
    actor: CurrentUserPayload,
    expectedRequestId?: string,
  ): Promise<ReceiveBoxResult> {
    const box = await this.prisma.box.findUnique({
      where: { qrToken },
      include: {
        destinationLocation: true,
        request: true,
        lines: {
          include: {
            warehouseVariant: {
              include: {
                itemGroup: { select: { name: true } },
                colourVariant: { select: { name: true } },
                sizeOption: { select: { name: true } },
              },
            },
          },
        },
      },
    })
    if (!box) throw new NotFoundException(`unknown box QR — no box matches this code`)

    if (actor.role === 'MARKET_MANAGER' && actor.locationId !== box.destinationLocationId) {
      throw new ForbiddenException(
        `this box is bound for ${box.destinationLocation.name}, not your market`,
      )
    }

    // Wrong-request check runs BEFORE any write. When the market
    // manager scans from a specific request's detail page, we get an
    // expectedRequestId — if it doesn't match, refuse loudly and
    // append nothing. This is what stops a mis-scan from silently
    // adding stock to the market because the client caught the
    // mismatch only after the fact.
    if (expectedRequestId && box.requestId !== expectedRequestId) {
      throw new BadRequestException({
        message: `This box belongs to a different request. Nothing was recorded.`,
        code: 'WRONG_REQUEST',
        details: { boxRequestId: box.requestId },
      })
    }

    if (box.state !== 'DISPATCHED' && box.state !== 'ARRIVED') {
      throw new BadRequestException(
        `box is not ready to be received (state=${box.state}) — it must be dispatched first`,
      )
    }

    const alreadyReceived = box.state === 'ARRIVED' && box.arrivedAt !== null
    const arrivedAt = alreadyReceived ? box.arrivedAt! : new Date()

    if (!alreadyReceived) {
      const existing = await this.prisma.ledgerEvent.findFirst({
        where: { sourceRef: box.id, type: 'DISPATCH' },
        select: { transferId: true },
      })
      const transferId = existing?.transferId ?? undefined
      for (const line of box.lines) {
        const wv = await this.prisma.warehouseVariant.findUniqueOrThrow({
          where: { id: line.warehouseVariantId },
        })
        await this.ledger.append({
          type: 'INTAKE',
          locationId: box.destinationLocationId,
          variationId: wv.variationId,
          warehouseVariantId: wv.id,
          quantity: line.quantity,
          occurredAt: arrivedAt,
          source: 'UI',
          sourceRef: box.id,
          idempotencyKey: `${transferKeyPrefix('dispatch', box.id, wv.id)}:to`,
          actorId: actor.id,
          transferId,
        })
      }
      await this.prisma.box.update({
        where: { id: box.id },
        data: { state: 'ARRIVED', arrivedAt },
      })
    }

    // Parent-request progress + auto-close. Only meaningful if the box
    // was packed against a request in the first place (loose boxes with
    // requestId=null skip this).
    let requestInfo: ReceiveBoxResult['request'] = null
    if (box.requestId) {
      const siblingBoxes = await this.prisma.box.findMany({
        where: { requestId: box.requestId },
        select: { state: true },
      })
      const boxesTotal = siblingBoxes.length
      const boxesReceived = siblingBoxes.filter((b) => b.state === 'ARRIVED').length
      const allReceived = boxesTotal > 0 && boxesReceived === boxesTotal
      const request = await this.prisma.restockRequest.findUnique({ where: { id: box.requestId } })
      let currentState = request?.state ?? 'CLOSED'
      let closed = currentState === 'CLOSED'

      if (allReceived && request && request.state !== 'CLOSED') {
        // Close directly here rather than going through RequestsService.
        // The role gate has already been passed by this endpoint's own
        // guards, and we've already posted every INTAKE row —
        // receiveForRequest would just re-idempotency-check them.
        const updated = await this.prisma.restockRequest.update({
          where: { id: request.id },
          data: { state: 'CLOSED', closedAt: new Date() },
        })
        currentState = updated.state
        closed = true
      }

      requestInfo = {
        id: box.requestId,
        state: currentState,
        boxesReceived,
        boxesTotal,
        closed,
      }
    }

    return {
      box: {
        id: box.id,
        qrToken: box.qrToken,
        destinationLocationName: box.destinationLocation.name,
        lineCount: box.lines.length,
        arrivedAt,
        alreadyReceived,
        contents: box.lines.map((l) => ({
          warehouseVariantId: l.warehouseVariantId,
          itemGroupName: l.warehouseVariant.itemGroup.name,
          colourVariantName: l.warehouseVariant.colourVariant.name,
          sizeOptionName: l.warehouseVariant.sizeOption.name,
          warehouseSku: l.warehouseVariant.warehouseSku,
          quantity: l.quantity,
        })),
      },
      request: requestInfo,
    }
  }
}
