import { Injectable } from '@nestjs/common'
import type { Notification, NotificationsList } from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'

/// Doc 3 §3.2. Notifications aren't a persisted table -- they're a
/// read-time union across the three sources that already record what
/// happened: RestockRequest (auto-drafts), AuditLog (state transitions),
/// and LedgerEvent (intake/dispatch). Cheaper than a new table + trigger,
/// and it means an event can never fall out of sync with the record it
/// summarises.
const FEED_LIMIT = 100
const PER_SOURCE_LIMIT = 60

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: CurrentUserPayload): Promise<NotificationsList> {
    const scopedLocationId = actor.role === 'MARKET_MANAGER' ? actor.locationId : null
    if (actor.role === 'MARKET_MANAGER' && !scopedLocationId) {
      // A market manager without an assigned location sees nothing rather
      // than accidentally seeing everything.
      return { items: [], truncated: false }
    }

    const [drafts, stateChanges, intakes, dispatches, locations] = await Promise.all([
      this.loadAutoDrafts(scopedLocationId),
      this.loadStateChanges(scopedLocationId),
      // Market managers do not see warehouse intake -- it isn't their event.
      scopedLocationId ? [] : this.loadIntakes(),
      this.loadDispatches(scopedLocationId),
      this.prisma.location.findMany({ select: { id: true, name: true } }),
    ])

    const locationNameById = new Map(locations.map((l) => [l.id, l.name]))
    const merged: Notification[] = [
      ...drafts.map((d) => ({
        ...d,
        locationName: d.locationId ? locationNameById.get(d.locationId) ?? null : null,
      })),
      ...stateChanges.map((s) => ({
        ...s,
        locationName: s.locationId ? locationNameById.get(s.locationId) ?? null : null,
      })),
      ...intakes.map((i) => ({
        ...i,
        locationName: i.locationId ? locationNameById.get(i.locationId) ?? null : null,
      })),
      ...dispatches.map((d) => ({
        ...d,
        locationName: d.locationId ? locationNameById.get(d.locationId) ?? null : null,
      })),
    ]

    merged.sort((a, b) => b.at.getTime() - a.at.getTime())
    const items = merged.slice(0, FEED_LIMIT)
    return { items, truncated: merged.length > FEED_LIMIT }
  }

  private async loadAutoDrafts(scopedLocationId: string | null): Promise<Notification[]> {
    const rows = await this.prisma.restockRequest.findMany({
      where: {
        createdFrom: 'THRESHOLD',
        ...(scopedLocationId ? { locationId: scopedLocationId } : {}),
      },
      include: { lines: true, location: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: PER_SOURCE_LIMIT,
    })
    return rows.map((r) => ({
      id: `draft:${r.id}`,
      kind: 'REQUEST_DRAFTED',
      at: r.createdAt,
      title: `Auto-drafted for ${r.location.name}`,
      body: `${r.lines.length} line${r.lines.length === 1 ? '' : 's'} flagged by threshold — awaiting review.`,
      href: `/requests/${r.id}`,
      locationId: r.locationId,
      locationName: null,
    }))
  }

  private async loadStateChanges(scopedLocationId: string | null): Promise<Notification[]> {
    const audits = await this.prisma.auditLog.findMany({
      where: { entity: 'RestockRequest', field: 'state', oldValue: { not: null } },
      orderBy: { at: 'desc' },
      take: PER_SOURCE_LIMIT,
    })
    if (audits.length === 0) return []

    const requestIds = Array.from(new Set(audits.map((a) => a.entityId)))
    const requests = await this.prisma.restockRequest.findMany({
      where: { id: { in: requestIds } },
      include: { location: { select: { id: true, name: true } } },
    })
    const requestById = new Map(requests.map((r) => [r.id, r]))

    return audits
      .map((a): Notification | null => {
        const request = requestById.get(a.entityId)
        if (!request) return null
        if (scopedLocationId && request.locationId !== scopedLocationId) return null
        return {
          id: `state:${a.id}`,
          kind: 'REQUEST_ADVANCED',
          at: a.at,
          title: `${request.location.name} · ${a.oldValue ?? '—'} → ${a.newValue ?? '—'}`,
          body: `Restock request moved to ${a.newValue ?? 'unknown'}.`,
          href: `/requests/${request.id}`,
          locationId: request.locationId,
          locationName: null,
        }
      })
      .filter((n): n is Notification => n !== null)
  }

  private async loadIntakes(): Promise<Notification[]> {
    const rows = await this.prisma.ledgerEvent.findMany({
      where: { type: 'INTAKE' },
      orderBy: { recordedAt: 'desc' },
      take: PER_SOURCE_LIMIT,
      include: {
        variation: { include: { itemGroup: { select: { name: true } } } },
      },
    })
    return rows.map((r) => ({
      id: `intake:${r.id}`,
      kind: 'INTAKE_RECORDED',
      at: r.recordedAt,
      title: `Received ${r.quantity} · ${r.variation.itemGroup.name}`,
      body: r.note ? r.note : 'Intake recorded to the warehouse ledger.',
      href: '/intake',
      locationId: r.locationId,
      locationName: null,
    }))
  }

  private async loadDispatches(scopedLocationId: string | null): Promise<Notification[]> {
    /// A DISPATCH transfer is two rows -- one negative at the source, one
    /// positive at the destination. We surface only the destination row so
    /// a single dispatch appears once, from the receiving market's point of
    /// view.
    const rows = await this.prisma.ledgerEvent.findMany({
      where: {
        type: 'DISPATCH',
        quantity: { gt: 0 },
        ...(scopedLocationId ? { locationId: scopedLocationId } : {}),
      },
      orderBy: { recordedAt: 'desc' },
      take: PER_SOURCE_LIMIT,
      include: {
        location: { select: { name: true } },
        variation: { include: { itemGroup: { select: { name: true } } } },
      },
    })
    return rows.map((r) => ({
      id: `dispatch:${r.id}`,
      kind: 'DISPATCH_RECORDED',
      at: r.recordedAt,
      title: `Dispatched to ${r.location.name}`,
      body: `${r.quantity} · ${r.variation.itemGroup.name}`,
      href: '/requests',
      locationId: r.locationId,
      locationName: null,
    }))
  }
}
