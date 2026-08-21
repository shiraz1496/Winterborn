import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { BoxesService } from './boxes.service.js'

const UNIQUE_VIOLATION = 'P2002'

export interface CreateLoadInput {
  vehicleLabel: string
  destinationLocationId: string
}

/**
 * Load verification (spec §9.5): the loader selects a vehicle and
 * destination, then scans boxes on. A box destined elsewhere errors
 * immediately -- cheap to check, and it catches a wrong-van error before the
 * box leaves the building instead of at a market opening it in front of
 * customers.
 */
@Injectable()
export class LoadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly boxes: BoxesService,
  ) {}

  async create(input: CreateLoadInput, actor: CurrentUserPayload) {
    return this.prisma.load.create({
      data: {
        vehicleLabel: input.vehicleLabel,
        destinationLocationId: input.destinationLocationId,
        createdById: actor.id,
      },
    })
  }

  async scanBox(loadId: string, boxId: string) {
    const load = await this.prisma.load.findUniqueOrThrow({ where: { id: loadId } })
    const box = await this.prisma.box.findUniqueOrThrow({ where: { id: boxId } })

    if (box.destinationLocationId !== load.destinationLocationId) {
      throw new BadRequestException(
        `box ${boxId} is destined for a different location than load ${loadId} -- refused at scan time`,
      )
    }

    try {
      return await this.prisma.loadBox.create({ data: { loadId, boxId } })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        // Already scanned onto this load -- scanning twice is a shaky hand,
        // not a second box.
        return this.prisma.loadBox.findUniqueOrThrow({ where: { loadId_boxId: { loadId, boxId } } })
      }
      throw err
    }
  }

  /// Dispatches every box scanned onto this load. Delegates the actual
  /// ledger write to BoxesService.dispatch, which is idempotent per box, so
  /// dispatching a load twice (or a box that was somehow already dispatched
  /// individually) never double-counts.
  async dispatch(loadId: string, actor: CurrentUserPayload) {
    const load = await this.prisma.load.findUniqueOrThrow({ where: { id: loadId }, include: { boxes: true } })

    const results = []
    for (const loadBox of load.boxes) {
      results.push(await this.boxes.dispatch(loadBox.boxId, actor))
    }

    if (!load.dispatchedAt) {
      await this.prisma.load.update({ where: { id: loadId }, data: { dispatchedAt: new Date() } })
    }

    return { loadId, boxes: results }
  }
}
