'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { BoxDto, LocationDto, RestockRequestDto } from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { SearchableSelect } from '../../components/SearchableSelect'
import { ApiError, listBoxes, listLocations, listRequests } from '../../lib/api'

function PackIndexBody() {
  const router = useRouter()
  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [boxes, setBoxes] = useState<BoxDto[]>([])
  const [marketFilter, setMarketFilter] = useState<string>('ALL')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Boxes come along so we can hide any request that already has
    // packing progress — the operator resumes those from the request
    // detail's "Continue packing" link (which routes back to this
    // module's per-request URL). Keeps /pack focused on requests that
    // have never been touched.
    Promise.all([listRequests(), listLocations(), listBoxes()])
      .then(([r, l, b]) => {
        setRequests(r)
        setLocations(l)
        setBoxes(b)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load requests.'))
      .finally(() => setLoading(false))
  }, [])

  /// requestIds that have at least one box (any state) associated with
  /// them — either as the sole owner (`box.requestId`) or via a
  /// per-line requestId on a shared multi-request box. Used to filter
  /// them out of the "start packing" list.
  const requestIdsWithBoxes = useMemo(() => {
    const set = new Set<string>()
    for (const b of boxes) {
      if (b.requestId) set.add(b.requestId)
      for (const line of b.lines) if (line.requestId) set.add(line.requestId)
    }
    return set
  }, [boxes])

  const nameById = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations])

  const packable = useMemo(
    () =>
      requests
        // Only OPEN / PACKING requests are actively "packable". PACKED
        // requests have every requested unit on a box already (server-
        // set via BoxesService.reconcileRequestPackedState) and live in
        // the /requests "Packed" tab; DISPATCHED and later are done.
        .filter((r) => r.state === 'OPEN' || r.state === 'PACKING')
        // Also hide any request that already has box progress (partial
        // or full, solo or shared). Once packing has started, further
        // work happens from the request detail — a stray "Pack" tile
        // here would let the operator start a *second* box against the
        // same request and would confuse the "start packing" bucket
        // with the "resume packing" one.
        .filter((r) => !requestIdsWithBoxes.has(r.id))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [requests, requestIdsWithBoxes],
  )

  /// Every active MARKET location — same shape as the market dropdown
  /// on the Requests page so the operator sees a consistent list across
  /// the app. Markets with zero packable requests still appear (the row
  /// grid below just renders the empty state when picked).
  const marketOptions = useMemo(
    () =>
      locations
        .filter((l) => l.kind === 'MARKET' && l.isActive)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => ({ id: l.id, label: l.name })),
    [locations],
  )

  const filtered = useMemo(() => {
    if (marketFilter === 'ALL') return packable
    return packable.filter((r) => r.locationId === marketFilter)
  }, [packable, marketFilter])

  /// Once the operator has ticked at least one request, only same-market
  /// checkboxes stay live — cross-market packing isn't allowed. The
  /// "anchor" market is whichever the first selected request lives in.
  const anchorMarketId = useMemo(() => {
    if (selected.size === 0) return null
    for (const r of packable) if (selected.has(r.id)) return r.locationId
    return null
  }, [selected, packable])

  const selectedList = useMemo(() => filtered.filter((r) => selected.has(r.id)), [filtered, selected])
  const selectedMarketName = anchorMarketId ? nameById.get(anchorMarketId) ?? anchorMarketId : null

  function toggle(id: string, marketId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        // Enforce single-market batches: if the operator ticks a request
        // in a different market than the current anchor, drop the old
        // selection instead of silently ignoring.
        if (anchorMarketId && marketId !== anchorMarketId) {
          next.clear()
        }
        next.add(id)
      }
      return next
    })
  }

  function packSelected() {
    if (!anchorMarketId || selected.size === 0) return
    const ids = selectedList.map((r) => r.id)
    const qs = new URLSearchParams({ requests: ids.join(',') }).toString()
    router.push(`/pack/dest/${encodeURIComponent(anchorMarketId)}?${qs}`)
  }

  /// "Select all" for the current market filter. Only enabled when the
  /// filter is a specific market (not ALL), because cross-market batches
  /// aren't allowed. Ticks every visible row.
  function selectAllVisible() {
    if (marketFilter === 'ALL') return
    setSelected(new Set(filtered.map((r) => r.id)))
  }

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse floor"
        title="Pack"
        description="Every request that's ready to be packed. Tick two or more going to the same market to combine them into a single packing session, or open one on its own."
        actions={
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
            <div style={{ minWidth: 220 }}>
              <SearchableSelect
                value={marketFilter}
                options={[{ id: 'ALL', label: 'All markets' }, ...marketOptions]}
                onChange={(id) => setMarketFilter(id ?? 'ALL')}
                size="sm"
                showId={false}
                allowClear={false}
              />
            </div>
          </label>
        }
      />

      {error && <p className="error-banner">{error}</p>}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        {marketFilter !== 'ALL' && filtered.length > 1 && filtered.length !== selected.size && (
          <button
            type="button"
            onClick={selectAllVisible}
            style={{
              all: 'unset',
              fontSize: '0.78rem',
              color: 'var(--signal, #b58a2c)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Select all {filtered.length}
          </button>
        )}
        <span className="eyebrow">
          {filtered.length} request{filtered.length === 1 ? '' : 's'}
          {marketFilter === 'ALL' ? '' : ` at ${nameById.get(marketFilter) ?? marketFilter}`}
        </span>
      </div>

      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing to pack</p>
          <p className="empty-state-body">
            {marketFilter === 'ALL'
              ? 'A request has to be Open or Packing to show up here. Open one from the Requests tab.'
              : 'No open or packing requests for this market. Try a different market or All markets.'}
          </p>
          <Link href="/requests" className="empty-state-cta">
            → Requests
          </Link>
        </div>
      ) : (
        <div className="stack">
          {filtered.map((r) => {
            const disabled = anchorMarketId !== null && anchorMarketId !== r.locationId
            const isSelected = selected.has(r.id)
            return (
              <RequestRow
                key={r.id}
                request={r}
                locationName={nameById.get(r.locationId) ?? r.locationId}
                selected={isSelected}
                disabled={disabled}
                onToggle={() => toggle(r.id, r.locationId)}
              />
            )
          })}
        </div>
      )}

      {selected.size > 0 && (
        <div
          style={{
            position: 'sticky',
            bottom: 76,
            marginTop: 16,
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--signal, #b58a2c)',
            background: 'var(--surface)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ minWidth: 0, fontSize: '0.85rem' }}>
            <strong>{selected.size} selected</strong>
            {selectedMarketName ? ` · ${selectedMarketName}` : ''}
            <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>
              {selectedList.reduce((sum, r) => sum + r.lines.length, 0)} lines ·{' '}
              {selectedList
                .reduce((sum, r) => sum + r.lines.reduce((s, l) => s + l.qtyRequested, 0), 0)
                .toLocaleString()}{' '}
              units
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              style={{
                all: 'unset',
                fontSize: '0.8rem',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-dim)',
                cursor: 'pointer',
              }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={packSelected}
              style={{
                all: 'unset',
                display: 'inline-flex',
                alignItems: 'center',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--signal, #b58a2c)',
                color: 'var(--signal-ink, #fff)',
                fontSize: '0.85rem',
                fontWeight: 700,
                letterSpacing: '0.02em',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Pack {selected.size} together →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function RequestRow({
  request,
  locationName,
  selected,
  disabled,
  onToggle,
}: {
  request: RestockRequestDto
  locationName: string
  selected: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const totalUnits = request.lines.reduce((s, l) => s + l.qtyRequested, 0)
  return (
    <div
      className="card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        opacity: disabled ? 0.5 : 1,
        borderColor: selected ? 'var(--signal, #b58a2c)' : undefined,
        background: selected ? 'var(--surface-sunken)' : undefined,
        transition: 'border-color 0.12s, background 0.12s',
      }}
    >
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          cursor: disabled ? 'not-allowed' : 'pointer',
          flexShrink: 0,
          paddingRight: 4,
        }}
        title={disabled ? 'Different market — clear the current selection to pick this one.' : 'Select this request'}
      >
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
          style={{ width: 18, height: 18, cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
      </label>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="list-row-title" style={{ fontSize: '0.95rem' }}>
            {locationName}
          </div>
          <span className={`chip ${request.state === 'PACKING' ? 'chip-signal' : ''}`}>
            {request.state.toLowerCase()}
          </span>
        </div>
        <div className="list-row-meta" style={{ marginTop: 2 }}>
          <span className="mono">#{request.id.slice(0, 6)}</span> · {request.lines.length} line
          {request.lines.length === 1 ? '' : 's'} · {totalUnits.toLocaleString()} unit
          {totalUnits === 1 ? '' : 's'} ·{' '}
          {new Date(request.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </div>
      </div>

      <Link
        href={`/pack/${request.id}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flex: '0 0 auto',
          width: 'auto',
          padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--signal, #b58a2c)',
          color: 'var(--signal-ink, #fff)',
          fontSize: '0.82rem',
          fontWeight: 700,
          letterSpacing: '0.02em',
          textDecoration: 'none',
          whiteSpace: 'nowrap',
          border: '1px solid var(--signal, #b58a2c)',
        }}
        title="Pack this single request on its own"
      >
        Pack →
      </Link>
    </div>
  )
}

export default function PackIndexPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']}>
      <PackIndexBody />
    </RequireAuth>
  )
}
