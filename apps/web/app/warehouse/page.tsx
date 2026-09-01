'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CopyButton } from '../../components/CopyButton'
import { PageHeader } from '../../components/PageHeader'
import { ProductThumb } from '../../components/ProductThumb'
import { RequireAuth } from '../../components/RequireAuth'
import { ApiError, warehouseInventory, type WarehouseInventoryPage } from '../../lib/api'

const PAGE_SIZE = 50

/// Full per-variation inventory for the primary warehouse. Server-side
/// paginated (50 rows per page) and server-side searched so the client
/// never has to pull the full catalog just to render a list.
///
/// Grand totals in the header (units + product count) come from the same
/// endpoint and stay stable while the operator narrows with the search
/// box — those numbers describe the whole warehouse, not the current
/// filter.
function WarehouseBody() {
  const [page, setPage] = useState<WarehouseInventoryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [openVariationId, setOpenVariationId] = useState<string | null>(null)

  // Debounce keystrokes into a single fetch — matches the 250 ms feel
  // most SearchableSelects use elsewhere in the app.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => clearTimeout(handle)
  }, [query])

  // Track the latest fetch so out-of-order responses don't clobber the
  // UI: if the operator types "s" then "sc" quickly and the "s" response
  // arrives last, we ignore it.
  const requestSeq = useRef(0)

  useEffect(() => {
    const mySeq = ++requestSeq.current
    setLoading(true)
    setOpenVariationId(null)
    warehouseInventory({ q: debouncedQuery || undefined, offset: 0, limit: PAGE_SIZE })
      .then((res) => {
        if (mySeq !== requestSeq.current) return
        setPage(res)
        setError(null)
      })
      .catch((err) => {
        if (mySeq !== requestSeq.current) return
        setError(err instanceof ApiError ? err.message : 'Could not load the warehouse inventory.')
      })
      .finally(() => {
        if (mySeq === requestSeq.current) setLoading(false)
      })
  }, [debouncedQuery])

  async function loadMore() {
    if (!page || page.nextOffset === null || loadingMore) return
    setLoadingMore(true)
    const mySeq = requestSeq.current
    try {
      const res = await warehouseInventory({
        q: debouncedQuery || undefined,
        offset: page.nextOffset,
        limit: PAGE_SIZE,
      })
      if (mySeq !== requestSeq.current) return
      setPage((prev) =>
        prev
          ? {
              ...res,
              rows: [...prev.rows, ...res.rows],
            }
          : res,
      )
    } catch (err) {
      if (mySeq === requestSeq.current) {
        setError(err instanceof ApiError ? err.message : 'Could not load more rows.')
      }
    } finally {
      if (mySeq === requestSeq.current) setLoadingMore(false)
    }
  }

  const showingCount = page?.rows.length ?? 0
  const filteredCount = page?.filteredCount ?? 0
  const isSearching = debouncedQuery.length > 0
  const hasMore = page?.nextOffset !== null && page?.nextOffset !== undefined
  const rangeLabel = useMemo(() => {
    if (!page) return ''
    if (isSearching) return `${showingCount} of ${filteredCount} match${filteredCount === 1 ? '' : 'es'}`
    return `${showingCount} of ${filteredCount}`
  }, [page, showingCount, filteredCount, isSearching])

  return (
    <div>
      <PageHeader
        eyebrow="Main warehouse"
        title="Warehouse inventory"
        description="Every product in the catalog with its live on-hand at the primary warehouse. Highest stock first; tap a row with variants to see the per-colour / per-size split. Search filters the list server-side."
      />

      {error && <p className="error-banner">{error}</p>}

      {/* Metric tiles — two side-by-side stat cards with icon badges.
          Numbers stay stable while the search below narrows the list, so
          the header always tells the whole-warehouse story. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <MetricTile
          label="Total units"
          value={loading && !page ? null : page?.total ?? 0}
          hint="Aggregate on-hand at the primary warehouse"
          accentColour="var(--pine, #4a6b52)"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 8l9-5 9 5-9 5-9-5z" strokeLinejoin="round" />
              <path d="M3 8v8l9 5 9-5V8M12 13v8" strokeLinejoin="round" />
            </svg>
          }
        />
        <MetricTile
          label="Products"
          value={loading && !page ? null : page?.distinctItems ?? 0}
          hint="Distinct variations in the catalog"
          accentColour="var(--signal, #d2892a)"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
              <rect x="13" y="3" width="8" height="8" rx="1.5" />
              <rect x="3" y="13" width="8" height="8" rx="1.5" />
              <rect x="13" y="13" width="8" height="8" rx="1.5" />
            </svg>
          }
        />
      </div>

      {/* Search on its own row using the standard `.field` pattern —
          same size and chrome as the intake / new-request searches so
          operators get a consistent input everywhere. A small spinner
          appears inside the input on the right whenever a fetch is
          in flight because the query changed (either during the debounce
          window or the actual request). */}
      <div className="field" style={{ marginBottom: 12 }}>
        <label htmlFor="warehouse-search">Search</label>
        <div style={{ position: 'relative' }}>
          <input
            id="warehouse-search"
            placeholder="Product, colour, size, or SKU…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            style={{ width: '100%', paddingRight: 40 }}
          />
          {/* Only spin while the actual fetch is in flight — not during
              the debounce window. Otherwise the operator sees a spinner
              on every keystroke, which reads as constant "processing"
              even when nothing has hit the network yet. */}
          {loading && query.trim() !== '' && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                right: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: '2px solid var(--line-strong)',
                borderTopColor: 'var(--signal, #d2892a)',
                animation: 'warehouseSpin 0.8s linear infinite',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      </div>

      {page && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
            padding: '0 4px',
            fontSize: '0.78rem',
            color: 'var(--text-dim)',
          }}
        >
          <span>{rangeLabel}</span>
          {isSearching && (
            <span>
              Filter: <strong style={{ color: 'var(--text)' }}>{debouncedQuery}</strong>
            </span>
          )}
        </div>
      )}

      {loading && !page ? (
        <SkeletonList />
      ) : filteredCount === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">
            {isSearching ? 'Nothing matches that search' : 'No products in the warehouse yet'}
          </p>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
            {isSearching
              ? 'Try a colour, size, or SKU fragment.'
              : 'Once inventory lands via intake, it will show here.'}
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {page!.rows.map((row) => {
            const open = openVariationId === row.variationId
            const hasVariants = row.variants.length > 0
            return (
              <div
                key={row.variationId}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface)',
                  boxShadow: open ? '0 2px 12px rgba(0,0,0,0.04)' : undefined,
                  transition: 'box-shadow 0.15s',
                }}
              >
                <div
                  role={hasVariants ? 'button' : undefined}
                  tabIndex={hasVariants ? 0 : undefined}
                  onClick={() => hasVariants && setOpenVariationId(open ? null : row.variationId)}
                  onKeyDown={(e) => {
                    if (!hasVariants) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpenVariationId(open ? null : row.variationId)
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    cursor: hasVariants ? 'pointer' : 'default',
                    boxSizing: 'border-box',
                  }}
                  aria-expanded={hasVariants ? open : undefined}
                >
                  <ProductThumb
                    photoUrl={row.previewPhotoUrl}
                    familyName={row.colourFamilyName}
                    alt={row.itemGroupName}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span
                        className="list-row-title"
                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {row.itemGroupName}
                      </span>
                      <CopyButton text={row.itemGroupName} label="Copy product name" size="sm" />
                    </div>
                    <div className="list-row-meta">
                      {row.colourFamilyName} · {row.sizeOptionName}
                      {hasVariants && ` · ${row.variants.length} variant${row.variants.length === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontWeight: 700,
                      fontSize: '1.1rem',
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
                      <path
                        d="M3 5l4 4 4-4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>

                {open && hasVariants && (
                  <div
                    style={{
                      borderTop: '1px solid var(--line)',
                      padding: '10px 14px 14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      background: 'var(--surface-sunken)',
                    }}
                  >
                    {row.variants.map((v) => (
                      <div
                        key={v.warehouseVariantId}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          minWidth: 0,
                          padding: '6px 8px',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--surface)',
                          border: '1px solid var(--line)',
                        }}
                      >
                        <ProductThumb
                          photoUrl={v.photoUrl}
                          familyName={v.colourVariantName}
                          alt={v.colourVariantName}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                fontSize: '0.88rem',
                              }}
                            >
                              {v.colourVariantName}
                            </span>
                            <CopyButton text={v.colourVariantName} label="Copy variant name" size="sm" />
                          </div>
                          <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                            {v.warehouseSku}
                          </div>
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontWeight: 700,
                            fontSize: '1rem',
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

          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="btn btn-ghost"
              style={{
                marginTop: 8,
                justifyContent: 'center',
                minHeight: 44,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {loadingMore ? (
                <>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      border: '2px solid var(--line-strong)',
                      borderTopColor: 'var(--signal)',
                      animation: 'warehouseSpin 0.8s linear infinite',
                    }}
                  />
                  Loading…
                </>
              ) : (
                `Load more (${filteredCount - showingCount} remaining)`
              )}
            </button>
          )}
        </div>
      )}

      <style>{`@keyframes warehouseSpin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

/// Metric tile — icon badge on the left in the accent colour, then a
/// small uppercase label, big number, and a one-line hint underneath.
/// Same tile shape used for both stats so the row reads as a pair.
function MetricTile({
  label,
  value,
  hint,
  icon,
  accentColour,
}: {
  label: string
  value: number | null
  hint: string
  icon: React.ReactNode
  accentColour: string
}) {
  return (
    <div
      className="card"
      style={{
        padding: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 40,
          height: 40,
          borderRadius: 'var(--radius-md)',
          background: 'color-mix(in srgb, ' + accentColour + ' 12%, transparent)',
          color: accentColour,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          className="eyebrow"
          style={{
            color: 'var(--text-dim)',
            fontSize: '0.7rem',
            letterSpacing: '0.08em',
            marginBottom: 4,
          }}
        >
          {label}
        </div>
        {value === null ? (
          <div
            aria-hidden="true"
            style={{
              width: 90,
              height: 30,
              borderRadius: 6,
              background:
                'linear-gradient(90deg, rgba(210, 137, 42, 0.08), rgba(210, 137, 42, 0.28), rgba(210, 137, 42, 0.08))',
              backgroundSize: '200% 100%',
              animation: 'warehouseShimmer 1.2s ease-in-out infinite',
            }}
          />
        ) : (
          <div className="mono" style={{ fontSize: '1.7rem', fontWeight: 700, lineHeight: 1.05 }}>
            {value.toLocaleString()}
          </div>
        )}
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-dim)',
            marginTop: 4,
          }}
        >
          {hint}
        </div>
      </div>
      <style>{`@keyframes warehouseShimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
    </div>
  )
}

/// Row-shaped skeletons rendered while the first page is fetching.
function SkeletonList() {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface)',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 'var(--radius-sm)',
              background:
                'linear-gradient(90deg, rgba(210, 137, 42, 0.08), rgba(210, 137, 42, 0.22), rgba(210, 137, 42, 0.08))',
              backgroundSize: '200% 100%',
              animation: 'warehouseShimmer 1.2s ease-in-out infinite',
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                width: '40%',
                height: 14,
                borderRadius: 4,
                background:
                  'linear-gradient(90deg, rgba(210, 137, 42, 0.08), rgba(210, 137, 42, 0.22), rgba(210, 137, 42, 0.08))',
                backgroundSize: '200% 100%',
                animation: 'warehouseShimmer 1.2s ease-in-out infinite',
                marginBottom: 6,
              }}
            />
            <div
              style={{
                width: '25%',
                height: 10,
                borderRadius: 4,
                background:
                  'linear-gradient(90deg, rgba(210, 137, 42, 0.06), rgba(210, 137, 42, 0.16), rgba(210, 137, 42, 0.06))',
                backgroundSize: '200% 100%',
                animation: 'warehouseShimmer 1.2s ease-in-out infinite',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function WarehousePage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER']}>
      <WarehouseBody />
    </RequireAuth>
  )
}
