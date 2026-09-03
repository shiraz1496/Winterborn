'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type {
  DecisionQueueRow,
  LocationDto,
  RestockRequestDto,
  SalesRow,
  StockLevel,
  StockStatus,
  ThresholdDto,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { classifyStock } from '@winterborn/shared'
import { CopyButton } from '../components/CopyButton'
import { InfoTooltip } from '../components/InfoTooltip'
import { PageHeader } from '../components/PageHeader'
import { ProductThumb, firstPhoto } from '../components/ProductThumb'
import { RequireAuth } from '../components/RequireAuth'
import { SearchableSelect } from '../components/SearchableSelect'
import { StatusLegend } from '../components/StatusLegend'
import { StockStatusChip } from '../components/StockStatusChip'
import { useAuth } from '../lib/auth-context'
import { useBodyScrollLock } from '../lib/use-body-scroll-lock'
import {
  ApiError,
  decisionQueue,
  listLocations,
  listRequests,
  listThresholds,
  listVariations,
  listWarehouseVariants,
  lowStock,
  salesSince,
  stockByFamily,
  stockByVariant,
} from '../lib/api'

function DashboardBody() {
  const { user } = useAuth()
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [stock, setStock] = useState<StockLevel[]>([])
  const [thresholds, setThresholds] = useState<ThresholdDto[]>([])
  const [sales, setSales] = useState<SalesRow[]>([])
  const [queue, setQueue] = useState<DecisionQueueRow[]>([])
  const [locationId, setLocationId] = useState<string | null>(null)
  const [warehouseVariantCatalog, setWarehouseVariantCatalog] = useState<WarehouseVariantSummary[]>([])
  // Warehouse drawer state was here — moved to /warehouse (own page).
  const [marketDrawerOpen, setMarketDrawerOpen] = useState(false)
  useBodyScrollLock(marketDrawerOpen)
  const [marketOpenVariationId, setMarketOpenVariationId] = useState<string | null>(null)
  const [marketVariantStock, setMarketVariantStock] = useState<StockLevel[]>([])
  const [marketVariantCatalog, setMarketVariantCatalog] = useState<WarehouseVariantSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const isMarketManager = user?.role === 'MARKET_MANAGER'
  const isOwner = user?.role === 'OWNER'
  const isWarehouseManager = user?.role === 'WAREHOUSE_MANAGER'

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const calls: [
          ReturnType<typeof listLocations>,
          ReturnType<typeof listVariations>,
          ReturnType<typeof listRequests>,
          ReturnType<typeof decisionQueue> | Promise<DecisionQueueRow[]>,
        ] = [listLocations(), listVariations(), listRequests(), (isOwner || isWarehouseManager) ? decisionQueue() : Promise.resolve([])]
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
      .then(([s, , sold, thr]) => {
        if (cancelled) return
        setStock(s)
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

  // Market drawer variant breakdown. Two reads:
  //   1. stockByVariant(marketId) — per-variant history at this market
  //      (only DISPATCH events carry warehouseVariantId, so this is
  //      "sent to date" rather than a live count; sales carry no variant).
  //   2. listWarehouseVariants() — variant names + SKUs for display.
  // Kept in a separate effect from the family-level loads so a slow variant
  // catalog fetch doesn't gate the rest of the dashboard.
  useEffect(() => {
    if (!isMarketManager || !locationId) return
    let cancelled = false
    Promise.all([stockByVariant(locationId), listWarehouseVariants()])
      .then(([vStock, vCatalog]) => {
        if (cancelled) return
        setMarketVariantStock(vStock)
        setMarketVariantCatalog(vCatalog)
      })
      .catch(() => {
        // Non-fatal — drawer will still show family-level rows without
        // the expandable variant breakdown.
      })
    return () => {
      cancelled = true
    }
  }, [isMarketManager, locationId])

  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations])

  /// Combined variant catalog (warehouse + market MM views). Any row on
  /// the dashboard that displays a family looks up its variants here so
  /// the tile can pull the first non-null product photo. Empty when
  /// neither catalog has loaded yet — ProductThumb falls back to Swatch.
  const variantsByVariation = useMemo(() => {
    const m = new Map<string, WarehouseVariantSummary[]>()
    const seen = new Set<string>()
    for (const wv of [...warehouseVariantCatalog, ...marketVariantCatalog]) {
      if (seen.has(wv.id)) continue
      seen.add(wv.id)
      const list = m.get(wv.variationId) ?? []
      list.push(wv)
      m.set(wv.variationId, list)
    }
    return m
  }, [warehouseVariantCatalog, marketVariantCatalog])
  const photoForVariation = (variationId: string | undefined | null): string | null =>
    variationId ? firstPhoto(variantsByVariation.get(variationId) ?? []) : null
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
    () =>
      requests
        .filter((r) => r.state !== 'CLOSED')
        // Scope to the market the picker is on so the panel stays
        // consistent with the rest of the dashboard (flagged / on-hand
        // are already market-scoped).
        .filter((r) => (locationId ? r.locationId === locationId : true))
        .slice(0, 8),
    [requests, locationId],
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
  // Only MM (for their market) and OWNER file restocks. WM/WO fulfil,
  // SALES is read-only — none of them see the New request shortcut.
  const canRequest = user?.role === 'MARKET_MANAGER' || user?.role === 'OWNER'
  // Decision queue is threshold-driven review work: OWNER + WM only.
  // WO packs what's approved; MM sees their own market not the queue;
  // SALES never reviews restocks.
  const canReviewQueue = user?.role === 'OWNER' || user?.role === 'WAREHOUSE_MANAGER'
  // Warehouse total card is the "how much do we have to ship" pulse.
  // OWNER + WM only — WO sees warehouse work from the Pack screen, MM
  // shouldn't be looking over the warehouse's shoulder.
  const canSeeWarehouseTotal = canReviewQueue

  const warehouse = useMemo(() => locations.find((l) => l.kind === 'WAREHOUSE'), [locations])

  useEffect(() => {
    if (!canSeeWarehouseTotal || !warehouse) return
    let cancelled = false
    // The full warehouse-variant catalog is still needed so
    // `photoForVariation` can find a preview for every product referenced
    // by the decision queue and other on-hand widgets. Per-variant stock
    // numbers themselves moved to the dedicated /warehouse page.
    listWarehouseVariants()
      .then((variantsCatalog) => {
        if (cancelled) return
        setWarehouseVariantCatalog(variantsCatalog)
      })
      .catch(() => {
        // Non-fatal.
      })
    return () => {
      cancelled = true
    }
  }, [canSeeWarehouseTotal, warehouse])

  // On-hand per (variation, warehouse) — includes 0-stock items via
  // the catalog, not just those with ledger movement. And per-family
  // rows carry their variant breakdown so the drawer can expand each.
  // (warehouseRows/warehouseTotal/warehouseDistinctItems moved to /warehouse.)

  // Market drawer rows: only products that have EVER had ledger activity at
  // this market (dispatched, sold, returned, or corrected here). We base off
  // `stock` — which comes from a groupBy on ledger events at this location,
  // so a variation only appears if it has at least one event here — rather
  // than the full catalog, which would list every warehouse product with a
  // "0" whether or not it ever reached this booth.
  //
  // Variants attach the same way the warehouse drawer does: sourced from the
  // per-variant ledger read (also filtered by locationId), enriched with
  // names + SKUs from the warehouse variant catalog for display. Only
  // variants with ledger activity at this market appear — matching the
  // family-level rule.
  const marketDrawerRows = useMemo(() => {
    const variantMetaById = new Map(marketVariantCatalog.map((wv) => [wv.id, wv]))
    const variantsByVariation = new Map<
      string,
      Array<{ id: string; colourVariantName: string; warehouseSku: string; photoUrl: string | null; onHand: number }>
    >()
    for (const s of marketVariantStock) {
      if (!s.warehouseVariantId) continue
      const meta = variantMetaById.get(s.warehouseVariantId)
      if (!meta) continue
      const list = variantsByVariation.get(s.variationId) ?? []
      list.push({
        id: meta.id,
        colourVariantName: meta.colourVariantName,
        warehouseSku: meta.warehouseSku,
        photoUrl: meta.photoUrl,
        onHand: s.onHand,
      })
      variantsByVariation.set(s.variationId, list)
    }
    for (const [, list] of variantsByVariation) {
      list.sort((a, b) => a.colourVariantName.localeCompare(b.colourVariantName))
    }
    return stock
      .map((s) => {
        const meta = variationById.get(s.variationId)
        if (!meta) return null
        const raw = variantsByVariation.get(s.variationId) ?? []
        // Same placeholder rule as the warehouse drawer — a single "—"
        // variant is the product itself, not a sub-choice, so drop it
        // to avoid a "1 variant" expander over a meaningless em-dash.
        const variants =
          raw.length > 1 || (raw.length === 1 && raw[0]!.colourVariantName !== '—')
            ? raw
            : []
        return {
          variationId: s.variationId,
          meta,
          onHand: s.onHand,
          variants,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => {
        if (b.onHand !== a.onHand) return b.onHand - a.onHand
        return a.meta.itemGroupName.localeCompare(b.meta.itemGroupName)
      })
  }, [stock, variationById, marketVariantStock, marketVariantCatalog])
  const marketTotal = useMemo(() => marketDrawerRows.reduce((s, r) => s + r.onHand, 0), [marketDrawerRows])
  const marketDistinctItems = marketDrawerRows.length

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
            <div style={{ minWidth: 220 }}>
              <SearchableSelect
                value={locationId || null}
                options={markets.map((m) => ({ id: m.id, label: m.name }))}
                onChange={(id) => id && setLocationId(id)}
                showId={false}
                allowClear={false}
              />
            </div>
          ) : null
        }
      />

      {error && <p className="error-banner">{error}</p>}

      <div className="quick-actions">
        {canRequest && (
          <Link href="/requests/new" className="quick-action">
            <svg className="quick-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="3" width="12" height="18" rx="2" />
              <path d="M8 8h8M8 12h5M15 15h4M17 13v4" strokeLinecap="round" />
            </svg>
            <div className="quick-action-label">New request</div>
            <div className="quick-action-desc">Ask the warehouse to send stock to a market.</div>
          </Link>
        )}
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
        {/* Warehouse-totals tile lived here — moved into a full page at
            /warehouse (linked from the sidebar) so drilling into per-variant
            stock doesn't require popping a modal. */}
        {isMarketManager && currentMarket && (
          <button
            type="button"
            onClick={() => setMarketDrawerOpen(true)}
            disabled={loading}
            className="quick-action"
            style={{
              textAlign: 'left',
              cursor: loading ? 'wait' : 'pointer',
              border: '1px solid var(--signal)',
              background: 'var(--surface-sunken)',
            }}
          >
            <svg className="quick-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" strokeLinejoin="round" />
              <path d="M4 7l2-4h12l2 4" strokeLinejoin="round" />
              <path d="M9 11a3 3 0 0 0 6 0" />
            </svg>
            {loading ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <div
                    aria-hidden="true"
                    style={{
                      width: 90,
                      height: 24,
                      borderRadius: 6,
                      // Amber-tinted shimmer, matching the app's active-nav
                      // signal colour so all "attention" surfaces share
                      // the same palette.
                      background:
                        'linear-gradient(90deg, rgba(210, 137, 42, 0.08), rgba(210, 137, 42, 0.28), rgba(210, 137, 42, 0.08))',
                      backgroundSize: '200% 100%',
                      animation: 'catalogSkeleton 1.2s ease-in-out infinite',
                    }}
                  />
                  <div className="eyebrow" style={{ color: 'var(--text-dim)' }}>
                    units at your market
                  </div>
                </div>
                <div
                  className="quick-action-desc"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)' }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      border: '2px solid var(--line-strong)',
                      borderTopColor: 'var(--signal)',
                      animation: 'catalogSpinner 0.8s linear infinite',
                    }}
                  />
                  Loading market totals…
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <div className="quick-action-label" style={{ fontSize: '1.4rem' }}>
                    {marketTotal.toLocaleString()}
                  </div>
                  <div className="eyebrow" style={{ color: 'var(--text-dim)' }}>
                    units at your market
                  </div>
                </div>
                <div className="quick-action-desc">
                  {marketDistinctItems} product{marketDistinctItems === 1 ? '' : 's'} on hand · tap to see the breakdown
                </div>
              </>
            )}
          </button>
        )}
      </div>

      <StatusLegend />

      <div className="dash-columns">
        <div>
          <div className="section-heading">
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <h2>Flagged at this market</h2>
              <InfoTooltip label="What is Flagged at this market?">
                Everything below its restock threshold or empty. Worst first.
              </InfoTooltip>
            </div>
            <span className="eyebrow">
              {flaggedCounts.OUT_OF_STOCK} out · {flaggedCounts.CRITICAL} critical · {flaggedCounts.LOW} low
            </span>
          </div>
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
                <StockTile key={row.variationId} row={row} photoUrl={photoForVariation(row.meta?.id)} />
              ))}
            </div>
          )}

          <div className="section-heading">
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <h2>On hand by family</h2>
              <InfoTooltip label="What is On hand by family?">
                Every colour family this market carries, sorted alphabetically. Number on the right is on-hand;
                smaller number after it is the minimum-level threshold.
              </InfoTooltip>
            </div>
            <span className="eyebrow">
              {flaggedCounts.HEALTHY} healthy · {stockRows.length} total
            </span>
          </div>
          {!loading && stockRows.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>No stock movement recorded here yet.</p>
            </div>
          ) : (
            <div className="stock-grid">
              {stockRows.map((row) => (
                <StockTile key={row.variationId} row={row} photoUrl={photoForVariation(row.meta?.id)} />
              ))}
            </div>
          )}
        </div>

        <div>
          {canReviewQueue && (
            <>
              <div className="section-heading">
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <h2>Decision queue</h2>
                  <InfoTooltip label="What is the Decision queue?">
                    Auto-drafted restock requests waiting on review. Tap one to adjust quantities and open it for packing.
                  </InfoTooltip>
                </div>
                <span className="eyebrow">{queue.length}</span>
              </div>
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
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <h2>Sales this week</h2>
              <InfoTooltip label="What is Sales this week?">
                Top-selling colour families over the last seven days at this market, straight from Square.
              </InfoTooltip>
            </div>
            <span className="eyebrow">{salesTotal} units</span>
          </div>
          {!loading && salesRows.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>No sales recorded here in the last 7 days.</p>
            </div>
          ) : (
            <div className="stack">
              {salesRows.slice(0, 8).map((row) => (
                <div key={row.variationId} className="stock-tile">
                  <ProductThumb
                    photoUrl={photoForVariation(row.meta?.id)}
                    familyName={row.meta?.colourFamilyName ?? ''}
                    alt={row.meta?.itemGroupName ?? ''}
                  />
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
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <h2>Open requests</h2>
              <InfoTooltip label="What is Open requests?">
                Requests in flight — draft, open, packing or dispatched.
              </InfoTooltip>
            </div>
            <Link href="/requests" className="eyebrow">
              View all
            </Link>
          </div>
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


      {marketDrawerOpen && currentMarket && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Market stock breakdown"
          onClick={() => setMarketDrawerOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            justifyContent: 'flex-end',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(480px, 100%)',
              height: '100%',
              background: 'var(--surface)',
              borderLeft: '1px solid var(--line-strong)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                padding: '18px 20px',
                borderBottom: '1px solid var(--line)',
                gap: 12,
              }}
            >
              <div>
                <div className="eyebrow" style={{ color: 'var(--text-dim)' }}>
                  {currentMarket.name}
                </div>
                <h2 style={{ margin: '4px 0 0', fontSize: '1.15rem' }}>
                  {marketTotal.toLocaleString()} units · {marketDistinctItems} product
                  {marketDistinctItems === 1 ? '' : 's'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setMarketDrawerOpen(false)}
                aria-label="Close"
                className="btn btn-ghost"
                style={{ minHeight: 32, padding: '4px 10px' }}
              >
                ✕
              </button>
            </div>

            <div style={{ overflowY: 'auto', padding: '12px 20px 24px', flex: 1 }}>
              {marketDrawerRows.length === 0 ? (
                <p style={{ color: 'var(--text-dim)', margin: 0 }}>
                  Nothing has been shipped to this market yet. Ask the warehouse to dispatch stock.
                </p>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  {marketDrawerRows.map((row) => {
                    const open = marketOpenVariationId === row.variationId
                    const hasVariants = row.variants.length > 0
                    return (
                      <div
                        key={row.variationId}
                        style={{
                          border: '1px solid var(--line)',
                          borderRadius: 'var(--radius-md)',
                          background: 'var(--surface)',
                        }}
                      >
                        <div
                          role={hasVariants ? 'button' : undefined}
                          tabIndex={hasVariants ? 0 : undefined}
                          onClick={() =>
                            hasVariants
                              ? setMarketOpenVariationId(open ? null : row.variationId)
                              : undefined
                          }
                          onKeyDown={(e) => {
                            if (!hasVariants) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setMarketOpenVariationId(open ? null : row.variationId)
                            }
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            width: '100%',
                            padding: '10px 12px',
                            cursor: hasVariants ? 'pointer' : 'default',
                            boxSizing: 'border-box',
                          }}
                          aria-expanded={hasVariants ? open : undefined}
                        >
                          <ProductThumb
                            photoUrl={photoForVariation(row.meta.id)}
                            familyName={row.meta.colourFamilyName}
                            alt={row.meta.itemGroupName}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <span className="list-row-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {row.meta.itemGroupName}
                              </span>
                              <CopyButton text={row.meta.itemGroupName} label="Copy product name" size="sm" />
                            </div>
                            <div className="list-row-meta">
                              {row.meta.colourFamilyName} · {row.meta.sizeOptionName}
                              {hasVariants && ` · ${row.variants.length} variant${row.variants.length === 1 ? '' : 's'}`}
                            </div>
                          </div>
                          <div
                            className="mono"
                            style={{
                              fontWeight: 700,
                              fontSize: '1.05rem',
                              color: row.onHand === 0 ? 'var(--danger)' : 'var(--text)',
                            }}
                          >
                            {row.onHand.toLocaleString()}
                          </div>
                          {hasVariants && (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              aria-hidden="true"
                              style={{
                                color: 'var(--text-dim)',
                                transition: 'transform 0.15s',
                                transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                                flexShrink: 0,
                              }}
                            >
                              <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>

                        {open && hasVariants && (
                          <div
                            style={{
                              borderTop: '1px solid var(--line)',
                              padding: '6px 12px 10px 42px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                            }}
                          >
                            {row.variants.map((v) => (
                              <div
                                key={v.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '4px 0',
                                }}
                              >
                                <ProductThumb
                                  photoUrl={v.photoUrl}
                                  familyName={v.colourVariantName}
                                  alt={v.colourVariantName}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: '0.85rem' }}>{v.colourVariantName}</div>
                                  <div className="mono" style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                                    {v.warehouseSku}
                                  </div>
                                </div>
                                <div
                                  className="mono"
                                  style={{
                                    fontWeight: 600,
                                    fontSize: '0.9rem',
                                    color: v.onHand === 0 ? 'var(--danger)' : 'var(--text)',
                                  }}
                                >
                                  {v.onHand.toLocaleString()}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/// Row inside the dashboard's `stock-grid`. One tile per colour family with
/// swatch, name, colour + size, and its current on-hand / threshold. Sized
/// to fit as a two- or three-up grid on desktop instead of a full-width row
/// each, so ~500 tiles remain scannable rather than an endless column.
function StockTile({
  row,
  photoUrl,
}: {
  row: {
    variationId: string
    meta?: VariationSummary
    onHand: number
    minLevel: number | null
    status: StockStatus
  }
  photoUrl: string | null
}) {
  return (
    <div className="stock-tile">
      <ProductThumb
        photoUrl={photoUrl}
        familyName={row.meta?.colourFamilyName ?? ''}
        alt={row.meta?.itemGroupName ?? ''}
      />
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
