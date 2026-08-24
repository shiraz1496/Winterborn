'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type {
  DecisionQueueRow,
  LocationDto,
  LowStockRow,
  RestockRequestDto,
  SalesRow,
  StockLevel,
  StockStatus,
  ThresholdDto,
  VariationSummary,
} from '@winterborn/shared'
import { classifyStock } from '@winterborn/shared'
import { PageHeader } from '../components/PageHeader'
import { RequireAuth } from '../components/RequireAuth'
import { StatusLegend } from '../components/StatusLegend'
import { StockStatusChip } from '../components/StockStatusChip'
import { Swatch } from '../components/Swatch'
import { useAuth } from '../lib/auth-context'
import {
  ApiError,
  decisionQueue,
  listLocations,
  listRequests,
  listThresholds,
  listVariations,
  lowStock,
  salesSince,
  stockByFamily,
} from '../lib/api'

function DashboardBody() {
  const { user } = useAuth()
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [stock, setStock] = useState<StockLevel[]>([])
  const [low, setLow] = useState<LowStockRow[]>([])
  const [thresholds, setThresholds] = useState<ThresholdDto[]>([])
  const [sales, setSales] = useState<SalesRow[]>([])
  const [queue, setQueue] = useState<DecisionQueueRow[]>([])
  const [locationId, setLocationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const isMarketManager = user?.role === 'MARKET_MANAGER'

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const calls: [
          ReturnType<typeof listLocations>,
          ReturnType<typeof listVariations>,
          ReturnType<typeof listRequests>,
          ReturnType<typeof decisionQueue> | Promise<DecisionQueueRow[]>,
        ] = [listLocations(), listVariations(), listRequests(), isMarketManager ? Promise.resolve([]) : decisionQueue()]
        const [locs, vars, reqs, dq] = await Promise.all(calls)
        if (cancelled) return
        setLocations(locs)
        setVariations(vars)
        setRequests(reqs)
        setQueue(dq)
        const markets = locs.filter((l) => l.kind === 'MARKET')
        const initial = isMarketManager ? (user?.locationId ?? markets[0]?.id ?? null) : (markets[0]?.id ?? null)
        setLocationId(initial)
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the dashboard.')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!locationId) return
    let cancelled = false
    setLoading(true)
    // Four bulk reads, never one call per row -- the ledger this derives
    // over holds 40,000+ events (spec §9.9 / plan-06's hardening bullet).
    // Doc 3 §3.7: thresholds joined client-side so every row can carry a
    // Healthy/Low/Critical/OOS label without a per-line lookup.
    Promise.all([
      stockByFamily(locationId),
      lowStock(locationId),
      salesSince(locationId, 7),
      listThresholds(locationId),
    ])
      .then(([s, l, sold, thr]) => {
        if (cancelled) return
        setStock(s)
        setLow(l)
        setSales(sold)
        setThresholds(thr)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load stock levels.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [locationId])

  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations])
  const markets = useMemo(() => locations.filter((l) => l.kind === 'MARKET'), [locations])
  const currentMarket = locations.find((l) => l.id === locationId)

  const minLevelById = useMemo(
    () => new Map(thresholds.map((t) => [t.variationId, t.minLevel])),
    [thresholds],
  )

  const stockRows = useMemo(
    () =>
      stock
        .map((s) => {
          const meta = variationById.get(s.variationId)
          const minLevel = minLevelById.get(s.variationId) ?? null
          return { ...s, meta, minLevel, status: classifyStock(s.onHand, minLevel) }
        })
        .filter((s) => s.meta)
        .sort((a, b) => (a.meta!.itemGroupName + a.meta!.colourFamilyName).localeCompare(b.meta!.itemGroupName + b.meta!.colourFamilyName)),
    [stock, variationById, minLevelById],
  )

  const lowRows = useMemo(
    () =>
      low
        .map((l) => ({ ...l, meta: variationById.get(l.variationId), status: classifyStock(l.onHand, l.minLevel) }))
        .filter((l) => l.meta)
        .sort((a, b) => a.onHand - b.onHand),
    [low, variationById],
  )

  // Doc 3 §3.2: dashboard leads with what is flagged. OOS first, then
  // CRITICAL, then LOW, worst-hit within each band. Everything HEALTHY
  // stays in the "On hand by family" section further down.
  const STATUS_ORDER: Record<StockStatus, number> = {
    OUT_OF_STOCK: 0,
    CRITICAL: 1,
    LOW: 2,
    HEALTHY: 3,
  }
  const flaggedRows = useMemo(
    () =>
      stockRows
        .filter((r) => r.status !== 'HEALTHY')
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.onHand - b.onHand),
    [stockRows],
  )
  const flaggedCounts = useMemo(() => {
    const counts: Record<StockStatus, number> = { HEALTHY: 0, LOW: 0, CRITICAL: 0, OUT_OF_STOCK: 0 }
    for (const r of stockRows) counts[r.status]++
    return counts
  }, [stockRows])

  const openRequests = useMemo(
    () => requests.filter((r) => r.state !== 'CLOSED').slice(0, 8),
    [requests],
  )

  const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations])

  const salesRows = useMemo(
    () =>
      sales
        .map((s) => ({ ...s, meta: variationById.get(s.variationId) }))
        .filter((s) => s.meta && s.unitsSold > 0)
        .sort((a, b) => b.unitsSold - a.unitsSold),
    [sales, variationById],
  )
  const salesTotal = useMemo(() => sales.reduce((sum, s) => sum + s.unitsSold, 0), [sales])

  const canWarehouse = user?.role === 'OWNER' || user?.role === 'WAREHOUSE_MANAGER' || user?.role === 'WAREHOUSE_OPERATOR'

  return (
    <div>
      <PageHeader
        eyebrow={isMarketManager ? 'Your market' : 'Live inventory across every market'}
        title={isMarketManager ? currentMarket?.name ?? 'Your market' : 'Dashboard'}
        description={
          isMarketManager
            ? 'Everything low or empty at your booth is at the top. Submit a restock request from here or the Requests tab.'
            : 'Flagged stock leads the page. Anything under threshold or empty shows first, then the rest of the family view. Switch markets with the picker below.'
        }
        actions={
          !isMarketManager && markets.length > 1 ? (
            <select
              value={locationId ?? ''}
              onChange={(e) => setLocationId(e.target.value)}
              aria-label="Market"
              style={{
                background: 'var(--surface-sunken)',
                color: 'var(--text)',
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 12px',
                fontSize: '0.9rem',
              }}
            >
              {markets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : null
        }
      />

      {error && <p className="error-banner">{error}</p>}

      <div className="quick-actions">
        <Link href="/requests/new" className="quick-action">
          <svg className="quick-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="3" width="12" height="18" rx="2" />
            <path d="M8 8h8M8 12h5M15 15h4M17 13v4" strokeLinecap="round" />
          </svg>
          <div className="quick-action-label">New request</div>
          <div className="quick-action-desc">Ask the warehouse to send stock to a market.</div>
        </Link>
        {canWarehouse && (
          <>
            <Link href="/intake" className="quick-action">
              <svg className="quick-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3v12" strokeLinecap="round" />
                <path d="M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 19h16" strokeLinecap="round" />
              </svg>
              <div className="quick-action-label">Receive intake</div>
              <div className="quick-action-desc">Log new goods that just arrived at the warehouse.</div>
            </Link>
            <Link href="/pack" className="quick-action">
              <svg className="quick-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 8l9-5 9 5-9 5-9-5z" />
                <path d="M3 8v8l9 5 9-5V8M12 13v8" />
              </svg>
              <div className="quick-action-label">Pack a box</div>
              <div className="quick-action-desc">Fulfil an open request into physical boxes.</div>
            </Link>
          </>
        )}
      </div>

      <StatusLegend />

      <div className="dash-columns">
        <div>
          <div className="section-heading">
            <h2>Flagged at this market</h2>
            <span className="eyebrow">
              {flaggedCounts.OUT_OF_STOCK} out · {flaggedCounts.CRITICAL} critical · {flaggedCounts.LOW} low
            </span>
          </div>
          <p className="section-desc">
            Everything below its restock threshold or empty. Worst first.
          </p>
          {loading ? (
            <div className="screen-loading">
              <div className="spinner" aria-hidden="true" />
            </div>
          ) : flaggedRows.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                Nothing flagged here. Everything is at or above its threshold.
              </p>
            </div>
          ) : (
            <div className="stock-grid">
              {flaggedRows.map((row) => (
                <StockTile key={row.variationId} row={row} />
              ))}
            </div>
          )}

          <div className="section-heading">
            <h2>On hand by family</h2>
            <span className="eyebrow">
              {flaggedCounts.HEALTHY} healthy · {stockRows.length} total
            </span>
          </div>
          <p className="section-desc">
            Every colour family this market carries, sorted alphabetically. Number on the right is on-hand;
            smaller number after it is the minimum-level threshold.
          </p>
          {!loading && stockRows.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>No stock movement recorded here yet.</p>
            </div>
          ) : (
            <div className="stock-grid">
              {stockRows.map((row) => (
                <StockTile key={row.variationId} row={row} />
              ))}
            </div>
          )}
        </div>

        <div>
          {!isMarketManager && (
            <>
              <div className="section-heading">
                <h2>Decision queue</h2>
                <span className="eyebrow">{queue.length}</span>
              </div>
              <p className="section-desc">
                Auto-drafted restock requests waiting on review. Tap one to adjust quantities and open it for packing.
              </p>
              {queue.length === 0 ? (
                <div className="card">
                  <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                    Nothing waiting. This list only fills when a threshold breach happens and nobody has actioned it.
                  </p>
                </div>
              ) : (
                <div className="queue-grid">
                  {queue.slice(0, 6).map((row) => (
                    <DecisionQueueCard
                      key={row.requestId}
                      row={row}
                      locationName={locationById.get(row.locationId)?.name ?? row.locationId}
                      variationById={variationById}
                    />
                  ))}
                  {queue.length > 6 && (
                    <Link href="/requests" className="queue-card-more" style={{ textAlign: 'center' }}>
                      + {queue.length - 6} more in Requests
                    </Link>
                  )}
                </div>
              )}
            </>
          )}

          <div className="section-heading">
            <h2>Sales this week</h2>
            <span className="eyebrow">{salesTotal} units</span>
          </div>
          <p className="section-desc">
            Top-selling colour families over the last seven days at this market, straight from Square.
          </p>
          {!loading && salesRows.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>No sales recorded here in the last 7 days.</p>
            </div>
          ) : (
            <div className="stack">
              {salesRows.slice(0, 8).map((row) => (
                <div key={row.variationId} className="stock-tile">
                  <Swatch familyName={row.meta?.colourFamilyName} />
                  <div className="stock-tile-body">
                    <div className="stock-tile-title">{row.meta?.itemGroupName}</div>
                    <div className="stock-tile-meta">
                      {row.meta?.colourFamilyName} · {row.meta?.sizeOptionName}
                    </div>
                  </div>
                  <div className="stock-tile-num">{row.unitsSold}</div>
                </div>
              ))}
            </div>
          )}

          <div className="section-heading">
            <h2>Open requests</h2>
            <Link href="/requests" className="eyebrow">
              View all
            </Link>
          </div>
          <p className="section-desc">Requests in flight — draft, open, packing or dispatched.</p>
          {openRequests.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-title">No open requests</p>
              <p className="empty-state-body">Create one when a market needs stock.</p>
              <Link href="/requests/new" className="empty-state-cta">
                + New request
              </Link>
            </div>
          ) : (
            <div className="stack">
              {openRequests.map((r) => (
                <Link key={r.id} href={`/requests/${r.id}`} className="stock-tile" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="stock-tile-body">
                    <div className="stock-tile-title">
                      {locations.find((l) => l.id === r.locationId)?.name ?? r.locationId}
                    </div>
                    <div className="stock-tile-meta">
                      {r.lines.length} line{r.lines.length === 1 ? '' : 's'} · {r.createdFrom.toLowerCase()}
                    </div>
                  </div>
                  <span className={`chip ${r.state === 'DISPATCHED' ? 'chip-pine' : ''}`}>{r.state.toLowerCase()}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/// Row inside the dashboard's `stock-grid`. One tile per colour family with
/// swatch, name, colour + size, and its current on-hand / threshold. Sized
/// to fit as a two- or three-up grid on desktop instead of a full-width row
/// each, so ~500 tiles remain scannable rather than an endless column.
function StockTile({
  row,
}: {
  row: {
    variationId: string
    meta?: VariationSummary
    onHand: number
    minLevel: number | null
    status: StockStatus
  }
}) {
  return (
    <div className="stock-tile">
      <Swatch familyName={row.meta?.colourFamilyName} />
      <div className="stock-tile-body">
        <div className="stock-tile-title">{row.meta?.itemGroupName}</div>
        <div className="stock-tile-meta">
          {row.meta?.colourFamilyName} · {row.meta?.sizeOptionName}
        </div>
      </div>
      <div className="stock-tile-right">
        <div className="stock-tile-num">
          {row.onHand}
          {row.minLevel != null && (
            <span className="stock-tile-num-small"> / {row.minLevel}</span>
          )}
        </div>
        <StockStatusChip status={row.status} />
      </div>
    </div>
  )
}

/// One card per open THRESHOLD-origin request in the queue. Renders each
/// line as a structured mini-row rather than joining them into a single
/// paragraph of monospace text (which turned the queue into an unreadable
/// wall on any card carrying more than a handful of lines). Long queues
/// collapse to the top five with a "show all" toggle so a Sunday's
/// worth of breaches never dominates the dashboard.
function DecisionQueueCard({
  row,
  locationName,
  variationById,
}: {
  row: DecisionQueueRow
  locationName: string
  variationById: Map<string, VariationSummary>
}) {
  const [expanded, setExpanded] = useState(false)
  const preview = 5
  const visible = expanded ? row.lines : row.lines.slice(0, preview)
  const hidden = row.lines.length - visible.length

  return (
    <Link href={`/requests/${row.requestId}`} className="queue-card">
      <div className="queue-card-head">
        <div>
          <div className="queue-card-title">{locationName}</div>
          <div className="queue-card-meta">
            drafted {new Date(row.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ·{' '}
            {row.state.toLowerCase()}
          </div>
        </div>
        <span className="chip chip-rust">
          {row.lines.length} line{row.lines.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="queue-card-lines">
        {visible.map((line) => {
          const meta = variationById.get(line.variationId)
          const label = meta ? `${meta.itemGroupName} · ${meta.colourFamilyName}` : line.variationId
          return (
            <li key={line.lineId}>
              <span className="queue-card-line-label">{label}</span>
              <span className="queue-card-line-nums mono">
                {line.onHand}
                <span className="queue-card-line-sep"> / </span>
                {line.minLevel}
              </span>
            </li>
          )
        })}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="queue-card-more"
          onClick={(e) => {
            e.preventDefault()
            setExpanded(true)
          }}
        >
          + {hidden} more
        </button>
      )}
    </Link>
  )
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardBody />
    </RequireAuth>
  )
}
