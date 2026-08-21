'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { LocationDto, VariationSummary } from '@winterborn/shared'
import { RequireAuth } from '../../../components/RequireAuth'
import { Swatch } from '../../../components/Swatch'
import { useAuth } from '../../../lib/auth-context'
import { ApiError, createRequest, listLocations, listVariations } from '../../../lib/api'

interface DraftLine {
  variationId: string
  qty: number
  label: string
  colourFamilyName: string
}

function NewRequestBody() {
  const { user } = useAuth()
  const router = useRouter()
  const isMarketManager = user?.role === 'MARKET_MANAGER'

  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [locationId, setLocationId] = useState<string>(user?.locationId ?? '')
  const [query, setQuery] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([listLocations(), listVariations()])
      .then(([l, v]) => {
        setLocations(l)
        setVariations(v)
        if (!isMarketManager && !locationId) {
          const firstMarket = l.find((loc) => loc.kind === 'MARKET')
          if (firstMarket) setLocationId(firstMarket.id)
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the catalog.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const markets = useMemo(() => locations.filter((l) => l.kind === 'MARKET'), [locations])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    return variations
      .filter((v) => `${v.itemGroupName} ${v.colourFamilyName} ${v.sizeOptionName}`.toLowerCase().includes(q))
      .filter((v) => !lines.some((l) => l.variationId === v.id))
      .slice(0, 8)
  }, [query, variations, lines])

  function addLine(v: VariationSummary) {
    setLines((prev) => [
      ...prev,
      {
        variationId: v.id,
        qty: 1,
        label: `${v.itemGroupName} · ${v.sizeOptionName}`,
        colourFamilyName: v.colourFamilyName,
      },
    ])
    setQuery('')
  }

  function setQty(variationId: string, qty: number) {
    setLines((prev) => prev.map((l) => (l.variationId === variationId ? { ...l, qty: Math.max(1, qty) } : l)))
  }

  function removeLine(variationId: string) {
    setLines((prev) => prev.filter((l) => l.variationId !== variationId))
  }

  async function submit() {
    if (!locationId || lines.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const created = await createRequest({
        locationId,
        createdFrom: 'MANUAL',
        lines: lines.map((l) => ({ variationId: l.variationId, qtyRequested: l.qty })),
      })
      router.replace(`/requests/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the request.')
      setBusy(false)
    }
  }

  return (
    <div>
      {error && <p className="error-banner">{error}</p>}

      {!isMarketManager && (
        <div className="field">
          <label htmlFor="location">Market</label>
          <select id="location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            {markets.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor="search">Add an item</label>
        <input
          id="search"
          placeholder="Search by product, colour, size…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {matches.length > 0 && (
        <div className="list" style={{ marginBottom: 20 }}>
          {matches.map((v) => (
            <button
              key={v.id}
              onClick={() => addLine(v)}
              className="list-row"
              style={{ border: '1px solid var(--line-strong)', textAlign: 'left', width: '100%' }}
            >
              <Swatch familyName={v.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">{v.itemGroupName}</div>
                <div className="list-row-meta">
                  {v.colourFamilyName} · {v.sizeOptionName}
                </div>
              </div>
              <span className="eyebrow">Add</span>
            </button>
          ))}
        </div>
      )}

      <div className="section-heading">
        <h2>Lines</h2>
        <span className="eyebrow">{lines.length}</span>
      </div>

      {lines.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>Search above to add what this market needs.</p>
        </div>
      ) : (
        <div className="list" style={{ marginBottom: 28 }}>
          {lines.map((l) => (
            <div key={l.variationId} className="list-row">
              <Swatch familyName={l.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">{l.label}</div>
                <div className="list-row-meta">{l.colourFamilyName}</div>
              </div>
              <div className="stepper">
                <button className="stepper-btn" onClick={() => setQty(l.variationId, l.qty - 1)} aria-label="Decrease">
                  −
                </button>
                <span className="stepper-value">{l.qty}</span>
                <button className="stepper-btn" onClick={() => setQty(l.variationId, l.qty + 1)} aria-label="Increase">
                  +
                </button>
              </div>
              <button className="btn btn-ghost" onClick={() => removeLine(l.variationId)} aria-label="Remove line">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-primary" onClick={submit} disabled={busy || !locationId || lines.length === 0}>
        {busy ? 'Creating…' : 'Create request'}
      </button>
    </div>
  )
}

export default function NewRequestPage() {
  return (
    <RequireAuth>
      <NewRequestBody />
    </RequireAuth>
  )
}
