import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes, randomUUID } from 'node:crypto'
import type { RequestState } from '@prisma/client'
import { transferKeyPrefix, type ReceiveBoxResult } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'
import { AuditService } from '../audit/audit.service.js'
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
  /// Optional per-line request ownership — set when a single physical
  /// box fulfils lines from more than one RestockRequest (the merged
  /// destination pack view). When omitted, the line inherits the
  /// top-level `requestId` on the pack input.
  requestId?: string
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
    private readonly audit: AuditService,
  ) {}

  /// Re-derives the PACKING ↔ PACKED state for a request based on box
  /// existence. Called after every box mutation (pack, addLine, discard,
  /// dispatch) so the stored state stays in sync with the boxes on the
  /// floor without any client-side derivation. Never crosses the
  /// PACKING/PACKED boundary in either direction — the state machine
  /// still gates DRAFT/OPEN and post-dispatch transitions elsewhere.
  ///
  /// Rule: a request with *any* box coverage flips to PACKED — packing
  /// is treated as "committed" the moment the first box exists, even
  /// if the operator ran out of stock and couldn't fully cover the
  /// requested count. Short coverage surfaces to the operator via the
  /// partial-packed notice on the request detail and the dispatch
  /// warning that leftover units will be dropped. Zero coverage flips
  /// PACKED back to PACKING (e.g. all boxes discarded via unpack).
  async reconcileRequestPackedState(requestId: string, actorId: string | null = null): Promise<void> {
    const request = await this.prisma.restockRequest.findUnique({
      where: { id: requestId },
      include: { lines: true },
    })
    if (!request) return
    // Only re-evaluate while the request is somewhere in the packing
    // window. Once dispatched/arrived/closed, this method is a no-op.
    if (request.state !== 'PACKING' && request.state !== 'PACKED') return

    const requested = request.lines.reduce((s, l) => s + l.qtyRequested, 0)
    if (requested === 0) return

    // Any box that counts as coverage. Uses BoxLine.requestId
    // (falling back to Box.requestId for solo boxes).
    const anyBoxLine = await this.prisma.boxLine.findFirst({
      where: {
        OR: [
          { requestId },
          {
            requestId: null,
            box: { requestId },
          },
        ],
        box: { state: { in: ['PACKING', 'DISPATCHED', 'ARRIVED'] } },
      },
      select: { id: true },
    })

    const shouldBe: RequestState = anyBoxLine ? 'PACKED' : 'PACKING'
    if (shouldBe === request.state) return

    await this.prisma.restockRequest.update({
      where: { id: requestId },
      data: { state: shouldBe },
    })
    await this.audit.recordTransition(null, 'RestockRequest', requestId, 'state', request.state, shouldBe, {
      actorId,
      actorRole: null,
      source: 'UI',
    })
  }

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

    // Resolve per-line requestId: prefer line-level (set by the merged
    // destination pack view where auto-allocation decides per line), fall
    // back to the top-level (backwards compat with the single-request
    // pack view). Box.requestId is only populated when every line agrees
    // on the same request — otherwise it stays NULL and the mapping is
    // per-line only.
    const linesWithRequest = input.lines.map((l) => ({
      warehouseVariantId: l.warehouseVariantId,
      quantity: l.quantity,
      requestId: l.requestId ?? input.requestId ?? null,
    }))
    const distinctRequestIds = new Set(
      linesWithRequest.map((l) => l.requestId).filter((id): id is string => id != null),
    )
    const uniformRequestId = distinctRequestIds.size === 1 ? [...distinctRequestIds][0]! : null
    const boxRequestId = uniformRequestId ?? input.requestId ?? null
    // If lines carry a mix of requestIds, we can't legitimately record any
    // single request on the Box row — the mapping lives on the lines.
    const finalBoxRequestId = distinctRequestIds.size > 1 ? null : boxRequestId

    const box = await this.prisma.box.create({
      data: {
        requestId: finalBoxRequestId,
        destinationLocationId: input.destinationLocationId,
        qrToken,
        packedById: actor.id,
        packedAt: new Date(),
        lines: { create: linesWithRequest },
      },
      include: { lines: true },
    })

    await this.audit.recordCreation(
      null,
      'Box',
      box.id,
      `packed ${box.lines.length} line${box.lines.length === 1 ? '' : 's'} for ${input.destinationLocationId}`,
      { actorId: actor.id, actorRole: actor.role, source: 'UI' },
    )

    // Every request this box covers may have just crossed the 100 %
    // coverage threshold — reconcile PACKING ↔ PACKED for each so the
    // Requests list reflects reality without any client-side derivation.
    const touchedRequestIds = new Set<string>()
    if (finalBoxRequestId) touchedRequestIds.add(finalBoxRequestId)
    for (const line of linesWithRequest) {
      if (line.requestId) touchedRequestIds.add(line.requestId)
    }
    for (const rid of touchedRequestIds) {
      await this.reconcileRequestPackedState(rid, actor.id)
    }

    return box
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
        // A box counts as "for request X" if either the box itself is
        // pinned to that request (single-request path) or any of its
        // lines is (multi-request path).
        ...(filter.requestId
          ? {
              OR: [
                { requestId: filter.requestId },
                { lines: { some: { requestId: filter.requestId } } },
              ],
            }
          : {}),
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

  /// Delete a PACKING box outright. Only allowed while the box is
  /// still on the warehouse floor — a DISPATCHED / ARRIVED box is
  /// already recorded in the ledger and cannot be silently removed.
  /// Used by the re-pack flow: before writing a fresh packing box for
  /// a request, the client asks the server to drop the stale one.
  async discard(boxId: string) {
    const box = await this.prisma.box.findUniqueOrThrow({
      where: { id: boxId },
      select: { state: true, requestId: true, lines: { select: { requestId: true } } },
    })
    if (box.state !== 'PACKING') {
      throw new BadRequestException(
        `box cannot be discarded — state=${box.state} (only PACKING boxes can be removed)`,
      )
    }
    // Capture every request this box was helping fulfil before we drop
    // the cascade — after the delete we can't look them up any more, and
    // the coverage on each of them just fell.
    const touchedRequestIds = new Set<string>()
    if (box.requestId) touchedRequestIds.add(box.requestId)
    for (const line of box.lines) if (line.requestId) touchedRequestIds.add(line.requestId)

    // Cascade on BoxLine handles line deletion; LoadBox links are
    // gone-when-box-is-gone by design (packing boxes shouldn't be on
    // a Load yet, but the join row would orphan cleanly if so).
    await this.prisma.box.delete({ where: { id: boxId } })
    await this.audit.record(null, {
      entity: 'Box',
      entityId: boxId,
      field: 'discarded',
      oldValue: 'PACKING',
      newValue: 'DELETED',
      source: 'UI',
    })

    // A discard usually drops coverage below 100 %, so PACKED requests
    // fall back to PACKING. Reconcile runs the check either way.
    for (const rid of touchedRequestIds) {
      await this.reconcileRequestPackedState(rid, null)
    }

    return { id: boxId, discarded: true }
  }

  /// Unpack an entire request: discards every solo PACKING box owned by
  /// this request. Shared multi-request boxes are deliberately skipped —
  /// unpacking those from one request's perspective would silently
  /// unpack the siblings too; the operator has to do that from the
  /// grouped shipment view.
  ///
  /// Returns which boxes were discarded and which were skipped so the
  /// UI can tell the operator "n boxes still shared — unpack via the
  /// shipment view". The auto-reconcile in `discard()` walks each
  /// unpacked box's requestIds, which brings the parent request back
  /// from PACKED to PACKING as coverage drops.
  async unpackForRequest(
    requestId: string,
    actor: CurrentUserPayload,
  ): Promise<{ discarded: string[]; sharedSkipped: string[] }> {
    const request = await this.prisma.restockRequest.findUnique({ where: { id: requestId } })
    if (!request) throw new NotFoundException(`request ${requestId} not found`)
    if (request.state !== 'PACKING' && request.state !== 'PACKED') {
      throw new BadRequestException(
        `request cannot be unpacked — state=${request.state} (only PACKING / PACKED requests can be)`,
      )
    }

    const packingBoxes = await this.prisma.box.findMany({
      where: {
        state: 'PACKING',
        OR: [
          { requestId },
          { lines: { some: { requestId } } },
        ],
      },
      include: { lines: { select: { requestId: true } } },
    })

    const discarded: string[] = []
    const sharedSkipped: string[] = []
    for (const box of packingBoxes) {
      const involvedRequestIds = new Set<string>()
      if (box.requestId) involvedRequestIds.add(box.requestId)
      for (const line of box.lines) if (line.requestId) involvedRequestIds.add(line.requestId)
      // Solo = every id involved is this request. Anything else is a
      // shared box and requires the shipment-view path so we don't
      // silently mutate a sibling request the operator can't see.
      let solo = involvedRequestIds.size <= 1
      if (solo) for (const rid of involvedRequestIds) if (rid !== requestId) { solo = false; break }
      if (!solo) {
        sharedSkipped.push(box.id)
        continue
      }
      await this.discard(box.id)
      discarded.push(box.id)
    }

    // Reconcile once more in case there were only shared boxes and none
    // actually got discarded — belt-and-braces so the request state
    // matches the current coverage regardless.
    await this.reconcileRequestPackedState(requestId, actor.id)

    return { discarded, sharedSkipped }
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
    const line = await this.prisma.boxLine.create({
      data: { boxId, warehouseVariantId: input.warehouseVariantId, quantity: input.quantity },
    })
    // A fresh line pushes coverage up — reconcile the parent request(s).
    const touchedRequestIds = new Set<string>()
    if (box.requestId) touchedRequestIds.add(box.requestId)
    if (line.requestId) touchedRequestIds.add(line.requestId)
    for (const rid of touchedRequestIds) {
      await this.reconcileRequestPackedState(rid, null)
    }
    return line
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
      await this.audit.recordTransition(null, 'Box', boxId, 'state', box.state, 'DISPATCHED', {
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        locationId: box.destinationLocationId,
        source: 'UI',
      })
    }

    // Auto-advance every parent request this box helps fulfil to
    // DISPATCHED on first box send. For a single-request box the set
    // is just `{box.requestId}`; for a multi-request box the set comes
    // from the line-level requestIds instead. Both PACKING (partial
    // dispatch — leftover units are dropped) and PACKED (all units
    // accounted for) qualify; later states stay put.
    const involvedRequestIds = new Set<string>()
    if (box.requestId) involvedRequestIds.add(box.requestId)
    for (const line of box.lines) if (line.requestId) involvedRequestIds.add(line.requestId)
    for (const requestId of involvedRequestIds) {
      const request = await this.prisma.restockRequest.findUnique({ where: { id: requestId } })
      if (request && (request.state === 'PACKING' || request.state === 'PACKED')) {
        await this.prisma.restockRequest.update({
          where: { id: requestId },
          data: { state: 'DISPATCHED' },
        })
        await this.audit.recordTransition(null, 'RestockRequest', requestId, 'state', request.state, 'DISPATCHED', {
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          source: 'UI',
        })
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
    // Include multi-request boxes whose ownership is only recorded at the
    // line level, alongside the classic single-request boxes.
    const boxes = await this.prisma.box.findMany({
      where: {
        state: { in: ['DISPATCHED', 'ARRIVED'] },
        OR: [
          { requestId },
          { lines: { some: { requestId } } },
        ],
      },
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
        await this.audit.recordTransition(null, 'Box', box.id, 'state', box.state, 'ARRIVED', {
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
          locationId: box.destinationLocationId,
          reason: `received under request ${requestId}`,
          source: 'UI',
        })
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
    /// Multi-request boxes can carry two BoxLine rows for the same SKU
    /// (one per request that asked for it). The printed label / QR
    /// contents are for a physical picker who only cares about the
    /// per-SKU total in this box — the request-level split lives in the
    /// database and is surfaced elsewhere. Merge by warehouseVariantId
    /// so the label reads "Capes 4-Shade Browns ×2" once, not two ×1
    /// rows. First occurrence wins on ordering.
    interface MergedLabelLine {
      warehouseVariantId: string
      itemGroupName: string
      colourVariantName: string
      sizeOptionName: string
      warehouseSku: string
      quantity: number
    }
    const mergedByVariant = new Map<string, MergedLabelLine>()
    for (const l of box.lines) {
      const existing = mergedByVariant.get(l.warehouseVariantId)
      if (existing) {
        existing.quantity += l.quantity
      } else {
        mergedByVariant.set(l.warehouseVariantId, {
          warehouseVariantId: l.warehouseVariantId,
          itemGroupName: l.warehouseVariant.itemGroup.name,
          colourVariantName: l.warehouseVariant.colourVariant.name,
          sizeOptionName: l.warehouseVariant.sizeOption.name,
          warehouseSku: l.warehouseVariant.warehouseSku,
          quantity: l.quantity,
        })
      }
    }
    const mergedLines = [...mergedByVariant.values()]

    return {
      qrToken: box.qrToken,
      destinationLocationId: box.destinationLocationId,
      destinationLocationName: box.destinationLocation.name,
      lineCount: mergedLines.length,
      packedAt: box.packedAt,
      lines: mergedLines.map((l) => ({
        warehouseVariantId: l.warehouseVariantId,
        itemGroupName: l.itemGroupName,
        colourVariantName: l.colourVariantName,
        sizeOptionName: l.sizeOptionName,
        warehouseSku: l.warehouseSku,
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
    // expectedRequestId — if the box has no line fulfilling that
    // request (and isn't Box.requestId-pinned to it either), refuse
    // loudly and append nothing. This is what stops a mis-scan from
    // silently adding stock to the market because the client caught
    // the mismatch only after the fact.
    if (expectedRequestId) {
      const linePinned = box.lines.some((l) => l.requestId === expectedRequestId)
      const boxPinned = box.requestId === expectedRequestId
      if (!linePinned && !boxPinned) {
        throw new BadRequestException({
          message: `This box belongs to a different request. Nothing was recorded.`,
          code: 'WRONG_REQUEST',
          details: { boxRequestId: box.requestId, boxLineRequestIds: [...new Set(box.lines.map((l) => l.requestId).filter(Boolean))] },
        })
      }
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
      await this.audit.recordTransition(null, 'Box', box.id, 'state', 'DISPATCHED', 'ARRIVED', {
        actorId: actor.id,
        actorRole: actor.role,
        locationId: box.destinationLocationId,
        reason: 'received via QR scan',
        source: 'UI',
      })
    }

    // Parent-request progress + auto-close. For a multi-request box we
    // process every request this box helps fulfil (each may auto-close
    // independently once all of its sibling boxes have arrived). The
    // response only reports one — the caller's expectedRequestId when
    // provided, otherwise the box's primary requestId, otherwise the
    // first request found on the lines — because the receive response
    // schema is 1:1 with a single request today.
    const affectedRequestIds = new Set<string>()
    if (box.requestId) affectedRequestIds.add(box.requestId)
    for (const line of box.lines) if (line.requestId) affectedRequestIds.add(line.requestId)

    /// For a request X: count "boxes fulfilling X" and how many of those
    /// are ARRIVED. A box fulfils X if Box.requestId=X or any BoxLine.requestId=X.
    const progressFor = async (requestId: string) => {
      const siblingBoxes = await this.prisma.box.findMany({
        where: {
          OR: [
            { requestId },
            { lines: { some: { requestId } } },
          ],
        },
        select: { state: true },
      })
      const boxesTotal = siblingBoxes.length
      const boxesReceived = siblingBoxes.filter((b) => b.state === 'ARRIVED').length
      return { boxesTotal, boxesReceived }
    }

    let requestInfo: ReceiveBoxResult['request'] = null
    const requestsInfo: ReceiveBoxResult['requests'] = []
    const primaryRequestId =
      expectedRequestId && affectedRequestIds.has(expectedRequestId)
        ? expectedRequestId
        : (box.requestId ?? box.lines.find((l) => l.requestId)?.requestId ?? null)

    for (const requestId of affectedRequestIds) {
      const { boxesTotal, boxesReceived } = await progressFor(requestId)
      const allReceived = boxesTotal > 0 && boxesReceived === boxesTotal
      const request = await this.prisma.restockRequest.findUnique({ where: { id: requestId } })
      let currentState = request?.state ?? 'CLOSED'
      let closed = currentState === 'CLOSED'

      if (allReceived && request && request.state !== 'CLOSED') {
        const updated = await this.prisma.restockRequest.update({
          where: { id: request.id },
          data: { state: 'CLOSED', closedAt: new Date() },
        })
        currentState = updated.state
        closed = true
      }

      const progress = {
        id: requestId,
        state: currentState,
        boxesReceived,
        boxesTotal,
        closed,
      }
      // Primary goes first in the array so callers that just want "the
      // main one" can grab `requests[0]`. `request` stays for backwards
      // compat with older UI code.
      if (requestId === primaryRequestId) {
        requestInfo = progress
        requestsInfo.unshift(progress)
      } else {
        requestsInfo.push(progress)
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
      requests: requestsInfo,
    }
  }
}
