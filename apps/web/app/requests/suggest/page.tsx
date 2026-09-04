'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  DEFAULT_MIN_PACK_QTY,
  DEFAULT_ROUND_TO_NEAREST,
  defaultShelfBufferPct,
} from '@winterborn/shared'
import type {
  CategoryDto,
  GenerateSuggestionResult,
  LocationDto,
  SuggestionConfidence,
  SuggestionConstraint,
  SuggestionExplain,
  SuggestionLine,
  SuggestionStep,
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

/// Everything the engine said about one specific colour, kept alongside the
/// editable quantity so the row can explain itself without another request.
interface VariantMeta {
  rationale: string
  confidence: SuggestionConfidence
  confidenceReason: string
  bindingConstraint: SuggestionConstraint
  /// What the market wanted before warehouse limits. Shown next to the
  /// recommendation so a suppressed number reads as suppressed rather than
  /// just small.
  demandTarget: number
  steps: SuggestionStep[]
}

/// One family in the hydrated suggestion. Mirrors the DraftFamily shape
/// used on /requests/new so the same visual pattern applies here.
interface SuggestFamily {
  variationId: string
  itemGroupName: string
  familyName: string
  sizeName: string
  categoryPath: string[]
  /// Ordered ONCE at hydration: the colours the engine actually suggested
  /// come first (in its own ranking), then everything else alphabetically.
  /// Deliberately frozen, because editing a quantity must not make rows jump
  /// around under the operator's cursor mid-edit.
  variants: WarehouseVariantSummary[]
  qtyByVariant: Record<string, number>
  /// Engine's original recommendation, kept immutable so clicking
  /// "Recommended: N" can always reset the stepper to the right value
  /// even after the user has edited the qty.
  recommendedQtyByVariant: Record<string, number>
  metaByVariant: Record<string, VariantMeta>
  /// Family-level total sold at this market last season. Drives the sort
  /// order, so highest-demand products lead, matching the backend's own
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

  // Pack shape. `shelfBufferPct` starts null meaning "use the default for
  // this mode". The moment the operator touches it, their number sticks
  // across mode changes.
  const [shelfBufferPct, setShelfBufferPct] = useState<number | null>(null)
  const [roundToNearest, setRoundToNearest] = useState<number>(DEFAULT_ROUND_TO_NEAREST)
  const [minPackQty, setMinPackQty] = useState<number>(DEFAULT_MIN_PACK_QTY)
  const [packShapeOpen, setPackShapeOpen] = useState(false)
  const effectiveShelfBuffer = shelfBufferPct ?? defaultShelfBufferPct(mode)

  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<null | 'DRAFT' | 'OPEN'>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [explain, setExplain] = useState<SuggestionExplain | null>(null)
  const [explainOpen, setExplainOpen] = useState(true)
  const [families, setFamilies] = useState<SuggestFamily[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [mathOpen, setMathOpen] = useState<Set<string>>(() => new Set())
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
  // Raw warehouse on-hand, matching the effect below. Note this is not
  // reservation-adjusted: boxes already being packed for other requests
  // still count here, so the Wh chip can read higher than Pack will accept.
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
  /// a top-level category (Scarves, Footwear, Sweaters, and so on) sits ONE
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

  function toggleMath(variantId: string) {
    setMathOpen((prev) => {
      const next = new Set(prev)
      if (next.has(variantId)) next.delete(variantId)
      else next.add(variantId)
      return next
    })
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
        shelfBufferPct: effectiveShelfBuffer,
        roundToNearest,
        minPackQty,
      })
      setNotes(result.notes)
      setExplain(result.explain)
      setExplainOpen(true)
      setTotals(result.totals)
      setFamilies(hydrateFamilies(result.lines, variationById, variantsByVariation))
      setOpenId(null)
      setMathOpen(new Set())
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

  // A run with no local sales grades evidence rather than measurement, which
  // changes how every badge below is worded.
  const runIsEstimate =
    explain?.demandSource === 'CROSS_MARKET' ||
    explain?.demandSource === 'CROSS_MARKET_WIDENED' ||
    explain?.demandSource === 'WAREHOUSE_STOCK'

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
          ? `Request submitted (${totalUnits} units). Warehouse will start packing.`
          : `Draft saved (${totalUnits} units). Edit it later before submitting.`,
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
        description="Build a starting packing list for a market from what it sells, what the warehouse holds, and what other markets have already asked for. Every number comes with its own working, so you can expand any item to see how it was reached and change anything you disagree with."
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
        <p style={{ margin: '6px 0 0', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
          {MODE_BLURB[mode]}
        </p>
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
            This is a sell-through goal, not a shipping value. The dollars are split across styles by their share of
            revenue (units × price), converted back into units at each style&rsquo;s own price, and then the shelf
            buffer below is added on top so the booth is not bare by the time the goal is met.
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
          Leave blank to use last season&rsquo;s window. If the dates you pick contain no sales, the search widens
          automatically to all the history we hold rather than coming back empty, and the panel below will say so.
        </p>
      </div>

      <div className="field">
        <button
          type="button"
          className="disclosure-toggle"
          aria-expanded={packShapeOpen}
          onClick={() => setPackShapeOpen((v) => !v)}
        >
          <Chevron open={packShapeOpen} />
          Pack shape
          <span className="disclosure-summary">
            round to {roundToNearest} · min {minPackQty} · buffer {effectiveShelfBuffer}%
          </span>
        </button>
        {packShapeOpen && (
          <div className="pack-shape-grid">
            <div>
              <label htmlFor="shelfBufferPct">Shelf buffer (%)</label>
              <input
                id="shelfBufferPct"
                type="number"
                step={5}
                min={0}
                max={200}
                value={effectiveShelfBuffer}
                onChange={(e) => setShelfBufferPct(Number(e.target.value))}
              />
              <p className="field-hint">
                Ships more than the goal so the shelf is not bare the moment the goal is met. At 20%, a $25,000
                sales goal sends $30,000 of stock. Default for this target is {defaultShelfBufferPct(mode)}%.
              </p>
            </div>
            <div>
              <label htmlFor="roundToNearest">Round to nearest</label>
              <input
                id="roundToNearest"
                type="number"
                step={1}
                min={1}
                max={50}
                value={roundToNearest}
                onChange={(e) => setRoundToNearest(Math.max(1, Number(e.target.value)))}
              />
              <p className="field-hint">Quantities land on a multiple of this. Nobody packs 21 of something.</p>
            </div>
            <div>
              <label htmlFor="minPackQty">Minimum per item</label>
              <input
                id="minPackQty"
                type="number"
                step={1}
                min={1}
                max={100}
                value={minPackQty}
                onChange={(e) => setMinPackQty(Math.max(1, Number(e.target.value)))}
              />
              <p className="field-hint">
                Items that cannot reach this are dropped rather than sent as a token one or two.
              </p>
            </div>
          </div>
        )}
      </div>

      <button
        className="btn btn-primary"
        onClick={runGenerate}
        disabled={busy || !locationId}
        style={{ width: '100%', marginTop: 8 }}
      >
        {busy ? 'Generating…' : 'Generate packing list'}
      </button>

      {explain && (
        <ExplainPanel
          explain={explain}
          notes={notes}
          open={explainOpen}
          onToggle={() => setExplainOpen((v) => !v)}
        />
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
              const suggestedCount = Object.keys(f.metaByVariant).length
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
                        <div className="list-row-meta" style={{ color: 'var(--text-faint)' }}>
                          {suggestedCount} of {f.variants.length} colour{f.variants.length === 1 ? '' : 's'} suggested
                          {f.familyLastYearSold > 0 ? ` · ${f.familyLastYearSold} sold in the window` : ''}
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
                      <Chevron open={open} />
                    </div>
                  </div>

                  {open && (
                    <div className="stack" style={{ marginTop: 14, gap: 8 }}>
                      {f.variants.length === 0 ? (
                        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                          No specific variants for this family, so the request goes at family level.
                        </p>
                      ) : (
                        f.variants.map((v) => {
                          const qty = f.qtyByVariant[v.id] ?? 0
                          const recommended = f.recommendedQtyByVariant[v.id]
                          const onHand = onHandByVariantId.get(v.id) ?? 0
                          const onHandWh = onHandByVariantAtWarehouse.get(v.id) ?? 0
                          const meta = f.metaByVariant[v.id]
                          const showMath = mathOpen.has(v.id)
                          return (
                            <div
                              key={v.id}
                              className={`list-row suggest-variant${meta ? '' : ' is-unsuggested'}`}
                              style={{ border: '1px solid var(--line)', alignItems: 'flex-start' }}
                            >
                              <ProductThumb
                                photoUrl={v.photoUrl}
                                familyName={v.colourVariantName}
                                alt={v.colourVariantName}
                              />
                              <div className="list-row-body">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <span className="list-row-title">{v.colourVariantName}</span>
                                  {meta ? (
                                    <>
                                      <ConfidenceBadge
                                        level={meta.confidence}
                                        reason={meta.confidenceReason}
                                        isEstimate={runIsEstimate}
                                      />
                                      <ConstraintBadge constraint={meta.bindingConstraint} />
                                    </>
                                  ) : (
                                    <span
                                      className="chip"
                                      style={{ fontSize: '0.7rem' }}
                                      title="Not suggested: it either did not sell here, or the warehouse cannot fill a full pack of it. You can still add it by hand."
                                    >
                                      {qty > 0 ? 'Added by you' : 'Not suggested'}
                                    </span>
                                  )}
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
                                      title="You can still request this. Packing will start when warehouse stock arrives."
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
                                      className={`chip${qty !== recommended ? ' chip-signal' : ''}`}
                                      style={{ cursor: qty !== recommended ? 'pointer' : 'default', fontSize: '0.75rem' }}
                                      onClick={() => qty !== recommended && setVariantQty(f.variationId, v.id, recommended)}
                                      title={
                                        qty === recommended
                                          ? `Send ${recommended}, the warehouse-safe amount after accounting for other markets`
                                          : `Click to go back to the suggested ${recommended}.`
                                      }
                                    >
                                      Suggested: {recommended}
                                    </button>
                                    {meta && meta.demandTarget > recommended && (
                                      <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                                        this market could take {meta.demandTarget}, but the warehouse is the limit
                                      </span>
                                    )}
                                    {qty > recommended && (
                                      <span style={{ fontSize: '0.75rem', color: 'var(--signal)' }}>
                                        {qty - recommended} above the warehouse-safe amount
                                      </span>
                                    )}
                                  </div>
                                )}
                                {meta && (
                                  <>
                                    <div style={{ marginTop: 4, fontSize: '0.78rem', color: 'var(--text-dim)', lineHeight: 1.4 }}>
                                      {meta.rationale}
                                    </div>
                                    <button
                                      type="button"
                                      className="disclosure-toggle is-inline"
                                      aria-expanded={showMath}
                                      onClick={() => toggleMath(v.id)}
                                    >
                                      <Chevron open={showMath} />
                                      {showMath ? 'Hide details' : 'Show details'}
                                    </button>
                                    {showMath && (
                                      <ol className="math-steps">
                                        {meta.steps.map((s, i) => (
                                          <li key={i}>
                                            <span className="math-step-label">{s.label}</span>
                                            <span className="math-step-detail">{s.detail}</span>
                                          </li>
                                        ))}
                                        <li>
                                          <span className="math-step-label">
                                            {runIsEstimate ? 'Evidence' : 'Confidence'}
                                          </span>
                                          <span className="math-step-detail">
                                            {meta.confidenceReason}{' '}
                                            {runIsEstimate
                                              ? 'It grades the evidence, so it stays the same if you change the quantity yourself.'
                                              : 'It rates the data behind the number, so it stays the same if you change the quantity yourself.'}
                                          </span>
                                        </li>
                                      </ol>
                                    )}
                                  </>
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

const MODE_BLURB: Record<SuggestionTargetMode, string> = {
  MATCH_LAST_YEAR: 'Ship what this market sold in the window, colour for colour.',
  GROW_PCT: 'Take what it sold and move it up or down by a percentage.',
  CUSTOM_UNITS: 'You name a total number of units; it is divided between products by how well each one sells.',
  CUSTOM_REVENUE:
    'You name a sales goal in dollars; it is divided by each product’s share of revenue and converted back into units at that product’s own price.',
  INITIAL_SHIPMENT: 'Send a share of everything sitting in the warehouse, the way you open a season.',
}

const CONSTRAINT_LABEL: Record<SuggestionConstraint, { label: string; title: string }> = {
  DEMAND: { label: 'Demand-led', title: 'The number comes straight from what this market sells. Nothing held it back.' },
  BUDGET: { label: 'Your target', title: 'The number is this item’s slice of the target you set.' },
  WAREHOUSE_STOCK: { label: 'Stock-limited', title: 'The market wants more, but this is all the warehouse physically has.' },
  FAIR_SHARE: { label: 'Shared out', title: 'Held back so other markets that also sell this item are not left with nothing.' },
  OTHER_REQUESTS: { label: 'Already claimed', title: 'Other markets have open or draft requests for this item, and those come off the top.' },
  PACK_ROUNDING: { label: 'Rounded', title: 'Rounded to a clean pack size.' },
  MIN_PACK: { label: 'Minimum pack', title: 'Raised to the smallest quantity worth packing.' },
}

const SOURCE_LABEL: Record<SuggestionExplain['demandSource'], string> = {
  LOCAL_SALES: 'This market’s own sales',
  LOCAL_SALES_WIDENED: 'This market’s sales, wider window',
  CROSS_MARKET: 'Estimated from other markets',
  CROSS_MARKET_WIDENED: 'Estimated from other markets, wider window',
  WAREHOUSE_STOCK: 'Warehouse stock only',
}

/// The "why does the list look like this" panel.
///
/// Everything is visible at once when the panel is open. The mechanism used
/// to be invisible, which made a correct list look arbitrary, so burying it
/// behind a second toggle would undo the point. The trimming happened in the
/// wording instead. The one thing that does collapse is the source-market
/// list, which can run to dozens of names.
function ExplainPanel({
  explain,
  notes,
  open,
  onToggle,
}: {
  explain: SuggestionExplain
  notes: string[]
  open: boolean
  onToggle: () => void
}) {
  const [allMarkets, setAllMarkets] = useState(false)
  const isEstimate =
    explain.demandSource === 'CROSS_MARKET' ||
    explain.demandSource === 'CROSS_MARKET_WIDENED' ||
    explain.demandSource === 'WAREHOUSE_STOCK'
  const MARKET_PREVIEW = 6
  const shownMarkets = allMarkets ? explain.sourceMarkets : explain.sourceMarkets.slice(0, MARKET_PREVIEW)
  const hiddenMarkets = explain.sourceMarkets.length - shownMarkets.length

  return (
    <section className={`explain-panel${isEstimate ? ' is-estimate' : ''}`}>
      <button type="button" className="explain-head" aria-expanded={open} onClick={onToggle}>
        <Chevron open={open} />
        <span className="explain-head-text">
          <span className="explain-headline">{explain.headline}</span>
          <span className="explain-source">
            {SOURCE_LABEL[explain.demandSource]}
            {explain.windowWidened ? ' · window widened' : ''}
          </span>
        </span>
      </button>

      {open && (
        <div className="explain-body">
          <dl className="explain-facts">
            <div>
              <dt>Data</dt>
              <dd>{SOURCE_LABEL[explain.demandSource]}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>
                {fmtDate(explain.windowUsed.start)} to {fmtDate(explain.windowUsed.end)}
                {explain.windowWidened && <span className="explain-muted"> (your dates held no sales)</span>}
              </dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>
                {explain.budget ? (
                  <>
                    <div>{explain.budget.targetDisplay}</div>
                    <div className="explain-muted">→ {explain.budget.sendTargetDisplay}</div>
                    <div>→ {explain.budget.allocatedDisplay} allocated</div>
                    {explain.budget.shortfall && (
                      <div className="explain-muted">{explain.budget.shortfall}</div>
                    )}
                  </>
                ) : (
                  explain.targetSummary
                )}
              </dd>
            </div>
            <div>
              <dt>Pack shape</dt>
              <dd>
                nearest {explain.settings.roundToNearest}, min {explain.settings.minPackQty}, buffer{' '}
                {explain.settings.shelfBufferPct}%
                {explain.droppedBelowMinimum > 0 && (
                  <span className="explain-muted">
                    {' '}
                    ({explain.droppedBelowMinimum} item{explain.droppedBelowMinimum === 1 ? '' : 's'} dropped as too
                    small to pack)
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {explain.sourceMarkets.length > 0 && (
            <>
              <h3>
                Markets this estimate came from ({explain.sourceMarkets.length})
              </h3>
              <div className="explain-markets">
                {shownMarkets.map((m) => (
                  <span key={m.locationId} className="chip">
                    {m.name} · {m.unitsSold.toLocaleString('en-US')}
                  </span>
                ))}
                {(hiddenMarkets > 0 || allMarkets) && (
                  <button type="button" className="explain-more" onClick={() => setAllMarkets((v) => !v)}>
                    {allMarkets ? 'View less' : `View all ${explain.sourceMarkets.length}`}
                  </button>
                )}
              </div>
            </>
          )}

          <h3>How this list was built</h3>
          <ol className="explain-steps">
            {explain.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>

          {notes.length > 0 && (
            <div className="suggest-panel-notes">
              {notes.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d)
  return date.toISOString().slice(0, 10)
}

/// Group flat suggestion lines by variationId into the family-shaped
/// structure the /requests/new UI pattern consumes. Skips lines whose
/// referenced variation or variant we can't find locally, since the engine
/// might refer to something the frontend doesn't have loaded (rare, but
/// e.g. between generation and hydration a product could be edited).
function hydrateFamilies(
  wireLines: SuggestionLine[],
  variationById: Map<string, VariationSummary>,
  variantsByVariation: Map<string, WarehouseVariantSummary[]>,
): SuggestFamily[] {
  const familyByVariation = new Map<string, SuggestFamily>()
  // Rank of each suggested colour in the engine's own ordering, so the
  // colours it actually recommended float to the top of the expanded list.
  const suggestedRank = new Map<string, number>()

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
    if (!suggestedRank.has(line.warehouseVariantId)) suggestedRank.set(line.warehouseVariantId, suggestedRank.size)
    // Start the editable quantity at what the market actually wants, as long
    // as the warehouse physically has it. If this colour sold 302 last season
    // and there are 1,504 sitting in the warehouse, 302 is the number to
    // default to, even though fair share reserves most of that stock for
    // other markets and the suggestion is therefore lower. The "Suggested"
    // chip still shows the warehouse-safe figure, one click away.
    fam.qtyByVariant[line.warehouseVariantId] = Math.max(
      line.qtyRecommended,
      Math.min(line.demandTarget, line.warehouseOnHand),
    )
    fam.recommendedQtyByVariant[line.warehouseVariantId] = line.qtyRecommended
    fam.metaByVariant[line.warehouseVariantId] = {
      rationale: line.rationale,
      confidence: line.confidence,
      confidenceReason: line.confidenceReason,
      bindingConstraint: line.bindingConstraint,
      demandTarget: line.demandTarget,
      steps: line.steps,
    }
  }

  // Order the colours inside each family ONCE, here: suggested colours in
  // the engine's ranking first, then the rest alphabetically. Doing it at
  // hydration rather than at render is deliberate: the operator asked for
  // the relevant items up top on first view, and for rows to stay put once
  // they start changing numbers.
  for (const fam of familyByVariation.values()) {
    fam.variants = [...fam.variants].sort((a, b) => {
      const ra = suggestedRank.get(a.id)
      const rb = suggestedRank.get(b.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return a.colourVariantName.localeCompare(b.colourVariantName)
    })
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

function Chevron({ open }: { open: boolean }) {
  return (
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
        flexShrink: 0,
        transition: 'transform 0.15s ease',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

/// The badge reads differently depending on what the grade is actually
/// grading. With local sales it is confidence in a measurement. On a new
/// market there is nothing to measure, so the grade is an evaluation of how
/// well the other markets evidence this product, and "high confidence" would
/// wrongly read as a promise that it will sell. Same grade, honest wording.
function ConfidenceBadge({
  level,
  reason,
  isEstimate,
}: {
  level: SuggestionConfidence
  reason: string
  isEstimate: boolean
}) {
  const label = isEstimate
    ? level === 'HIGH'
      ? 'Strong evidence'
      : level === 'MEDIUM'
        ? 'Fair evidence'
        : 'Thin evidence'
    : level === 'HIGH'
      ? 'High confidence'
      : level === 'MEDIUM'
        ? 'Medium confidence'
        : 'Low confidence'
  const cls = level === 'HIGH' ? 'chip chip-pine' : level === 'MEDIUM' ? 'chip chip-signal' : 'chip chip-rust'
  const tail = isEstimate
    ? ' It grades how well other markets evidence this product, not how much you choose to send.'
    : ' It rates the data behind the number, not the quantity you choose.'
  return (
    <span className={cls} style={{ fontSize: '0.7rem' }} title={reason + tail}>
      {label}
    </span>
  )
}

function ConstraintBadge({ constraint }: { constraint: SuggestionConstraint }) {
  const { label, title } = CONSTRAINT_LABEL[constraint]
  return (
    <span className="chip" style={{ fontSize: '0.7rem' }} title={title}>
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
