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
  generateSuggestion,
  listLocations,
  listVariations,
  listWarehouseVariants,
  stockByVariant,
} from '../../../lib/api'
import type { GenerateSuggestionResult, SuggestionTargetMode } from '@winterborn/shared'
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

  // Packing-list suggestion panel state (CEO ask, voice notes 2026-09-01).
  // Kept local to this page rather than a URL param — the operator is
  // going to edit the draft here anyway, so no need to make the choice
  // shareable.
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestMode, setSuggestMode] = useState<SuggestionTargetMode>('MATCH_LAST_YEAR')
  const [suggestGrowthPct, setSuggestGrowthPct] = useState<number>(10)
  const [suggestTargetUnits, setSuggestTargetUnits] = useState<number>(500)
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [suggestNotes, setSuggestNotes] = useState<string[]>([])
  // Optional explicit sales window override. When left blank, the
  // backend falls back to the location's season window shifted back a
  // year, or a trailing 12-month window ending a year ago. Exposed here
  // so an operator can validate against a specific historical window
  // during testing / demoing without waiting for the calendar to catch up.
  const [suggestWindowStart, setSuggestWindowStart] = useState<string>('')
  const [suggestWindowEnd, setSuggestWindowEnd] = useState<string>('')

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

  /// Turn the backend's suggestion into the DraftFamily shape this page
  /// already renders. Groups by variationId, keeps only warehouseVariants
  /// we can display (the suggestion may refer to a variant that got
  /// deleted between generation and hydration — skip cleanly if so).
  function hydrateFromSuggestion(result: GenerateSuggestionResult) {
    const draftByVariation = new Map<string, DraftFamily>()
    for (const line of result.lines) {
      if (!line.warehouseVariantId) continue
      const meta = variations.find((v) => v.id === line.variationId)
      const variantMeta = allVariants.find((wv) => wv.id === line.warehouseVariantId)
      if (!meta || !variantMeta) continue

      let draft = draftByVariation.get(line.variationId)
      if (!draft) {
        draft = {
          variationId: line.variationId,
          itemGroupName: meta.itemGroupName,
          familyName: meta.colourFamilyName,
          sizeName: meta.sizeOptionName,
          categoryPath: meta.categoryPath,
          variants: variantsByVariation.get(line.variationId) ?? [],
          qtyByVariant: {},
        }
        draftByVariation.set(line.variationId, draft)
      }
      draft.qtyByVariant[line.warehouseVariantId] = line.qtyRecommended
    }

    const nextFamilies = [...draftByVariation.values()]
    setFamilies(nextFamilies)
    setSuggestNotes(result.notes)
    // Close the picker automatically on success — the user is now looking
    // at the result and can start editing.
    setSuggestOpen(false)
    // Collapse everything so the operator can scan the list; they can
    // expand individual families to tweak per-colour qty.
    setOpenId(null)
  }

  async function runSuggestion() {
    if (!locationId) return
    setSuggestBusy(true)
    setError(null)
    try {
      const result = await generateSuggestion({
        locationId,
        targetMode: suggestMode,
        ...(suggestMode === 'GROW_PCT' ? { growthPct: suggestGrowthPct } : {}),
        ...(suggestMode === 'CUSTOM_UNITS' ? { targetUnits: suggestTargetUnits } : {}),
        ...(suggestWindowStart ? { lastYearStart: new Date(`${suggestWindowStart}T00:00:00Z`) } : {}),
        ...(suggestWindowEnd ? { lastYearEnd: new Date(`${suggestWindowEnd}T23:59:59Z`) } : {}),
      })
      hydrateFromSuggestion(result)
      if (result.lines.length === 0) {
        toast.info(result.notes[0] ?? 'No lines suggested for this market.')
      } else {
        toast.success(
          `Suggested ${result.totals.totalRecommendedUnits} units across ${result.totals.variationsCovered} styles — edit below and submit when ready.`,
        )
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not generate the packing list.'
      setError(msg)
      toast.error(msg)
    } finally {
      setSuggestBusy(false)
    }
  }

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

      {/* Packing-list suggestion (CEO ask, 2026-09-01). Owner only — the
          suggestion pulls on cross-market data (warehouse stock, competing
          demand, per-market colour mix) and drives allocation decisions
          across the whole network. Market Managers still see the manual
          search below and can request for their own market by hand. */}

      {/**
           * 
           * 
           * TODO: Suggest a packing list
           * 
           * 
           */}
      {/* {user?.role === 'OWNER' && (
        <div className="suggest-panel">
          <div className="suggest-panel-header">
            <span className="suggest-panel-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
              </svg>
            </span>
            <div className="suggest-panel-body">
              <h2 className="suggest-panel-title">Suggest a packing list</h2>
              <p className="suggest-panel-sub">
                Uses last season&rsquo;s sales at this market, current warehouse stock, and open requests from other markets.
              </p>
            </div>
            {!suggestOpen && (
              <button
                className="btn btn-primary"
                onClick={() => setSuggestOpen(true)}
                disabled={!locationId}
                style={{ width: 'auto', paddingLeft: 20, paddingRight: 20 }}
                type="button"
              >
                Generate
              </button>
            )}
          </div>

          {suggestOpen && (
            <div className="stack" style={{ marginTop: 16, gap: 14 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Target</label>
                <div className="segmented" role="tablist" aria-label="Target mode">
                  {(
                    [
                      {
                        id: 'MATCH_LAST_YEAR',
                        label: 'Match last season',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 17l6-6 4 4 6-8" />
                            <path d="M14 7h6v6" />
                          </svg>
                        ),
                      },
                      {
                        id: 'GROW_PCT',
                        label: 'Grow by %',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 20l8-14 4 8 4-4" />
                            <path d="M14 6h6v6" />
                          </svg>
                        ),
                      },
                      {
                        id: 'CUSTOM_UNITS',
                        label: 'Custom units',
                        icon: (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="8" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        ),
                      },
                    ] as Array<{ id: SuggestionTargetMode; label: string; icon: JSX.Element }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      className={`segmented-btn${suggestMode === opt.id ? ' active' : ''}`}
                      onClick={() => setSuggestMode(opt.id)}
                      type="button"
                      role="tab"
                      aria-selected={suggestMode === opt.id}
                    >
                      {opt.icon}
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {suggestMode === 'GROW_PCT' && (
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="growthPct">Growth (%)</label>
                  <input
                    id="growthPct"
                    type="number"
                    step={1}
                    min={-100}
                    max={500}
                    value={suggestGrowthPct}
                    onChange={(e) => setSuggestGrowthPct(Number(e.target.value))}
                  />
                  <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                    Positive grows the target above last season, negative shrinks it.
                  </p>
                </div>
              )}

              {suggestMode === 'CUSTOM_UNITS' && (
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="targetUnits">Total units to send</label>
                  <input
                    id="targetUnits"
                    type="number"
                    step={1}
                    min={1}
                    value={suggestTargetUnits}
                    onChange={(e) => setSuggestTargetUnits(Number(e.target.value))}
                  />
                  <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                    Split across styles in proportion to last season&rsquo;s mix at this market.
                  </p>
                </div>
              )}

              <div className="field" style={{ margin: 0 }}>
                <label>Sales window <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span></label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="date"
                    value={suggestWindowStart}
                    onChange={(e) => setSuggestWindowStart(e.target.value)}
                    aria-label="Window start"
                    style={{ flex: 1, minWidth: 140 }}
                  />
                  <input
                    type="date"
                    value={suggestWindowEnd}
                    onChange={(e) => setSuggestWindowEnd(e.target.value)}
                    aria-label="Window end"
                    style={{ flex: 1, minWidth: 140 }}
                  />
                </div>
                <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                  Leave blank to use last season&rsquo;s window (or the trailing 12 months a year ago).
                </p>
              </div>

              <div className="suggest-panel-actions">
                <button
                  className="btn"
                  onClick={() => setSuggestOpen(false)}
                  disabled={suggestBusy}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={runSuggestion}
                  disabled={suggestBusy || !locationId}
                  style={{ width: 'auto', paddingLeft: 24, paddingRight: 24 }}
                  type="button"
                >
                  {suggestBusy ? 'Generating…' : 'Generate list'}
                </button>
              </div>
            </div>
          )}

          {suggestNotes.length > 0 && (
            <div className="suggest-panel-notes">
              {suggestNotes.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
          )}
        </div>
      )} */}

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
