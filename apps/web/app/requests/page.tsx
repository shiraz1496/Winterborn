'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { BoxDto, LocationDto, RestockRequestDto, VariationSummary } from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { SearchableSelect } from '../../components/SearchableSelect'
import { useAuth } from '../../lib/auth-context'
import { ApiError, listBoxes, listLocations, listRequests, listVariations } from '../../lib/api'

const STATE_FILTERS = ['ALL', 'OPEN', 'PACKING', 'PACKED', 'DISPATCHED', 'CLOSED'] as const
type StateFilter = (typeof STATE_FILTERS)[number]

/// The PACKED state is set by BoxesService.reconcileRequestPackedState()
/// on the backend, so the frontend just renders whatever the server
/// gives us — no client-side coverage math.
function chipClassFor(state: RestockRequestDto['state']): string {
  if (
    state === 'PACKED' ||
    state === 'DISPATCHED' ||
    state === 'ARRIVED' ||
    state === 'CLOSED'
  )
    return 'chip chip-pine'
  if (state === 'PACKING') return 'chip chip-signal'
  return 'chip'
}

function RequestsBody() {
  const { user } = useAuth()
  // Only requesters can file a new restock: the market's own MM, or
  // OWNER on their behalf. Warehouse roles (WM/WO) pack what markets
  // ask for — they don't invent demand — and SALES is read-only.
  const canCreate = user?.role === 'MARKET_MANAGER' || user?.role === 'OWNER'
  /// Market managers see only their own market's requests server-side,
  /// so the picker adds no value for them. Everyone else gets an
  /// "All markets" default plus a per-market filter.
  const canFilterByMarket = user?.role !== 'MARKET_MANAGER'
  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [boxes, setBoxes] = useState<BoxDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [filter, setFilter] = useState<StateFilter>('OPEN')
  const [marketFilter, setMarketFilter] = useState<string>('ALL')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // Boxes are pulled alongside requests so requests sharing a physical
    // box can be grouped into a single "shipment" card.
    Promise.all([listRequests(), listLocations(), listBoxes(), listVariations()])
      .then(([r, l, b, v]) => {
        if (cancelled) return
        setRequests(r)
        setLocations(l)
        setBoxes(b)
        setVariations(v)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load requests.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const locationName = useMemo(() => {
    const map = new Map(locations.map((l) => [l.id, l.name]))
    return (id: string) => map.get(id) ?? id
  }, [locations])

  const variationName = useMemo(() => {
    const map = new Map(variations.map((v) => [v.id, v.itemGroupName]))
    return (id: string) => map.get(id) ?? null
  }, [variations])

  const markets = useMemo(
    () => locations.filter((l) => l.kind === 'MARKET').sort((a, b) => a.name.localeCompare(b.name)),
    [locations],
  )

  /// Group requests that share a physical box (multi-request shipment).
  /// Union-find over requestIds seeded from every box's line-level
  /// requestIds (and Box.requestId when set). Requests that don't share
  /// a box end up in a group of one, rendered exactly like before.
  const groupsByRequestId = useMemo(() => {
    const parent = new Map<string, string>()
    const find = (id: string): string => {
      const p = parent.get(id) ?? id
      if (p === id) return id
      const root = find(p)
      parent.set(id, root)
      return root
    }
    const union = (a: string, b: string) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    // Seed: every request starts as its own root.
    for (const r of requests) parent.set(r.id, r.id)
    // Merge: any two requestIds that appear on the same box belong to
    // the same shipment group.
    for (const b of boxes) {
      const ids = new Set<string>()
      if (b.requestId) ids.add(b.requestId)
      for (const line of b.lines) if (line.requestId) ids.add(line.requestId)
      const list = [...ids]
      for (let i = 1; i < list.length; i++) union(list[0]!, list[i]!)
    }
    return (id: string) => find(id)
  }, [requests, boxes])

  /// Short-shipped flag stays client-side because it's a comparison
  /// between requested (on the request) and dispatched (on boxes) — no
  /// separate backend state is needed once the request itself is in
  /// DISPATCHED/ARRIVED/CLOSED.
  const requestedByRequest = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of requests) m.set(r.id, r.lines.reduce((s, l) => s + l.qtyRequested, 0))
    return m
  }, [requests])

  const dispatchedByRequest = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of boxes) {
      if (b.state !== 'DISPATCHED' && b.state !== 'ARRIVED') continue
      for (const line of b.lines) {
        const rid = line.requestId ?? b.requestId ?? null
        if (!rid) continue
        m.set(rid, (m.get(rid) ?? 0) + line.quantity)
      }
    }
    return m
  }, [boxes])

  const isShortShipped = useMemo(() => {
    return (r: RestockRequestDto): boolean => {
      if (r.state !== 'DISPATCHED' && r.state !== 'ARRIVED' && r.state !== 'CLOSED') return false
      const requested = requestedByRequest.get(r.id) ?? 0
      const dispatched = dispatchedByRequest.get(r.id) ?? 0
      return requested > 0 && dispatched < requested
    }
  }, [dispatchedByRequest, requestedByRequest])

  interface RequestGroup {
    /// Canonical id (the union-find root). Stable across renders.
    id: string
    locationId: string
    /// Requests in this shipment, oldest first.
    requests: RestockRequestDto[]
    /// Union of state chips to show. For groups of >1, we surface a
    /// summary chip based on the most advanced state — a group is
    /// "closed" only when every request in it is closed, otherwise
    /// it shows the earliest state (packing beats packed beats
    /// dispatched, etc). Sourced from the server-provided state.
    summaryState: RestockRequestDto['state']
    /// True when any constituent request short-shipped.
    hasShortShipped: boolean
  }
  const STATE_ORDER: RestockRequestDto['state'][] = [
    'DRAFT',
    'OPEN',
    'PACKING',
    'PACKED',
    'DISPATCHED',
    'ARRIVED',
    'CLOSED',
  ]
  const groups = useMemo<RequestGroup[]>(() => {
    const buckets = new Map<string, RestockRequestDto[]>()
    for (const r of requests) {
      const root = groupsByRequestId(r.id)
      const bucket = buckets.get(root) ?? []
      bucket.push(r)
      buckets.set(root, bucket)
    }
    const result: RequestGroup[] = []
    for (const [id, list] of buckets) {
      list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      // Summary state: earliest server-provided state in the group order.
      let summary: RestockRequestDto['state'] = list[0]!.state
      for (const r of list) {
        if (STATE_ORDER.indexOf(r.state) < STATE_ORDER.indexOf(summary)) summary = r.state
      }
      result.push({
        id,
        locationId: list[0]!.locationId,
        requests: list,
        summaryState: summary,
        hasShortShipped: list.some(isShortShipped),
      })
    }
    // Newest group first (most recent request in the group defines the sort).
    result.sort((a, b) => {
      const aLatest = Math.max(...a.requests.map((r) => new Date(r.createdAt).getTime()))
      const bLatest = Math.max(...b.requests.map((r) => new Date(r.createdAt).getTime()))
      return bLatest - aLatest
    })
    return result
  }, [requests, groupsByRequestId, isShortShipped])

  const filtered = useMemo(() => {
    // Filter on the group's summary state, not on individual requests.
    // Grouped shipments carry ONE chip on the card (their summaryState
    // — the earliest state in the group's members), so classifying on
    // that same signal keeps the tab and the chip consistent: a
    // partially-packed group with one PACKED and one PACKING request
    // reads as PACKING on the card AND lives in the PACKING tab, not
    // in both PACKING and PACKED.
    return groups.filter((g) => {
      if (marketFilter !== 'ALL' && g.locationId !== marketFilter) return false
      if (filter === 'ALL') return true
      if (filter === 'CLOSED') return g.summaryState === 'CLOSED' || g.summaryState === 'ARRIVED'
      return g.summaryState === filter
    })
  }, [groups, filter, marketFilter])

  return (
    <div>
      <PageHeader
        eyebrow={`${requests.length} total`}
        title="Requests"
        description="Every restock request across every market. Tap one to review its lines, adjust quantities, and move it through packing to dispatch. Filter with the chips below."
        actions={
          canCreate ? (
            <Link href="/requests/new" className="btn">
              + New
            </Link>
          ) : undefined
        }
      />

      {error && <p className="error-banner">{error}</p>}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <div className="row" style={{ overflowX: 'auto', paddingBottom: 4 }}>
          {STATE_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className="chip"
              style={{
                cursor: 'pointer',
                background: filter === s ? 'var(--signal)' : 'transparent',
                color: filter === s ? 'var(--signal-ink)' : 'var(--text-dim)',
                borderColor: filter === s ? 'var(--signal)' : 'var(--line-strong)',
                flexShrink: 0,
              }}
            >
              {s.toLowerCase()}
            </button>
          ))}
        </div>
        {canFilterByMarket && markets.length > 0 && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
            <div style={{ minWidth: 200 }}>
              <SearchableSelect
                value={marketFilter}
                options={[
                  { id: 'ALL', label: 'All markets' },
                  ...markets.map((m) => ({ id: m.id, label: m.name })),
                ]}
                onChange={(id) => setMarketFilter(id ?? 'ALL')}
                size="sm"
                showId={false}
                allowClear={false}
              />
            </div>
          </label>
        )}
      </div>

      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing here</p>
          <p className="empty-state-body">
            {filter === 'ALL'
              ? 'No requests yet. Create one when a market needs stock.'
              : `No requests in the ${filter.toLowerCase()} state right now.`}
          </p>
          {filter === 'ALL' && canCreate && (
            <Link href="/requests/new" className="empty-state-cta">
              + New request
            </Link>
          )}
        </div>
      ) : (
        <div className="request-grid">
          {filtered.map((g) => {
            const totalLines = g.requests.reduce((sum, r) => sum + r.lines.length, 0)
            const dates = g.requests.map((r) => new Date(r.createdAt).getTime())
            const oldest = new Date(Math.min(...dates))
            const newest = new Date(Math.max(...dates))
            const dateLabel =
              oldest.getTime() === newest.getTime()
                ? oldest.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : `${oldest.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${newest.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`

            // Distinct product names on this group's lines, capped to keep
            // the card scannable. "+N more" tells the CEO the card is
            // truncated so a quick glance is enough to know if the right
            // things are in the shipment.
            const productNames: string[] = []
            const seen = new Set<string>()
            for (const r of g.requests) {
              for (const line of r.lines) {
                const name = variationName(line.variationId)
                if (!name || seen.has(name)) continue
                seen.add(name)
                productNames.push(name)
              }
            }
            const totalUnits = g.requests.reduce(
              (sum, r) => sum + r.lines.reduce((s, l) => s + l.qtyRequested, 0),
              0,
            )
            const previewLimit = 3
            const previewNames = productNames.slice(0, previewLimit)
            const extraNames = productNames.length - previewNames.length

            const productPreview = previewNames.length > 0 && (
              <div className="stock-tile-products">
                {previewNames.map((n) => (
                  <span key={n} className="stock-tile-product-pill" title={n}>
                    {n}
                  </span>
                ))}
                {extraNames > 0 && (
                  <span className="stock-tile-product-more">+{extraNames} more</span>
                )}
              </div>
            )

            // Single-request card.
            if (g.requests.length === 1) {
              const r = g.requests[0]!
              const shortShipped = isShortShipped(r)
              return (
                <Link
                  key={g.id}
                  href={`/requests/${r.id}`}
                  className={`request-card is-${r.state.toLowerCase()}`}
                >
                  <div className="request-card-head">
                    <div className="request-card-heading">
                      <span className="request-card-title">{locationName(r.locationId)}</span>
                      <span className="request-card-meta">
                        {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        {' · '}
                        {totalUnits.toLocaleString()} unit{totalUnits === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {shortShipped && (
                        <span
                          className="chip chip-rust"
                          title="Only part of the requested units were dispatched. The remainder was not packed."
                        >
                          short-shipped
                        </span>
                      )}
                      <span className={chipClassFor(r.state)}>{r.state.toLowerCase()}</span>
                    </div>
                  </div>
                  {productPreview}
                </Link>
              )
            }

            // Multi-request grouped shipment card. Same shell, plus a
            // pine top-ribbon signalling the shipment grouping so the
            // grid still reads as one design family.
            const shipmentHref = `/requests/shipment?ids=${g.requests
              .map((r) => encodeURIComponent(r.id))
              .join(',')}`
            return (
              <Link
                key={g.id}
                href={shipmentHref}
                className={`request-card request-card--grouped is-${g.summaryState.toLowerCase()}`}
                title={`Grouped shipment — ${g.requests.length} requests, ${totalLines} lines`}
              >
                <span className="request-card-ribbon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                  Grouped shipment · {g.requests.length} requests
                </span>
                <div className="request-card-head">
                  <div className="request-card-heading">
                    <span className="request-card-title">{locationName(g.locationId)}</span>
                    <span className="request-card-meta">
                      {dateLabel} · {totalUnits.toLocaleString()} unit{totalUnits === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {g.hasShortShipped && (
                      <span
                        className="chip chip-rust"
                        title="At least one request in this shipment was short-shipped."
                      >
                        short-shipped
                      </span>
                    )}
                    <span className={chipClassFor(g.summaryState)}>{g.summaryState.toLowerCase()}</span>
                  </div>
                </div>
                {productPreview}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function RequestsPage() {
  return (
    <RequireAuth>
      <RequestsBody />
    </RequireAuth>
  )
}
