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
  VariationSummary,
} from '@winterborn/shared'
import { RequireAuth } from '../components/RequireAuth'
import { Swatch } from '../components/Swatch'
import { useAuth } from '../lib/auth-context'
import {
  ApiError,
  decisionQueue,
  listLocations,
  listRequests,
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
    // Three bulk reads, never one call per row -- the ledger this derives
    // over holds 40,000+ events (spec §9.9 / plan-06's hardening bullet).
    Promise.all([stockByFamily(locationId), lowStock(locationId), salesSince(locationId, 7)])
      .then(([s, l, sold]) => {
        if (cancelled) return
        setStock(s)
        setLow(l)
        setSales(sold)
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

  const stockRows = useMemo(
    () =>
      stock
        .map((s) => ({ ...s, meta: variationById.get(s.variationId) }))
        .filter((s) => s.meta)
        .sort((a, b) => (a.meta!.itemGroupName + a.meta!.colourFamilyName).localeCompare(b.meta!.itemGroupName + b.meta!.colourFamilyName)),
    [stock, variationById],
  )

  const lowRows = useMemo(
    () =>
      low
        .map((l) => ({ ...l, meta: variationById.get(l.variationId) }))
        .filter((l) => l.meta)
        .sort((a, b) => a.onHand - b.onHand),
    [low, variationById],
  )

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

  return (
    <div>
      {error && <p className="error-banner">{error}</p>}

      <div className="section-heading">
        <h2>{isMarketManager ? currentMarket?.name ?? 'Your market' : 'Market'}</h2>
        {!isMarketManager && markets.length > 1 && (
          <select
            value={locationId ?? ''}
            onChange={(e) => setLocationId(e.target.value)}
            style={{
              background: 'var(--surface-sunken)',
              color: 'var(--text)',
              border: '1px solid var(--line-strong)',
              borderRadius: 'var(--radius-md)',
              padding: '8px 10px',
            }}
          >
            {markets.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!isMarketManager && (
        <>
          <div className="section-heading">
            <h2>Decision queue</h2>
            <span className="eyebrow">{queue.length}</span>
          </div>
          {queue.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                Nothing auto-drafted and waiting on review. Stage 1 is manual-review: this list only fills when a
                threshold breach happened and nobody has actioned it yet.
              </p>
            </div>
          ) : (
            <div className="list">
              {queue.map((row) => (
                <Link key={row.requestId} href={`/requests/${row.requestId}`} className="list-row">
                  <div className="list-row-body">
                    <div className="list-row-title">{locationById.get(row.locationId)?.name ?? row.locationId}</div>
                    <div className="list-row-meta">
                      {row.lines
                        .map((line) => {
                          const meta = variationById.get(line.variationId)
                          const label = meta ? `${meta.itemGroupName} ${meta.colourFamilyName}` : line.variationId
                          return `${label} (${line.onHand}/${line.minLevel})`
                        })
                        .join(' · ')}
                    </div>
                  </div>
                  <span className="chip chip-rust">{row.lines.length} line{row.lines.length === 1 ? '' : 's'}</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      <div className="section-heading">
        <h2>Low on stock</h2>
        <span className="eyebrow">{lowRows.length}</span>
      </div>
      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : lowRows.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>Nothing under threshold here. Good.</p>
        </div>
      ) : (
        <div className="list">
          {lowRows.map((row) => (
            <div key={row.variationId} className="list-row">
              <Swatch familyName={row.meta?.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">{row.meta?.itemGroupName}</div>
                <div className="list-row-meta">
                  {row.meta?.colourFamilyName} · {row.meta?.sizeOptionName}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="mono" style={{ fontWeight: 700 }}>
                  {row.onHand}
                  <span style={{ color: 'var(--text-faint)' }}> / {row.minLevel}</span>
                </div>
                <span className="chip chip-rust">Low</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section-heading">
        <h2>Sales this week</h2>
        <span className="eyebrow">{salesTotal} units</span>
      </div>
      {!loading && salesRows.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>No sales recorded here in the last 7 days.</p>
        </div>
      ) : (
        <div className="list">
          {salesRows.slice(0, 8).map((row) => (
            <div key={row.variationId} className="list-row">
              <Swatch familyName={row.meta?.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">{row.meta?.itemGroupName}</div>
                <div className="list-row-meta">
                  {row.meta?.colourFamilyName} · {row.meta?.sizeOptionName}
                </div>
              </div>
              <div className="mono" style={{ fontWeight: 700 }}>
                {row.unitsSold}
              </div>
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
      {openRequests.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>No open requests right now.</p>
        </div>
      ) : (
        <div className="list">
          {openRequests.map((r) => (
            <Link key={r.id} href={`/requests/${r.id}`} className="list-row">
              <div className="list-row-body">
                <div className="list-row-title">
                  {locations.find((l) => l.id === r.locationId)?.name ?? r.locationId}
                </div>
                <div className="list-row-meta">
                  {r.lines.length} line{r.lines.length === 1 ? '' : 's'} · {r.createdFrom.toLowerCase()}
                </div>
              </div>
              <span className={`chip ${r.state === 'DISPATCHED' ? 'chip-pine' : ''}`}>{r.state.toLowerCase()}</span>
            </Link>
          ))}
        </div>
      )}

      <div className="section-heading">
        <h2>On hand by family</h2>
        <span className="eyebrow">{stockRows.length}</span>
      </div>
      {!loading && stockRows.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>No stock movement recorded here yet.</p>
        </div>
      ) : (
        <div className="list">
          {stockRows.map((row) => (
            <div key={row.variationId} className="list-row">
              <Swatch familyName={row.meta?.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">{row.meta?.itemGroupName}</div>
                <div className="list-row-meta">
                  {row.meta?.colourFamilyName} · {row.meta?.sizeOptionName}
                </div>
              </div>
              <div className="mono" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                {row.onHand}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardBody />
    </RequireAuth>
  )
}
