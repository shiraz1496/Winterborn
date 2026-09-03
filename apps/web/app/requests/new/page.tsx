'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { LocationDto, VariationSummary, WarehouseVariantSummary } from '@winterborn/shared'
import { CopyButton } from '../../../components/CopyButton'
import { PageHeader } from '../../../components/PageHeader'
import { ProductThumb, firstPhoto } from '../../../components/ProductThumb'
import { RequireAuth } from '../../../components/RequireAuth'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { useAuth } from '../../../lib/auth-context'
import {
  ApiError,
  createRequest,
  listLocations,
  listVariations,
  listWarehouseVariants,
  stockByVariant,
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
  /// Root-first ancestor chain incl. the leaf folder — displayed on the
  /// row so the requested-items list matches the picker's breadcrumb.
  categoryPath: string[]
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
  const [onHandByVariantId, setOnHandByVariantId] = useState<Map<string, number>>(() => new Map())
  // Warehouse on-hand per warehouse variant. Surfaced alongside the market
  // number so the operator can compare "what's in this market" against
  // "what's available to send" — the CEO was reading the market count as
  // the warehouse count, so both need to be labelled and shown together.
  const [onHandByVariantAtWarehouse, setOnHandByVariantAtWarehouse] = useState<Map<string, number>>(
    () => new Map(),
  )
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
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the catalog.'))
  }, [])

  /// Market on-hand for the selected location. Refetched whenever the
  /// market picker changes so an owner switching between markets sees
  /// the right numbers instead of a stale snapshot from the first market.
  /// Per-variant sums at a market read as "sent, not yet reconciled"
  /// (sales carry no variant), but summing them per family still gives
  /// the family-level total accurate for planning what to request.
  useEffect(() => {
    if (!locationId) {
      setOnHandByVariantId(new Map())
      return
    }
    let cancelled = false
    stockByVariant(locationId)
      .then((stock) => {
        if (cancelled) return
        const m = new Map<string, number>()
        for (const s of stock) if (s.warehouseVariantId) m.set(s.warehouseVariantId, s.onHand)
        setOnHandByVariantId(m)
      })
      .catch(() => {
        if (!cancelled) setOnHandByVariantId(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [locationId])

  const markets = useMemo(() => locations.filter((l) => l.kind === 'MARKET'), [locations])
  const warehouseId = useMemo(() => locations.find((l) => l.kind === 'WAREHOUSE')?.id ?? null, [locations])

  // Warehouse on-hand, fetched once we know which warehouse to look at.
  // Doesn't depend on the selected market — the "in warehouse" count is
  // the same regardless of which market the operator is packing for.
  useEffect(() => {
    if (!warehouseId) {
      setOnHandByVariantAtWarehouse(new Map())
      return
    }
    let cancelled = false
    stockByVariant(warehouseId)
      .then((stock) => {
        if (cancelled) return
        const m = new Map<string, number>()
        for (const s of stock) if (s.warehouseVariantId) m.set(s.warehouseVariantId, s.onHand)
        setOnHandByVariantAtWarehouse(m)
      })
      .catch(() => {
        if (!cancelled) setOnHandByVariantAtWarehouse(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [warehouseId])

  // Auto-select the first market for owners so the picker isn't left on
  // "pick one" — they still get the full list to switch. Market managers
  // are pinned to their own location via user.locationId and skip this.
  // Also runs when the currently selected id isn't in the market list
  // (e.g. user.locationId happens to point at a warehouse), otherwise
  // the trigger would silently show the placeholder.
  useEffect(() => {
    if (isMarketManager) return
    if (markets.length === 0) return
    if (locationId && markets.some((m) => m.id === locationId)) return
    setLocationId(markets[0]!.id)
  }, [isMarketManager, locationId, markets])
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

  const familyOnHand = useMemo(() => {
    const m = new Map<string, number>()
    for (const [variationId, list] of variantsByVariation) {
      m.set(variationId, list.reduce((sum, wv) => sum + (onHandByVariantId.get(wv.id) ?? 0), 0))
    }
    return m
  }, [variantsByVariation, onHandByVariantId])

  const familyOnHandAtWarehouse = useMemo(() => {
    const m = new Map<string, number>()
    for (const [variationId, list] of variantsByVariation) {
      m.set(
        variationId,
        list.reduce((sum, wv) => sum + (onHandByVariantAtWarehouse.get(wv.id) ?? 0), 0),
      )
    }
    return m
  }, [variantsByVariation, onHandByVariantAtWarehouse])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const takenIds = new Set(families.map((f) => f.variationId))
    // See intake — SKU and specific colour-variant names ("Dark Gray")
    // live on the variant, not the variation, so pre-index and OR in.
    const variantSideMatchIds = new Set(
      allVariants
        .filter(
          (wv) =>
            wv.warehouseSku.toLowerCase().includes(q) ||
            wv.colourVariantName.toLowerCase().includes(q),
        )
        .map((wv) => wv.variationId),
    )
    return variations
      .filter((v) => {
        if (variantSideMatchIds.has(v.id)) return true
        return [...v.categoryPath, v.itemGroupName, v.colourFamilyName, v.sizeOptionName]
          .join(' ')
          .toLowerCase()
          .includes(q)
      })
      .filter((v) => !takenIds.has(v.id))
      .slice(0, 30)
  }, [query, variations, allVariants, families])

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
      categoryPath: v.categoryPath,
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
          <SearchableSelect
            value={locationId || null}
            options={markets.map((m) => ({ id: m.id, label: m.name }))}
            onChange={(id) => id && setLocationId(id)}
            showId={false}
            allowClear={false}
          />
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
            const onHand = familyOnHand.get(v.id) ?? 0
            const onHandWh = familyOnHandAtWarehouse.get(v.id) ?? 0
            return (
              <button
                key={v.id}
                onClick={() => addFamily(v)}
                className="list-row"
                style={{ border: '1px solid var(--line-strong)', textAlign: 'left', width: '100%' }}
              >
                <ProductThumb
                  photoUrl={firstPhoto(variantsByVariation.get(v.id) ?? [])}
                  familyName={v.colourFamilyName}
                  alt={v.itemGroupName}
                />
                <div className="list-row-body">
                  <div className="list-row-title">{v.itemGroupName}</div>
                  <div className="list-row-meta">
                    <span style={{ color: 'var(--text-faint)' }}>
                      {(v.categoryPath.length > 1 ? v.categoryPath.slice(1) : v.categoryPath).join(' › ')} ·{' '}
                    </span>
                    {v.colourFamilyName} · {v.sizeOptionName}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  <div className="stock-pair">
                    <div className="stock-cell" aria-label={`${onHand} on hand in market`}>
                      <span className={`stock-cell-value${onHand === 0 ? ' is-zero' : ''}`}>{onHand}</span>
                      <span className="stock-cell-label">In market</span>
                    </div>
                    <div className="stock-cell is-warehouse" aria-label={`${onHandWh} on hand in warehouse`}>
                      <span className={`stock-cell-value${onHandWh === 0 ? ' is-zero' : ''}`}>{onHandWh}</span>
                      <span className="stock-cell-label">In warehouse</span>
                    </div>
                  </div>
                  <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>
                    {variantCount} variant{variantCount === 1 ? '' : 's'}
                  </span>
                </div>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ color: 'var(--text-faint)', marginLeft: 4, flexShrink: 0 }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
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
        <div className="empty-state">
          <p className="empty-state-title">Nothing requested yet</p>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
            Use the search above to add what this market needs.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ marginBottom: 24 }}>
          {families.map((f) => {
            const familyTotal = Object.values(f.qtyByVariant).reduce((s, n) => s + n, 0)
            const familyMarket = familyOnHand.get(f.variationId) ?? 0
            const familyWarehouse = familyOnHandAtWarehouse.get(f.variationId) ?? 0
            const open = openId === f.variationId
            return (
              <div key={f.variationId} className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => removeFamily(f.variationId)}
                    aria-label="Remove item"
                    title="Remove item"
                    style={{ minHeight: 32, minWidth: 32, padding: '4px 8px', flexShrink: 0 }}
                  >
                    ✕
                  </button>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenId(open ? null : f.variationId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpenId(open ? null : f.variationId)
                      }
                    }}
                    aria-expanded={open}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flex: 1,
                      minWidth: 0,
                      cursor: 'pointer',
                    }}
                  >
                    <ProductThumb
                      photoUrl={firstPhoto(f.variants)}
                      familyName={f.familyName}
                      alt={f.itemGroupName}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span className="list-row-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.itemGroupName}
                        </span>
                        <CopyButton text={f.itemGroupName} label="Copy product name" size="sm" />
                      </div>
                      <div className="list-row-meta">
                        <span style={{ color: 'var(--text-faint)' }}>
                          {(f.categoryPath.length > 1 ? f.categoryPath.slice(1) : f.categoryPath).join(' › ')} ·{' '}
                        </span>
                        {f.familyName} · {f.sizeName}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                      <div style={{ textAlign: 'right' }}>
                        <div className="mono" style={{ fontWeight: 700, fontSize: '1.1rem', lineHeight: 1 }}>
                          {familyTotal}
                        </div>
                        <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>
                          Requested
                        </span>
                      </div>
                      <div className="stock-pair">
                        <div className="stock-cell" aria-label={`${familyMarket} on hand in market`}>
                          <span className={`stock-cell-value${familyMarket === 0 ? ' is-zero' : ''}`}>{familyMarket}</span>
                          <span className="stock-cell-label">In market</span>
                        </div>
                        <div className="stock-cell is-warehouse" aria-label={`${familyWarehouse} on hand in warehouse`}>
                          <span className={`stock-cell-value${familyWarehouse === 0 ? ' is-zero' : ''}`}>{familyWarehouse}</span>
                          <span className="stock-cell-label">In warehouse</span>
                        </div>
                      </div>
                    </div>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={{
                        color: 'var(--text-faint)',
                        marginLeft: 4,
                        flexShrink: 0,
                        transition: 'transform 0.15s ease',
                        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
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
                        const onHand = onHandByVariantId.get(v.id) ?? 0
                        const onHandWh = onHandByVariantAtWarehouse.get(v.id) ?? 0
                        return (
                          <div
                            key={v.id}
                            className="list-row"
                            style={{ border: '1px solid var(--line)' }}
                          >
                            <ProductThumb
                              photoUrl={v.photoUrl}
                              familyName={v.colourVariantName}
                              alt={v.colourVariantName}
                            />
                            <div className="list-row-body">
                              <div className="list-row-title">{v.colourVariantName}</div>
                              <div className="list-row-meta mono">{v.warehouseSku}</div>
                              <div className="stock-inline" style={{ marginTop: 4, flexWrap: 'wrap' }}>
                                <span
                                  className={`stock-inline-pill${onHand === 0 ? ' is-zero' : ''}`}
                                  aria-label={`${onHand} on hand in market`}
                                  title={`${onHand} in market`}
                                >
                                  <span className="stock-inline-pill-label">Mkt</span>
                                  {onHand}
                                </span>
                                <span
                                  className={`stock-inline-pill is-warehouse${onHandWh === 0 ? ' is-zero' : ''}`}
                                  aria-label={`${onHandWh} on hand in warehouse`}
                                  title={`${onHandWh} in warehouse`}
                                >
                                  <span className="stock-inline-pill-label">Wh</span>
                                  {onHandWh}
                                </span>
                                {onHandWh === 0 && (
                                  <span
                                    className="backorder-hint"
                                    title="You can still request this, packing will begin when warehouse stock arrives."
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <circle cx="12" cy="12" r="9" />
                                      <polyline points="12 7 12 12 15 14" />
                                    </svg>
                                    Backorder
                                  </span>
                                )}
                              </div>
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
                              <input
                                type="number"
                                className="stepper-input"
                                min={0}
                                step={1}
                                value={qty}
                                onChange={(e) => setVariantQty(f.variationId, v.id, Number(e.target.value))}
                                onFocus={(e) => e.currentTarget.select()}
                                aria-label={`Quantity of ${v.colourVariantName}`}
                              />
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
