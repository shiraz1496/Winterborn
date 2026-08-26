'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { LocationDto, VariationSummary, WarehouseVariantSummary } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { Swatch } from '../../../components/Swatch'
import { useAuth } from '../../../lib/auth-context'
import {
  ApiError,
  createRequest,
  listLocations,
  listVariations,
  listWarehouseVariants,
} from '../../../lib/api'
import { useToast } from '../../../lib/toast'

/// One family the market manager wants shipped. Contains a per-variant
/// qty map so they can request "3 Navy + 2 Sky Blue" against the same
/// family. On submit, one RestockRequestLine is written per variant that
/// has qty > 0 (variationId=family, warehouseVariantId=that variant).
interface DraftFamily {
  variationId: string
  itemGroupName: string
  familyName: string
  sizeName: string
  variants: WarehouseVariantSummary[]
  // Keyed by warehouseVariantId
  qtyByVariant: Record<string, number>
}

function NewRequestBody() {
  const { user } = useAuth()
  const router = useRouter()
  const toast = useToast()
  const isMarketManager = user?.role === 'MARKET_MANAGER'

  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [allVariants, setAllVariants] = useState<WarehouseVariantSummary[]>([])
  const [locationId, setLocationId] = useState<string>(user?.locationId ?? '')
  const [query, setQuery] = useState('')
  const [families, setFamilies] = useState<DraftFamily[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([listLocations(), listVariations(), listWarehouseVariants()])
      .then(([l, v, wv]) => {
        setLocations(l)
        setVariations(v)
        setAllVariants(wv)
        if (!isMarketManager && !locationId) {
          const firstMarket = l.find((loc) => loc.kind === 'MARKET')
          if (firstMarket) setLocationId(firstMarket.id)
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the catalog.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const markets = useMemo(() => locations.filter((l) => l.kind === 'MARKET'), [locations])
  const variantsByVariation = useMemo(() => {
    const m = new Map<string, WarehouseVariantSummary[]>()
    for (const wv of allVariants) {
      const list = m.get(wv.variationId) ?? []
      list.push(wv)
      m.set(wv.variationId, list)
    }
    for (const [, list] of m) list.sort((a, b) => a.colourVariantName.localeCompare(b.colourVariantName))
    return m
  }, [allVariants])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const takenIds = new Set(families.map((f) => f.variationId))
    return variations
      .filter((v) => `${v.itemGroupName} ${v.colourFamilyName} ${v.sizeOptionName}`.toLowerCase().includes(q))
      .filter((v) => !takenIds.has(v.id))
      .slice(0, 8)
  }, [query, variations, families])

  function addFamily(v: VariationSummary) {
    const variants = variantsByVariation.get(v.id) ?? []
    // If there's only one variant under this family, pre-fill it with 1
    // so a common case (single-variant item) is a one-tap request.
    const initialQty: Record<string, number> = {}
    if (variants.length === 1) {
      initialQty[variants[0]!.id] = 1
    }
    const family: DraftFamily = {
      variationId: v.id,
      itemGroupName: v.itemGroupName,
      familyName: v.colourFamilyName,
      sizeName: v.sizeOptionName,
      variants,
      qtyByVariant: initialQty,
    }
    setFamilies((prev) => [...prev, family])
    setOpenId(v.id)
    setQuery('')
  }

  function setVariantQty(familyId: string, variantId: string, qty: number) {
    setFamilies((prev) =>
      prev.map((f) => {
        if (f.variationId !== familyId) return f
        const next = { ...f.qtyByVariant }
        const clamped = Math.max(0, Math.floor(qty))
        if (clamped === 0) delete next[variantId]
        else next[variantId] = clamped
        return { ...f, qtyByVariant: next }
      }),
    )
  }

  function removeFamily(familyId: string) {
    setFamilies((prev) => prev.filter((f) => f.variationId !== familyId))
    if (openId === familyId) setOpenId(null)
  }

  const totalUnits = useMemo(
    () =>
      families.reduce(
        (sum, f) => sum + Object.values(f.qtyByVariant).reduce((s, n) => s + n, 0),
        0,
      ),
    [families],
  )

  const lineCount = useMemo(
    () => families.reduce((sum, f) => sum + Object.keys(f.qtyByVariant).length, 0),
    [families],
  )

  async function submit() {
    if (!locationId || lineCount === 0) return
    setBusy(true)
    setError(null)
    try {
      // One RestockRequestLine per (family, variant) with qty > 0.
      const lines = families.flatMap((f) =>
        Object.entries(f.qtyByVariant)
          .filter(([, qty]) => qty > 0)
          .map(([variantId, qty]) => ({
            variationId: f.variationId,
            warehouseVariantId: variantId,
            qtyRequested: qty,
          })),
      )
      const created = await createRequest({
        locationId,
        createdFrom: 'MANUAL',
        lines,
      })
      toast.success(`Request created — ${totalUnits} unit${totalUnits === 1 ? '' : 's'} across ${lineCount} line${lineCount === 1 ? '' : 's'}`)
      router.replace(`/requests/${created.id}`)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not create the request.'
      setError(msg)
      toast.error(msg)
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={isMarketManager ? 'For your market' : 'Manual request'}
        title="New request"
        description="Search for the product you want, expand to pick the specific colour variants you need, and set how many of each. Create the request when the list is ready."
      />

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
          autoComplete="off"
        />
      </div>

      {matches.length > 0 && (
        <div className="list" style={{ marginBottom: 20 }}>
          {matches.map((v) => {
            const variantCount = variantsByVariation.get(v.id)?.length ?? 0
            return (
              <button
                key={v.id}
                onClick={() => addFamily(v)}
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
                <span className="chip">
                  {variantCount} variant{variantCount === 1 ? '' : 's'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="section-heading">
        <h2>Items requested</h2>
        <span className="eyebrow">
          {lineCount} line{lineCount === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
        </span>
      </div>

      {families.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>Search above to add what this market needs.</p>
        </div>
      ) : (
        <div className="stack" style={{ marginBottom: 24 }}>
          {families.map((f) => {
            const familyTotal = Object.values(f.qtyByVariant).reduce((s, n) => s + n, 0)
            const open = openId === f.variationId
            return (
              <div key={f.variationId} className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : f.variationId)}
                    style={{
                      all: 'unset',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flex: 1,
                      minWidth: 0,
                      cursor: 'pointer',
                    }}
                  >
                    <Swatch familyName={f.familyName} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="list-row-title">{f.itemGroupName}</div>
                      <div className="list-row-meta">
                        {f.familyName} · {f.sizeName}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                        {familyTotal}
                      </div>
                      <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>
                        {f.variants.length} variant{f.variants.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => removeFamily(f.variationId)}
                    aria-label="Remove item"
                    style={{ minHeight: 40, padding: '6px 10px' }}
                  >
                    ✕
                  </button>
                </div>

                {open && (
                  <div className="stack" style={{ marginTop: 14, gap: 8 }}>
                    {f.variants.length === 0 ? (
                      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                        No specific variants for this family — request goes at family level.
                      </p>
                    ) : (
                      f.variants.map((v) => {
                        const qty = f.qtyByVariant[v.id] ?? 0
                        return (
                          <div
                            key={v.id}
                            className="list-row"
                            style={{ border: '1px solid var(--line)' }}
                          >
                            <Swatch familyName={v.colourVariantName} />
                            <div className="list-row-body">
                              <div className="list-row-title">{v.colourVariantName}</div>
                              <div className="list-row-meta mono">{v.warehouseSku}</div>
                            </div>
                            <div className="stepper">
                              <button
                                className="stepper-btn"
                                onClick={() => setVariantQty(f.variationId, v.id, qty - 1)}
                                disabled={qty <= 0}
                                aria-label="Decrease"
                              >
                                −
                              </button>
                              <span className="stepper-value">{qty}</span>
                              <button
                                className="stepper-btn"
                                onClick={() => setVariantQty(f.variationId, v.id, qty + 1)}
                                aria-label="Increase"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <button className="btn btn-primary" onClick={submit} disabled={busy || !locationId || lineCount === 0}>
        {busy ? 'Creating…' : `Create request${lineCount > 0 ? ` (${totalUnits} unit${totalUnits === 1 ? '' : 's'})` : ''}`}
      </button>
    </div>
  )
}

export default function NewRequestPage() {
  return (
    <RequireAuth roles={['MARKET_MANAGER', 'OWNER']}>
      <NewRequestBody />
    </RequireAuth>
  )
}
