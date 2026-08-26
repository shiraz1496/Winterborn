import { Injectable } from '@nestjs/common'
import type { AdminLocationDto, SyncSquareLocationsResult } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { listSquareLocations } from '../square/square-client.js'

/// Owner + Warehouse Manager surface for the local Location table, exposing
/// the Square link the read-only /locations endpoint intentionally hides.
///
/// Sync policy (mirror-from-Square, per the design confirmed with the
/// operator):
///   - Warehouse rows are never touched. Square has no warehouse concept
///     and a `kind = 'WAREHOUSE'` local row must survive every sync
///     unchanged, forever.
///   - Match precedence for each Square location:
///       1. squareLocationId -> update name + timezone in place
///       2. exact name match (case-insensitive, whitespace-trimmed) on a
///          local MARKET with squareLocationId = null -> link the row
///          (set squareLocationId + update name/timezone from Square)
///       3. otherwise -> create a new MARKET Location with Square's name +
///          timezone.
///   - Local MARKET rows with no Square counterpart after this pass are
///     reported as `unlinked` -- left in place (they may still be operated
///     from), never deleted. Deleting cascades into ledger events,
///     requests, boxes and thresholds; that is not sync's job.
///   - Sync never DEACTIVATES a local Location. Square's `status` field
///     is ignored; deactivation is an operator decision, not a mirror one.
@Injectable()
export class AdminLocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AdminLocationDto[]> {
    const rows = await this.prisma.location.findMany({
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      timezone: r.timezone,
      isActive: r.isActive,
      squareLocationId: r.squareLocationId,
    }))
  }

  async syncFromSquare(): Promise<SyncSquareLocationsResult> {
    const squareLocations = await listSquareLocations()
    const created: string[] = []
    const updated: string[] = []
    const linked: string[] = []

    const localMarkets = await this.prisma.location.findMany({ where: { kind: 'MARKET' } })
    const bySquareId = new Map<string, (typeof localMarkets)[number]>()
    for (const m of localMarkets) {
      if (m.squareLocationId) bySquareId.set(m.squareLocationId, m)
    }
    const byNormalisedName = new Map<string, (typeof localMarkets)[number]>()
    for (const m of localMarkets) {
      if (!m.squareLocationId) byNormalisedName.set(normaliseName(m.name), m)
    }

    for (const sq of squareLocations) {
      const squareId = sq.id
      if (!squareId) continue
      const nextName = (sq.name ?? '').trim() || `Square location ${squareId.slice(0, 6)}`
      const nextTimezone = sq.timezone ?? 'UTC'

      const byId = bySquareId.get(squareId)
      if (byId) {
        if (byId.name !== nextName || byId.timezone !== nextTimezone) {
          await this.prisma.location.update({
            where: { id: byId.id },
            data: { name: nextName, timezone: nextTimezone },
          })
          updated.push(nextName)
        }
        continue
      }

      const byName = byNormalisedName.get(normaliseName(nextName))
      if (byName) {
        await this.prisma.location.update({
          where: { id: byName.id },
          data: { squareLocationId: squareId, name: nextName, timezone: nextTimezone },
        })
        // The row already existed; we linked it and refreshed its metadata.
        // Report as linked (a distinct outcome from a plain update) so the
        // operator can see which of the two happened on this pass.
        linked.push(nextName)
        continue
      }

      await this.prisma.location.create({
        data: {
          name: nextName,
          kind: 'MARKET',
          timezone: nextTimezone,
          squareLocationId: squareId,
        },
      })
      created.push(nextName)
    }

    // Recompute unlinked after the pass so newly-linked rows aren't
    // double-counted. WAREHOUSE rows are excluded here too -- they're
    // structurally unlinkable, not a problem to surface.
    const unlinkedRows = await this.prisma.location.findMany({
      where: { kind: 'MARKET', squareLocationId: null },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
    const unlinked = unlinkedRows.map((r) => r.name)

    return {
      created,
      updated,
      linked,
      unlinked,
      squareTotal: squareLocations.length,
    }
  }
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}
