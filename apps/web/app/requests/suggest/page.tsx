'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  CategoryDto,
  GenerateSuggestionResult,
  LocationDto,
  SuggestionConfidence,
  SuggestionLine,
  SuggestionTargetMode,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { CopyButton } from '../../../components/CopyButton'
import { PageHeader } from '../../../components/PageHeader'
import { ProductThumb, firstPhoto } from '../../../components/ProductThumb'
import { RequireAuth } from '../../../components/RequireAuth'
import { SearchableSelect } from '../../../components/SearchableSelect'
import {
  ApiError,
  createRequest,
  generateSuggestion,
  listCategories,
  listLocations,
  listVariations,
  listWarehouseVariants,
  stockByVariant,
} from '../../../lib/api'
import { useToast } from '../../../lib/toast'

/// One family in the hydrated suggestion — mirrors the DraftFamily shape
/// used on /requests/new so the same visual pattern applies here. Adds
/// `metaByVariant` to carry the rationale + confidence the engine returned
/// for each specific colour, surfaced when the family expands.
interface SuggestFamily {
  variationId: string
  itemGroupName: string
  familyName: string
  sizeName: string
  categoryPath: string[]
  variants: WarehouseVariantSummary[]
  qtyByVariant: Record<string, number>
  /// Engine's original recommendation, kept immutable so clicking
  /// "Recommended: N" can always reset the stepper to the right value
  /// even after the user has edited the qty.
  recommendedQtyByVariant: Record<string, number>
  metaByVariant: Record<string, { rationale: string; confidence: SuggestionConfidence }>
  /// Family-level total sold at this market last season. Drives the sort
  /// order — highest-demand products lead, matching the backend's own
  /// ordering. Same value across every line in the family, so we just
  /// capture whichever line lands here first.
  familyLastYearSold: number
}

