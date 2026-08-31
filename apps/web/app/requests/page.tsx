'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { BoxDto, LocationDto, RestockRequestDto } from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { SearchableSelect } from '../../components/SearchableSelect'
import { useAuth } from '../../lib/auth-context'
import { ApiError, listBoxes, listLocations, listRequests } from '../../lib/api'

const STATE_FILTERS = ['ALL', 'OPEN', 'PACKING', 'DISPATCHED', 'CLOSED'] as const
type StateFilter = (typeof STATE_FILTERS)[number]

function chipClassFor(state: string): string {
  if (state === 'DISPATCHED' || state === 'ARRIVED' || state === 'CLOSED') return 'chip chip-pine'
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
  const [filter, setFilter] = useState<StateFilter>('ALL')
  const [marketFilter, setMarketFilter] = useState<string>('ALL')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // Boxes are pulled alongside requests so requests sharing a physical
    // box can be grouped into a single "shipment" card.
    Promise.all([listRequests(), listLocations(), listBoxes()])
      .then(([r, l, b]) => {
        if (cancelled) return
        setRequests(r)
        setLocations(l)
        setBoxes(b)
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

  interface RequestGroup {
    /// Canonical id (the union-find root). Stable across renders.
    id: string
    locationId: string
    /// Requests in this shipment, oldest first.
    requests: RestockRequestDto[]
    /// Union of state chips to show. For groups of >1, we surface a
    /// summary chip based on the most advanced state — a group is
    /// "closed" only when every request in it is closed, otherwise
    /// it shows the earliest state (packing beats dispatched).
    summaryState: string
  }
  const STATE_ORDER = ['DRAFT', 'OPEN', 'PACKING', 'DISPATCHED', 'ARRIVED', 'CLOSED']
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
      // Summary state: earliest state in the group order. If any request
      // is still OPEN, the whole shipment reads as OPEN, etc.
      let summary = list[0]!.state
      for (const r of list) {
        if (STATE_ORDER.indexOf(r.state) < STATE_ORDER.indexOf(summary)) summary = r.state
      }
      result.push({
        id,
        locationId: list[0]!.locationId,
        requests: list,
        summaryState: summary,
      })
    }
    // Newest group first (most recent request in the group defines the sort).
    result.sort((a, b) => {
      const aLatest = Math.max(...a.requests.map((r) => new Date(r.createdAt).getTime()))
      const bLatest = Math.max(...b.requests.map((r) => new Date(r.createdAt).getTime()))
      return bLatest - aLatest
    })
    return result
  }, [requests, groupsByRequestId])

  const filtered = useMemo(() => {
    // A group passes the state filter if any of its requests matches.
    // CLOSED is treated as CLOSED|ARRIVED same as before.
    const stateMatch = (r: RestockRequestDto) =>
      filter === 'ALL'
        ? true
        : filter === 'CLOSED'
          ? r.state === 'CLOSED' || r.state === 'ARRIVED'
          : r.state === filter
    return groups.filter((g) => {
      if (marketFilter !== 'ALL' && g.locationId !== marketFilter) return false
      return g.requests.some(stateMatch)
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
        <div className="stock-grid">
          {filtered.map((g) => {
            const totalLines = g.requests.reduce((sum, r) => sum + r.lines.length, 0)
            const dates = g.requests.map((r) => new Date(r.createdAt).getTime())
            const oldest = new Date(Math.min(...dates))
            const newest = new Date(Math.max(...dates))
            const dateLabel =
              oldest.getTime() === newest.getTime()
                ? oldest.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : `${oldest.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${newest.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`

            // Single-request "group" — render exactly like today.
            if (g.requests.length === 1) {
              const r = g.requests[0]!
              return (
                <Link
                  key={g.id}
                  href={`/requests/${r.id}`}
                  className="stock-tile"
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <div className="stock-tile-body">
                    <div className="stock-tile-title">{locationName(r.locationId)}</div>
                    <div className="stock-tile-meta">
                      {r.lines.length} line{r.lines.length === 1 ? '' : 's'} ·{' '}
                      {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                  <span className={chipClassFor(r.state)}>{r.state.toLowerCase()}</span>
                </Link>
              )
            }

            // Multi-request grouped shipment card. The whole tile is a
            // single Link into the shipment view scoped to the grouped
            // requests — the drill-in shows the merged product list
            // ("all products as one box"), not one constituent request.
            const totalUnits = g.requests.reduce(
              (sum, r) => sum + r.lines.reduce((s, l) => s + l.qtyRequested, 0),
              0,
            )
            const shipmentHref = `/requests/shipment?ids=${g.requests
              .map((r) => encodeURIComponent(r.id))
              .join(',')}`
            return (
              <Link
                key={g.id}
                href={shipmentHref}
                className="stock-tile"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  borderColor: 'var(--pine, var(--line-strong))',
                  background: 'var(--surface-sunken)',
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <div className="row-between" style={{ alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="stock-tile-title">{locationName(g.locationId)}</div>
                    <div className="stock-tile-meta">
                      {g.requests.length} requests · {totalLines} lines · {dateLabel}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span
                      className="chip chip-pine"
                      title="These requests were packed together in a shared box"
                    >
                      one shipment
                    </span>
                    <span className={chipClassFor(g.summaryState)}>{g.summaryState.toLowerCase()}</span>
                  </div>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                  {totalUnits.toLocaleString()} unit{totalUnits === 1 ? '' : 's'} across{' '}
                  {g.requests.length} requests · view →
                </div>
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
