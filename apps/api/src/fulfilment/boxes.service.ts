import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { transferKeyPrefix } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'

export interface PackBoxLineInput {
  warehouseVariantId: string
  quantity: number
}

export interface PackBoxInput {
  destinationLocationId: string
  requestId?: string
  lines: PackBoxLineInput[]
}

export interface BoxLabel {
  qrToken: string
  destinationLocationId: string
  destinationLocationName: string
  lineCount: number
  packedAt: Date | null
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
  ) {}

  async pack(input: PackBoxInput, actor: CurrentUserPayload) {
    if (input.lines.length === 0) throw new BadRequestException('a box must be packed with at least one line')
    for (const line of input.lines) {
      if (line.quantity <= 0) throw new BadRequestException('box line quantity must be positive')
    }

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
  async list(filter: { requestId?: string; destinationLocationId?: string }) {
    return this.prisma.box.findMany({
      where: {
        ...(filter.requestId ? { requestId: filter.requestId } : {}),
        ...(filter.destinationLocationId ? { destinationLocationId: filter.destinationLocationId } : {}),
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
    return this.prisma.boxLine.create({
      data: { boxId, warehouseVariantId: input.warehouseVariantId, quantity: input.quantity },
    })
  }

  /**
   * Posts the box's manifest to the ledger as one paired transfer per line
   * (negative at the warehouse, positive at the destination) and marks the
   * box DISPATCHED.
   *
   * Idempotent by construction: each line's idempotencyKeyPrefix is
   * `transferKeyPrefix('dispatch', boxId, warehouseVariantId)`, stable
   * across calls, so re-dispatching an already-dispatched box calls
   * LedgerService.transfer() again but it resolves to `created: false` for
   * every line -- a no-op, not a double-count.
   */
  async dispatch(boxId: string, actor?: CurrentUserPayload) {
    const box = await this.prisma.box.findUnique({ where: { id: boxId }, include: { lines: true } })
    if (!box) throw new NotFoundException(`box ${boxId} not found`)

    const warehouse = await this.prisma.location.findFirstOrThrow({ where: { kind: 'WAREHOUSE' } })
    const now = new Date()

    const transfers: { warehouseVariantId: string; transferId: string; created: boolean }[] = []
    for (const line of box.lines) {
      const wv = await this.prisma.warehouseVariant.findUniqueOrThrow({ where: { id: line.warehouseVariantId } })
      const result = await this.ledger.transfer({
        fromLocationId: warehouse.id,
        toLocationId: box.destinationLocationId,
        variationId: wv.variationId,
        warehouseVariantId: wv.id,
        quantity: line.quantity,
        occurredAt: now,
        source: 'UI',
        idempotencyKeyPrefix: transferKeyPrefix('dispatch', boxId, wv.id),
        type: 'DISPATCH',
        actorId: actor?.id,
      })
      transfers.push({ warehouseVariantId: wv.id, ...result })
    }

    if (box.state !== 'DISPATCHED') {
      await this.prisma.box.update({ where: { id: boxId }, data: { state: 'DISPATCHED', dispatchedAt: now } })
    }

    return { boxId, transfers }
  }

  async getLabel(boxId: string): Promise<BoxLabel> {
    const box = await this.prisma.box.findUniqueOrThrow({
      where: { id: boxId },
      include: { lines: true, destinationLocation: true },
    })
    return {
      qrToken: box.qrToken,
      destinationLocationId: box.destinationLocationId,
      destinationLocationName: box.destinationLocation.name,
      lineCount: box.lines.length,
      packedAt: box.packedAt,
    }
  }
}
