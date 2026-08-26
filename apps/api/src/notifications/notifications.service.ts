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
///
/// Every loader takes a `roleView` and returns only what that role should
/// be seeing. The rules (mirrors the on-screen role gates in the request
/// detail action strip):
///
///   OWNER              — sees everything, across every market.
///   WAREHOUSE_MANAGER  — auto-drafts to review, submit/close events at
///                        any market, all warehouse intake, all
///                        dispatches, all not-received reports.
///   WAREHOUSE_OPERATOR — same as WM but no auto-drafts (WM's decision).
///   MARKET_MANAGER     — only their own market: their auto-drafts,
///                        their submits, their packing/dispatched/closed
///                        events, dispatches heading to them, their own
///                        not-received reports. No warehouse intake.
///   SALES              — no notifications (Square-terminal focused).
const FEED_LIMIT = 100
const PER_SOURCE_LIMIT = 60

type RoleView =
  | { role: 'OWNER' | 'WAREHOUSE_MANAGER' | 'WAREHOUSE_OPERATOR'; scopedLocationId: null }
  | { role: 'MARKET_MANAGER'; scopedLocationId: string }
  | { role: 'SALES'; scopedLocationId: null }

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: CurrentUserPayload): Promise<NotificationsList> {
    // SALES doesn't receive workflow notifications. They interact with
    // the till, not the restock loop.
    if (actor.role === 'SALES') {
      return { items: [], truncated: false }
    }

    // MM without a location can't be scoped safely — return empty
    // rather than accidentally showing every market's events.
    if (actor.role === 'MARKET_MANAGER' && !actor.locationId) {
      return { items: [], truncated: false }
    }

    const view: RoleView =
      actor.role === 'MARKET_MANAGER'
        ? { role: 'MARKET_MANAGER', scopedLocationId: actor.locationId as string }
        : { role: actor.role, scopedLocationId: null }

    // Every loader is gated: it returns [] if this role should not see
    // that kind of event, so the sort/merge below never carries hidden
    // rows past the role boundary.
    const [drafts, stateChanges, intakes, dispatches, missing, locations] = await Promise.all([
      this.loadAutoDrafts(view),
      this.loadStateChanges(view),
      this.loadIntakes(view),
      this.loadDispatches(view),
      this.loadMissingReports(view),
      this.prisma.location.findMany({ select: { id: true, name: true } }),
    ])

    const locationNameById = new Map(locations.map((l) => [l.id, l.name]))
    const merged: Notification[] = [
      ...drafts,
      ...stateChanges,
      ...intakes,
      ...dispatches,
      ...missing,
    ].map((n) => ({
      ...n,
      locationName: n.locationId ? locationNameById.get(n.locationId) ?? null : null,
    }))

    merged.sort((a, b) => b.at.getTime() - a.at.getTime())
    const items = merged.slice(0, FEED_LIMIT)
    return { items, truncated: merged.length > FEED_LIMIT }
  }

  /**
   * REQUEST_DRAFTED — threshold engine auto-drafted a restock request.
   *
   * WHO SEES IT:
   *   - OWNER, WM: everywhere (they're the reviewers).
   *   - WO: nothing (review is not their job).
   *   - MM: only for their own market.
   */
  private async loadAutoDrafts(view: RoleView): Promise<Notification[]> {
    if (view.role === 'WAREHOUSE_OPERATOR' || view.role === 'SALES') return []

    const rows = await this.prisma.restockRequest.findMany({
      where: {
        createdFrom: 'THRESHOLD',
        ...(view.scopedLocationId ? { locationId: view.scopedLocationId } : {}),
      },
      include: { lines: true, location: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: PER_SOURCE_LIMIT,
    })
    return rows.map((r) => ({
      id: `draft:${r.id}`,
      kind: 'REQUEST_DRAFTED',
      at: r.createdAt,
      title:
        view.role === 'MARKET_MANAGER'
          ? `Auto-drafted restock for your market`
          : `Auto-drafted restock for ${r.location.name}`,
      body: `${r.lines.length} line${r.lines.length === 1 ? '' : 's'} flagged below threshold — awaiting review.`,
      href: `/requests/${r.id}`,
      locationId: r.locationId,
      locationName: null,
    }))
  }

  /**
   * REQUEST_SUBMITTED / _PACKING / _DISPATCHED / _CLOSED — one row per
   * state transition, with role-relevant copy. Loaded from AuditLog
   * rows (`entity=RestockRequest, field=state`).
   *
   * WHO SEES WHAT:
   *   OWNER            — every transition on every request.
   *   WM               — every transition (they run the operation).
   *   WO               — every transition (they act on OPEN & PACKING).
   *   MM (own market)  — every transition on their own requests only.
   */
  private async loadStateChanges(view: RoleView): Promise<Notification[]> {
    if (view.role === 'SALES') return []

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
        if (view.scopedLocationId && request.locationId !== view.scopedLocationId) return null

        const to = a.newValue ?? '—'
        const from = a.oldValue ?? '—'
        const marketName = request.location.name
        const forWhoseMarket =
          view.role === 'MARKET_MANAGER' ? 'your market' : marketName

        // Copy varies by target state so the reader can immediately tell
        // what happened without translating an enum → English in their
        // head.
        let kind: Notification['kind'] = 'REQUEST_ADVANCED'
        let title = `${marketName} · ${from} → ${to}`
        let body = `Restock request moved to ${to}.`

        if (to === 'OPEN') {
          kind = 'REQUEST_SUBMITTED'
          title = `New request submitted · ${forWhoseMarket}`
          body =
            view.role === 'MARKET_MANAGER'
              ? 'Your request is now waiting for the warehouse to start packing.'
              : `${marketName} submitted a restock — ready to be packed.`
        } else if (to === 'PACKING') {
          kind = 'REQUEST_PACKING'
          title = `Packing started · ${forWhoseMarket}`
          body =
            view.role === 'MARKET_MANAGER'
              ? 'Warehouse has started packing your request.'
              : `Warehouse started packing the request for ${marketName}.`
        } else if (to === 'DISPATCHED') {
          kind = 'REQUEST_DISPATCHED'
          title = `Dispatched · ${forWhoseMarket}`
          body =
            view.role === 'MARKET_MANAGER'
              ? 'Your shipment has left the warehouse. Confirm receipt when it lands.'
              : `Shipment left the warehouse en route to ${marketName}.`
        } else if (to === 'CLOSED') {
          kind = 'REQUEST_CLOSED'
          title = `Received & closed · ${forWhoseMarket}`
          body =
            view.role === 'MARKET_MANAGER'
              ? 'You confirmed receipt — the request is closed.'
              : `${marketName} confirmed the shipment arrived — request closed.`
        }

        return {
          id: `state:${a.id}`,
          kind,
          at: a.at,
          title,
          body,
          href: `/requests/${request.id}`,
          locationId: request.locationId,
          locationName: null,
        }
      })
      .filter((n): n is Notification => n !== null)
  }

  /**
   * INTAKE_RECORDED — new stock landed at the warehouse.
   *
   * WHO SEES IT: warehouse only (OWNER, WM, WO). MMs never see intake —
   * it's a warehouse event; they only care once it's dispatched to them.
   */
  private async loadIntakes(view: RoleView): Promise<Notification[]> {
    if (view.role === 'MARKET_MANAGER' || view.role === 'SALES') return []

    // Real warehouse intake vs. destination-side receive-from-transfer
    // are distinguished by transferId: an INTAKE with a transferId is
    // the "receive" leg of a dispatch (surfaced by loadDispatches);
    // an INTAKE with no transferId is fresh goods landing.
    const rows = await this.prisma.ledgerEvent.findMany({
      where: { type: 'INTAKE', transferId: null },
      orderBy: { recordedAt: 'desc' },
      take: PER_SOURCE_LIMIT,
      include: {
        variation: { include: { itemGroup: { select: { name: true } } } },
        location: { select: { name: true } },
      },
    })
    return rows.map((r) => ({
      id: `intake:${r.id}`,
      kind: 'INTAKE_RECORDED',
      at: r.recordedAt,
      title: `+${r.quantity} ${r.variation.itemGroup.name} at ${r.location.name}`,
      body: r.note ? r.note : 'New goods landed and were added to warehouse stock.',
      href: '/intake',
      locationId: r.locationId,
      locationName: null,
    }))
  }

  /**
   * DISPATCH_RECORDED — a box left the warehouse for a market.
   *
   * We surface only the DESTINATION side of the transfer (positive
   * quantity, at the market location) so one dispatch shows once, from
   * the receiving side's point of view.
   *
   * WHO SEES IT:
   *   OWNER, WM, WO: every dispatch (they ran it).
   *   MM (own market only): dispatches inbound to them.
   */
  private async loadDispatches(view: RoleView): Promise<Notification[]> {
    if (view.role === 'SALES') return []

    const rows = await this.prisma.ledgerEvent.findMany({
      where: {
        type: 'INTAKE',
        transferId: { not: null },
        quantity: { gt: 0 },
        ...(view.scopedLocationId ? { locationId: view.scopedLocationId } : {}),
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
      title:
        view.role === 'MARKET_MANAGER'
          ? `${r.quantity} × ${r.variation.itemGroup.name} arrived`
          : `${r.quantity} × ${r.variation.itemGroup.name} → ${r.location.name}`,
      body:
        view.role === 'MARKET_MANAGER'
          ? 'Confirmed receipt was posted to the ledger.'
          : 'Ledger updated at destination on receive.',
      href: '/requests',
      locationId: r.locationId,
      locationName: null,
    }))
  }

  /**
   * SHIPMENT_NOT_RECEIVED — the destination MM clicked "Not received"
   * on a dispatched request. This is an escalation.
   *
   * WHO SEES IT:
   *   OWNER, WM, WO: every report (they investigate).
   *   MM (own market): their own reports only.
   *
   * Written by RequestsService.reportMissing() as an AuditLog row with
   * field='not_received'.
   */
  private async loadMissingReports(view: RoleView): Promise<Notification[]> {
    if (view.role === 'SALES') return []

    const audits = await this.prisma.auditLog.findMany({
      where: { entity: 'RestockRequest', field: 'not_received' },
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
        if (view.scopedLocationId && request.locationId !== view.scopedLocationId) return null
        // The "not received" report is a moment-in-time attestation:
        // "as of now, the box hasn't arrived." Once the request has
        // been closed (i.e. later marked received), that concern is
        // resolved — drop the notification from the feed so the market
        // manager isn't staring at a stale alarm they've already
        // cleared. The AuditLog row stays as a permanent record on
        // the request itself for anyone who needs the history.
        if (request.state === 'CLOSED') return null

        const marketName = request.location.name
        return {
          id: `missing:${a.id}`,
          kind: 'SHIPMENT_NOT_RECEIVED',
          at: a.at,
          title: `Shipment not received · ${marketName}`,
          body:
            view.role === 'MARKET_MANAGER'
              ? 'You reported this shipment did not arrive. Warehouse has been notified.'
              : `${marketName} reported the dispatched shipment never arrived. Investigate.`,
          href: `/requests/${request.id}`,
          locationId: request.locationId,
          locationName: null,
        }
      })
      .filter((n): n is Notification => n !== null)
  }
}