function SuggestBody() {
  const router = useRouter()
  const toast = useToast()

  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [allVariants, setAllVariants] = useState<WarehouseVariantSummary[]>([])
  const [categories, setCategories] = useState<CategoryDto[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [locationId, setLocationId] = useState<string>('')
  const [pickedCategoryIds, setPickedCategoryIds] = useState<string[]>([])
  const [mode, setMode] = useState<SuggestionTargetMode>('MATCH_LAST_YEAR')
  const [growthPct, setGrowthPct] = useState<number>(10)
  const [targetUnits, setTargetUnits] = useState<number>(500)
  const [targetRevenueDollars, setTargetRevenueDollars] = useState<number>(50000)
  const [initialShipmentPct, setInitialShipmentPct] = useState<number>(85)
  const [windowStart, setWindowStart] = useState<string>('')
  const [windowEnd, setWindowEnd] = useState<string>('')

  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<null | 'DRAFT' | 'OPEN'>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [families, setFamilies] = useState<SuggestFamily[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [totals, setTotals] = useState<{
    variationsCovered: number
    totalRecommendedUnits: number
    totalLastYearUnits: number
  } | null>(null)

  // Stock at the market + at the warehouse, mirroring /requests/new so the
  // family + variant rows can display the same MKT / WH chips the manual
  // page uses. Refetched per market change and once after a successful
  // generate so numbers are always current at the moment the operator
  // reviews the draft.
  const [onHandByVariantId, setOnHandByVariantId] = useState<Map<string, number>>(() => new Map())
  const [onHandByVariantAtWarehouse, setOnHandByVariantAtWarehouse] = useState<Map<string, number>>(
    () => new Map(),
  )

  useEffect(() => {
    Promise.all([listLocations(), listVariations(), listWarehouseVariants(), listCategories()])
      .then(([l, v, wv, c]) => {
        setLocations(l)
        setVariations(v)
        setAllVariants(wv)
        setCategories(c)
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load catalog.'))
  }, [])

  const markets = useMemo(() => locations.filter((l) => l.kind === 'MARKET'), [locations])
  const warehouseId = useMemo(() => locations.find((l) => l.kind === 'WAREHOUSE')?.id ?? null, [locations])

  /// Effective root list for the picker.
  ///
  /// In our catalog, the real top-of-tree is a single meta-root
  /// ("BärHaus (IN STOCK)") and everything the CEO actually thinks of as
  /// a top-level category — Scarves, Footwear, Sweaters, etc. — sits ONE
  /// LEVEL below. If we naively showed roots-only, the picker collapses
  /// to a single item and stops being useful. Skip a lone meta-root and
  /// promote its direct children to "effective roots" so the picker
  /// matches the operator's mental model.
  const pickableCategories = useMemo(() => {
    const roots = categories.filter((c) => c.parentId === null)
    if (roots.length === 1) {
      const soleRoot = roots[0]!
      return categories.filter((c) => c.parentId === soleRoot.id)
    }
    return roots
  }, [categories])

  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations])
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

  useEffect(() => {
    if (!locationId && markets.length > 0) setLocationId(markets[0]!.id)
  }, [markets, locationId])

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
      m.set(variationId, list.reduce((sum, wv) => sum + (onHandByVariantAtWarehouse.get(wv.id) ?? 0), 0))
    }
    return m
  }, [variantsByVariation, onHandByVariantAtWarehouse])

  const toggleCategory = (id: string) => {
    setPickedCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function runGenerate() {
    if (!locationId) return
    setBusy(true)
    setLoadError(null)
    try {
      const result: GenerateSuggestionResult = await generateSuggestion({
        locationId,
        targetMode: mode,
        ...(mode === 'GROW_PCT' ? { growthPct } : {}),
        ...(mode === 'CUSTOM_UNITS' ? { targetUnits } : {}),
        ...(mode === 'CUSTOM_REVENUE' ? { targetRevenueDollars } : {}),
        ...(mode === 'INITIAL_SHIPMENT' ? { initialShipmentPct } : {}),
        ...(pickedCategoryIds.length > 0 ? { categoryIds: pickedCategoryIds } : {}),
        ...(windowStart ? { lastYearStart: new Date(`${windowStart}T00:00:00Z`) } : {}),
        ...(windowEnd ? { lastYearEnd: new Date(`${windowEnd}T23:59:59Z`) } : {}),
      })
      setNotes(result.notes)
      setTotals(result.totals)
      setFamilies(hydrateFamilies(result.lines, variationById, variantsByVariation, mode, growthPct))
      setOpenId(null)
      if (result.lines.length === 0) {
        toast.info(result.notes[0] ?? 'No lines suggested for this market.')
      } else {
        toast.success(
          `Suggested ${result.totals.totalRecommendedUnits} units across ${result.totals.variationsCovered} styles.`,
        )
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not generate the packing list.'
      setLoadError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
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
    () => families.reduce((sum, f) => sum + Object.values(f.qtyByVariant).reduce((s, n) => s + n, 0), 0),
    [families],
  )
  const lineCount = useMemo(
    () => families.reduce((sum, f) => sum + Object.keys(f.qtyByVariant).length, 0),
    [families],
  )

  async function submit(target: 'DRAFT' | 'OPEN') {
    if (!locationId || lineCount === 0) return
    setSaving(target)
    setLoadError(null)
    try {
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
        initialState: target,
        lines,
      })
      toast.success(
        target === 'OPEN'
          ? `Request submitted (${totalUnits} units) — warehouse will start packing.`
          : `Draft saved (${totalUnits} units) — edit later before submitting.`,
      )
      router.replace(`/requests/${created.id}`)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not create the request.'
      setLoadError(msg)
      toast.error(msg)
      setSaving(null)
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Owner only"
        title="Suggest a packing list"
        description="Generate a starting packing list for a market from last season's sales, current warehouse stock, and open requests from other markets. Edit anything, then save as draft or approve to submit the request straight to the warehouse."
      />

      {loadError && <p className="error-banner">{loadError}</p>}

      <div className="field">
        <label>Market</label>
        <SearchableSelect
          value={locationId || null}
          options={markets.map((m) => ({ id: m.id, label: m.name }))}
          onChange={(id) => id && setLocationId(id)}
          showId={false}
          allowClear={false}
        />
      </div>

      <div className="field">
        <label>
          Categories <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span>
        </label>
        {pickableCategories.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading…</p>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {pickableCategories.map((c) => {
              const active = pickedCategoryIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`segmented-btn${active ? ' active' : ''}`}
                  style={{ flex: '0 0 auto', padding: '6px 14px', minHeight: 34, borderRadius: 999 }}
                  onClick={() => toggleCategory(c.id)}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        )}
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
          Empty = every category. Pick one or more to restrict the suggestion to those product groups (the tree is walked down to include everything nested underneath).
        </p>
      </div>

      <div className="field">
        <label>Target</label>
        <div className="segmented" role="tablist" aria-label="Target mode" style={{ flexWrap: 'wrap' }}>
          {(
            [
              { id: 'MATCH_LAST_YEAR', label: 'Match last season' },
              { id: 'GROW_PCT', label: 'Grow by %' },
              { id: 'CUSTOM_UNITS', label: 'Custom units' },
              { id: 'CUSTOM_REVENUE', label: 'Custom revenue' },
              { id: 'INITIAL_SHIPMENT', label: 'Initial shipment' },
            ] as Array<{ id: SuggestionTargetMode; label: string }>
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={mode === opt.id}
              className={`segmented-btn${mode === opt.id ? ' active' : ''}`}
              onClick={() => setMode(opt.id)}
              style={{ flex: '1 0 30%' }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'GROW_PCT' && (
        <div className="field">
          <label htmlFor="growthPct">Growth (%)</label>
          <input
            id="growthPct"
            type="number"
            step={1}
            min={-100}
            max={500}
            value={growthPct}
            onChange={(e) => setGrowthPct(Number(e.target.value))}
          />
          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            Positive grows the target above last season, negative shrinks it. Capped at ±3× last season for safety.
          </p>
        </div>
      )}

      {mode === 'CUSTOM_UNITS' && (
        <div className="field">
          <label htmlFor="targetUnits">Total units to send</label>
          <input
            id="targetUnits"
            type="number"
            step={1}
            min={1}
            value={targetUnits}
            onChange={(e) => setTargetUnits(Number(e.target.value))}
          />
          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            Split across styles in proportion to last season&rsquo;s mix at this market.
          </p>
        </div>
      )}

      {mode === 'CUSTOM_REVENUE' && (
        <div className="field">
          <label htmlFor="targetRevenueDollars">Revenue target ($)</label>
          <input
            id="targetRevenueDollars"
            type="number"
            step={100}
            min={1}
            value={targetRevenueDollars}
            onChange={(e) => setTargetRevenueDollars(Number(e.target.value))}
          />
          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            Dollars split across styles in proportion to last season&rsquo;s revenue mix (units × unit price), then
            converted to units using each style&rsquo;s unit price from the catalog. Products with no unit price on
            their warehouse SKUs are excluded.
          </p>
        </div>
      )}

      {mode === 'INITIAL_SHIPMENT' && (
        <div className="field">
          <label htmlFor="initialShipmentPct">Share of warehouse stock (%)</label>
          <input
            id="initialShipmentPct"
            type="number"
            step={1}
            min={1}
            max={100}
            value={initialShipmentPct}
            onChange={(e) => setInitialShipmentPct(Number(e.target.value))}
          />
          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            Sizes the budget as this percentage of
            total warehouse stock for the selected categories, then splits by last season&rsquo;s mix at this market.
          </p>
        </div>
      )}

      <div className="field">
        <label>
          Sales window <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span>
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="date"
            value={windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
            aria-label="Window start"
            style={{ flex: 1, minWidth: 140 }}
          />
          <input
            type="date"
            value={windowEnd}
            onChange={(e) => setWindowEnd(e.target.value)}
            aria-label="Window end"
            style={{ flex: 1, minWidth: 140 }}
          />
        </div>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
          Leave blank to use last season&rsquo;s window (or the trailing 12 months a year ago).
        </p>
      </div>

      <button
        className="btn btn-primary"
        onClick={runGenerate}
        disabled={busy || !locationId}
        style={{ width: '100%', marginTop: 8 }}
      >
        {busy ? 'Generating…' : 'Generate packing list'}
      </button>

      {notes.length > 0 && (
        <div className="suggest-panel-notes" style={{ marginTop: 16 }}>
          {notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}

      {families.length > 0 && (
        <>
          <div className="section-heading" style={{ marginTop: 20 }}>
            <h2>Suggested lines</h2>
            <span className="eyebrow">
              {lineCount} line{lineCount === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
              {totals ? ` · covers ${totals.variationsCovered} style${totals.variationsCovered === 1 ? '' : 's'}` : ''}
            </span>
          </div>

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
                          <span
                            className="list-row-title"
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
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
                            <span className={`stock-cell-value${familyMarket === 0 ? ' is-zero' : ''}`}>
                              {familyMarket}
                            </span>
                            <span className="stock-cell-label">In market</span>
                          </div>
                          <div className="stock-cell is-warehouse" aria-label={`${familyWarehouse} on hand in warehouse`}>
                            <span className={`stock-cell-value${familyWarehouse === 0 ? ' is-zero' : ''}`}>
                              {familyWarehouse}
                            </span>
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
                          const recommended = f.recommendedQtyByVariant[v.id]
                          const onHand = onHandByVariantId.get(v.id) ?? 0
                          const onHandWh = onHandByVariantAtWarehouse.get(v.id) ?? 0
                          const meta = f.metaByVariant[v.id]
                          const isAtRecommended = recommended === undefined || qty === recommended
                          return (
                            <div key={v.id} className="list-row" style={{ border: '1px solid var(--line)', alignItems: 'flex-start' }}>
                              <ProductThumb
                                photoUrl={v.photoUrl}
                                familyName={v.colourVariantName}
                                alt={v.colourVariantName}
                              />
                              <div className="list-row-body">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <span className="list-row-title">{v.colourVariantName}</span>
                                  {meta && <ConfidenceBadge level={meta.confidence} />}
                                </div>
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
                                      title="You can still request this — packing will start when warehouse stock arrives."
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <circle cx="12" cy="12" r="9" />
                                        <polyline points="12 7 12 12 15 14" />
                                      </svg>
                                      Backorder
                                    </span>
                                  )}
                                </div>
                                {recommended !== undefined && (
                                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                    <button
                                      type="button"
                                      className={`chip${qty > recommended ? ' chip-signal' : ''}`}
                                      style={{ cursor: qty !== recommended ? 'pointer' : 'default', fontSize: '0.75rem' }}
                                      onClick={() => qty !== recommended && setVariantQty(f.variationId, v.id, recommended)}
                                      title={
                                        qty > recommended
                                          ? `Warehouse can safely send ${recommended}. Click to use this amount.`
                                          : qty < recommended
                                            ? `You've set this lower than the recommendation (${recommended}). Click to restore.`
                                            : `Send ${recommended} — warehouse-safe, accounting for other markets`
                                      }
                                    >
                                      Recommended: {recommended}
                                    </button>
                                    {qty > recommended && (
                                      <span style={{ fontSize: '0.75rem', color: 'var(--signal)' }}>
                                        sending {qty - recommended} above safe limit
                                      </span>
                                    )}
                                  </div>
                                )}
                                {meta && (
                                  <div style={{ marginTop: 4, fontSize: '0.78rem', color: 'var(--text-dim)', lineHeight: 1.4 }}>
                                    {meta.rationale}
                                  </div>
                                )}
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

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              className="btn"
              onClick={() => submit('DRAFT')}
              disabled={saving !== null || lineCount === 0}
              type="button"
            >
              {saving === 'DRAFT' ? 'Saving…' : 'Save as draft'}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => submit('OPEN')}
              disabled={saving !== null || lineCount === 0}
              style={{ width: 'auto', paddingLeft: 24, paddingRight: 24 }}
              type="button"
            >
              {saving === 'OPEN' ? 'Approving…' : `Approve → send ${totalUnits} unit${totalUnits === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/// Compute the uncapped demand target for a line — what the market
/// actually needs based on the chosen mode, before warehouse and
/// competing-demand caps are applied. The input field starts here;
/// the "Recommended" chip shows the capped (warehouse-safe) value.
function demandTargetForLine(
  line: SuggestionLine,
  mode: SuggestionTargetMode,
  growthPct: number,
): number {
  // Must match SANITY_MULTIPLIER in the backend service.
  const SANITY_MULTIPLIER = 3
  let demand: number
  if (mode === 'MATCH_LAST_YEAR' && line.lastYearSold > 0) {
    demand = line.lastYearSold
  } else if (mode === 'GROW_PCT' && line.lastYearSold > 0) {
    const raw = Math.round(line.lastYearSold * (1 + growthPct / 100))
    demand = Math.min(raw, Math.round(line.lastYearSold * SANITY_MULTIPLIER))
  } else {
    // Budget modes or cross-market inference: use recommended directly
    // (no meaningful uncapped demand to recover client-side).
    demand = line.qtyRecommended
  }
  // Hard cap: can never request more than the warehouse physically has.
  // When demand ≤ warehouseOnHand, input shows real demand so the
  // operator can see the "fair-share gap" vs the Recommended chip.
  // When demand > warehouseOnHand, cap to on-hand — requesting beyond
  // stock would just create an unfulfillable line.
  return Math.min(demand, line.warehouseOnHand)
}

/// Group flat suggestion lines by variationId into the family-shaped
/// structure the /requests/new UI pattern consumes. Skips lines whose
/// referenced variation or variant we can't find locally — the engine
/// might refer to something the frontend doesn't have loaded (rare, but
/// e.g. between generation and hydration a product could be edited).
function hydrateFamilies(
  wireLines: SuggestionLine[],
  variationById: Map<string, VariationSummary>,
  variantsByVariation: Map<string, WarehouseVariantSummary[]>,
  mode: SuggestionTargetMode,
  growthPct: number,
): SuggestFamily[] {
  const familyByVariation = new Map<string, SuggestFamily>()
  for (const line of wireLines) {
    if (!line.warehouseVariantId) continue
    const meta = variationById.get(line.variationId)
    if (!meta) continue
    const allVariantsForFamily = variantsByVariation.get(line.variationId) ?? []
    if (allVariantsForFamily.length === 0) continue

    let fam = familyByVariation.get(line.variationId)
    if (!fam) {
      fam = {
        variationId: line.variationId,
        itemGroupName: meta.itemGroupName,
        familyName: meta.colourFamilyName,
        sizeName: meta.sizeOptionName,
        categoryPath: meta.categoryPath,
        variants: allVariantsForFamily,
        qtyByVariant: {},
        recommendedQtyByVariant: {},
        metaByVariant: {},
        familyLastYearSold: line.familyLastYearSold,
      }
      familyByVariation.set(line.variationId, fam)
    }
    fam.qtyByVariant[line.warehouseVariantId] = demandTargetForLine(line, mode, growthPct)
    fam.recommendedQtyByVariant[line.warehouseVariantId] = line.qtyRecommended
    fam.metaByVariant[line.warehouseVariantId] = {
      rationale: line.rationale,
      confidence: line.confidence,
    }
  }
  // Sort families by REAL market demand (last season sales), not by
  // recommended qty. Matters most in Custom-revenue and Grow-% modes
  // where recommended qty can diverge from actual demand. Tie-breaker:
  // recommended qty desc, then variationId for determinism.
  const list = [...familyByVariation.values()]
  list.sort((a, b) => {
    if (b.familyLastYearSold !== a.familyLastYearSold) return b.familyLastYearSold - a.familyLastYearSold
    const totalDiff = totalOf(b) - totalOf(a)
    if (totalDiff !== 0) return totalDiff
    return a.variationId.localeCompare(b.variationId)
  })
  return list
}

function totalOf(f: SuggestFamily): number {
  let s = 0
  for (const q of Object.values(f.qtyByVariant)) s += q
  return s
}

function ConfidenceBadge({ level }: { level: SuggestionConfidence }) {
  const label = level === 'HIGH' ? 'High confidence' : level === 'MEDIUM' ? 'Medium confidence' : 'Low confidence'
  const cls = level === 'HIGH' ? 'chip chip-pine' : level === 'MEDIUM' ? 'chip chip-signal' : 'chip chip-rust'
  return (
    <span className={cls} style={{ fontSize: '0.7rem' }}>
      {label}
    </span>
  )
}

export default function SuggestRequestPage() {
  return (
    <RequireAuth roles={['OWNER']}>
      <SuggestBody />
    </RequireAuth>
  )
}
