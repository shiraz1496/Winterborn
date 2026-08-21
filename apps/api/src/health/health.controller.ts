import { Controller, Get } from '@nestjs/common'
import type { HealthResponse } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * `GET /health` -- spec §10.2: "The operator is the only support desk
 * during a $2.9M season. Instrument accordingly." Deliberately not
 * `{status:'ok'}`: that literal tells nobody anything at 2am. Every field
 * here answers one specific "is Square sync still alive" question, because
 * the failure mode this exists to catch is Square silently stopping to
 * notify -- both webhook and poll -- with nothing else in the system
 * noticing until a market runs a family down to zero mid-Saturday.
 *
 * Unauthenticated on purpose: an uptime monitor or a status page has no
 * session, and the payload here carries no customer data, sales figures,
 * or credentials -- only counts, timestamps and location names already
 * visible to anyone logged into the dashboard.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const checkedAt = new Date()

    let dbConnected = true
    let dbError: string | null = null
    try {
      await this.prisma.$queryRaw`SELECT 1`
    } catch (err) {
      dbConnected = false
      dbError = err instanceof Error ? err.message : String(err)
    }

    // If the database itself is unreachable, every other query below would
    // just throw too -- report that one fact clearly rather than a stack
    // trace from a follow-on query against a connection that is already down.
    if (!dbConnected) {
      return {
        ok: false,
        checkedAt,
        database: { connected: false, error: dbError },
        polling: { locations: [] },
        inbox: { backlogDepth: 0, oldestUnprocessedAt: null, deadLetterCount: 0 },
      }
    }

    const [marketLocations, cursors, backlogDepth, oldestUnprocessed, deadLetterCount] = await Promise.all([
      this.prisma.location.findMany({
        where: { kind: 'MARKET', isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.squareSyncCursor.findMany({ select: { locationId: true, lastPolledAt: true } }),
      this.prisma.squareInboxEvent.count({ where: { processedAt: null } }),
      this.prisma.squareInboxEvent.findFirst({
        where: { processedAt: null },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
      // Dead-lettered lines are marked processed (their mappable lines are
      // safely in the ledger -- see InboxWorker's docstring) but carry the
      // dead-letter detail in `error`, so this is distinct from a row still
      // stuck in the backlog above.
      this.prisma.squareInboxEvent.count({ where: { processedAt: { not: null }, error: { not: null } } }),
    ])

    const lastPolledByLocation = new Map(cursors.map((c) => [c.locationId, c.lastPolledAt]))
    const polling = marketLocations.map((loc) => {
      const lastPolledAt = lastPolledByLocation.get(loc.id) ?? null
      return {
        locationId: loc.id,
        locationName: loc.name,
        lastPolledAt,
        minutesSincePoll: lastPolledAt ? Math.round((checkedAt.getTime() - lastPolledAt.getTime()) / 60_000) : null,
      }
    })

    return {
      ok: true,
      checkedAt,
      database: { connected: true, error: null },
      polling: { locations: polling },
      inbox: {
        backlogDepth,
        oldestUnprocessedAt: oldestUnprocessed?.receivedAt ?? null,
        deadLetterCount,
      },
    }
  }
}
