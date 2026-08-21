'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { LocationDto, LowStockRow, RestockRequestDto, StockLevel, VariationSummary } from '@winterborn/shared'
import { RequireAuth } from '../components/RequireAuth'
import { Swatch } from '../components/Swatch'
import { useAuth } from '../lib/auth-context'
import { ApiError, listLocations, listRequests, listVariations, lowStock, stockByFamily } from '../lib/api'

function DashboardBody() {
  const { user } = useAuth()
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [stock, setStock] = useState<StockLevel[]>([])
  const [low, setLow] = useState<LowStockRow[]>([])
  const [locationId, setLocationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const isMarketManager = user?.role === 'MARKET_MANAGER'

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [locs, vars, reqs] = await Promise.all([listLocations(), listVariations(), listRequests()])
        if (cancelled) return
        setLocations(locs)
        setVariations(vars)
        setRequests(reqs)
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
    Promise.all([stockByFamily(locationId), lowStock(locationId)])
      .then(([s, l]) => {
        if (cancelled) return
        setStock(s)
        setLow(l)
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
