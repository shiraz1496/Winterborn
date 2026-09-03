'use client'

import { useEffect, useState } from 'react'
import type {
  AdminLocationDto,
  BusinessHours,
  BusinessHoursPeriod,
  LocationKind,
  SyncSquareLocationsResult,
} from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import {
  ApiError,
  createAdminLocation,
  listAdminLocations,
  syncSquareLocations,
  updateAdminLocation,
} from '../../../lib/api'
import { useAuth } from '../../../lib/auth-context'
import { useBodyScrollLock } from '../../../lib/use-body-scroll-lock'
import { useToast } from '../../../lib/toast'

function LocationsAdminBody() {
  const toast = useToast()
  const { user } = useAuth()
  const isOwner = user?.role === 'OWNER'
  const [rows, setRows] = useState<AdminLocationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<SyncSquareLocationsResult | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AdminLocationDto | null>(null)

  useEffect(() => {
    void reload()
  }, [])

  async function reload() {
    setLoading(true)
    try {
      const data = await listAdminLocations()
      setRows(data)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load locations.')
    } finally {
      setLoading(false)
    }
  }

  async function runSync() {
    setSyncing(true)
    setError(null)
    setLastSync(null)
    try {
      const result = await syncSquareLocations()
      setLastSync(result)
      await reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sync failed.')
    } finally {
      setSyncing(false)
    }
  }

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  const marketRows = rows.filter((r) => r.kind === 'MARKET')
  const linkedCount = marketRows.filter((r) => r.squareLocationId).length

  return (
    <div>
      <PageHeader
        eyebrow="Owner + Warehouse Manager"
        title="Locations"
        description="Market locations linked to Square. Sales at a linked market decrement stock here. Use Sync from Square to pull in new markets or update names/timezones from the Square dashboard."
      />

      {error && <p className="error-banner">{error}</p>}

      <div
        className="row"
        style={{
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <span className="eyebrow">
          {marketRows.length} market{marketRows.length === 1 ? '' : 's'} ({linkedCount} linked to Square)
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isOwner && (
            <button
              type="button"
              className="btn"
              onClick={() => setCreateOpen(true)}
              style={{ minHeight: 36, padding: '6px 14px' }}
            >
              + New location
            </button>
          )}
          <button
            type="button"
            onClick={runSync}
            disabled={syncing}
            style={{
              padding: '8px 16px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--pine)',
              background: syncing ? 'var(--surface-muted)' : 'var(--pine)',
              color: syncing ? 'var(--text-faint)' : 'var(--pine-ink)',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: syncing ? 'wait' : 'pointer',
            }}
          >
            {syncing ? 'Syncing…' : 'Sync from Square'}
          </button>
        </div>
      </div>

      {createOpen && (
        <CreateLocationModal
          onClose={() => setCreateOpen(false)}
          onCreated={(msg) => {
            toast.success(msg)
            setCreateOpen(false)
            void reload()
          }}
        />
      )}

      {lastSync && (
        <div
          role="status"
          style={{
            padding: 14,
            marginBottom: 18,
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-raised)',
            fontSize: '0.85rem',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Sync complete — Square returned {lastSync.squareTotal} location{lastSync.squareTotal === 1 ? '' : 's'}.
          </div>
          <SyncBucket label="Created" values={lastSync.created} tone="new" />
          <SyncBucket label="Linked to existing" values={lastSync.linked} tone="new" />
          <SyncBucket label="Updated (name / timezone)" values={lastSync.updated} tone="neutral" />
          <SyncBucket label="Still unlinked (no Square match)" values={lastSync.unlinked} tone="warn" />
        </div>
      )}

      <LocationTable
        rows={marketRows}
        canEdit={isOwner}
        onToggle={async (row) => {
          try {
            const result = await updateAdminLocation(row.id, { isActive: !row.isActive })
            setRows((prev) => prev.map((r) => (r.id === result.location.id ? result.location : r)))
            toast.success(
              result.syncedToSquare
                ? `"${result.location.name}" is now ${result.location.isActive ? 'active' : 'inactive'} (synced to Square).`
                : `"${result.location.name}" is now ${result.location.isActive ? 'active' : 'inactive'}.`,
            )
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : 'Could not update location.'
            setError(msg)
            toast.error(msg)
          }
        }}
        onEdit={(row) => setEditTarget(row)}
      />

      {editTarget && (
        <EditLocationModal
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={(location, syncedToSquare) => {
            setRows((prev) => prev.map((r) => (r.id === location.id ? location : r)))
            toast.success(
              syncedToSquare
                ? `"${location.name}" updated locally and in Square.`
                : `"${location.name}" updated.`,
            )
            setEditTarget(null)
          }}
        />
      )}

    </div>
  )
}

function LocationTable({
  rows,
  canEdit,
  onToggle,
  onEdit,
}: {
  rows: AdminLocationDto[]
  canEdit: boolean
  onToggle: (row: AdminLocationDto) => Promise<void>
  onEdit: (row: AdminLocationDto) => void
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-body">None yet.</p>
      </div>
    )
  }

  async function handleToggle(row: AdminLocationDto) {
    setPendingId(row.id)
    try {
      await onToggle(row)
    } finally {
      setPendingId(null)
    }
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Name</th>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Timezone</th>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Square location ID</th>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Active</th>
          {canEdit && (
            <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)', textAlign: 'right' }}>Actions</th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const busy = pendingId === r.id
          return (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <td style={{ padding: '8px', fontWeight: 600 }}>{r.name}</td>
              <td style={{ padding: '8px', color: 'var(--text-faint)' }}>{r.timezone}</td>
              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                {r.squareLocationId ?? <span style={{ color: 'var(--text-faint)' }}>(unlinked)</span>}
              </td>
              <td style={{ padding: '8px' }}>
                {canEdit ? (
                  <ActiveToggle active={r.isActive} busy={busy} onClick={() => handleToggle(r)} />
                ) : (
                  <span style={{ fontSize: '0.85rem', color: r.isActive ? 'var(--text)' : 'var(--text-dim)' }}>
                    {r.isActive ? 'Yes' : 'No'}
                  </span>
                )}
              </td>
              {canEdit && (
                <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onEdit(r)}
                    style={{ minHeight: 30, padding: '4px 10px', fontSize: '0.82rem' }}
                  >
                    Edit
                  </button>
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ActiveToggle({
  active,
  busy,
  onClick,
}: {
  active: boolean
  busy: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      role="switch"
      aria-checked={active}
      aria-label={`Toggle active (currently ${active ? 'active' : 'inactive'})`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 34,
          height: 20,
          borderRadius: 12,
          background: active ? 'var(--pine)' : 'var(--line-strong)',
          position: 'relative',
          transition: 'background 0.15s ease',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: active ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.15s ease',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }}
        />
      </span>
      <span style={{ fontSize: '0.85rem', color: active ? 'var(--text)' : 'var(--text-dim)' }}>
        {busy ? '…' : active ? 'Yes' : 'No'}
      </span>
    </button>
  )
}

function SyncBucket({ label, values, tone }: { label: string; values: string[]; tone: 'new' | 'neutral' | 'warn' }) {
  if (values.length === 0) return null
  const colour = tone === 'new' ? 'var(--pine)' : tone === 'warn' ? 'var(--danger, #c0392b)' : 'var(--text)'
  return (
    <div style={{ marginTop: 4 }}>
      <span style={{ color: colour, fontWeight: 700 }}>
        {label} ({values.length}):
      </span>{' '}
      <span>{values.join(', ')}</span>
    </div>
  )
}

/// Small structured error card used inside modals. Splits the message
/// into an optional context prefix (before the first colon) and the
/// human-readable detail so the operator sees WHY at a glance without
/// having to parse a wall of text.
function ModalError({ message }: { message: string }) {
  const colonIdx = message.indexOf(':')
  const context = colonIdx > 0 ? message.slice(0, colonIdx).trim() : null
  const detail = (colonIdx > 0 ? message.slice(colonIdx + 1) : message).trim()
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: 12,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--rust)',
        background: 'rgba(200, 80, 40, 0.06)',
        marginBottom: 12,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="var(--rust)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0, marginTop: 2 }}
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12" y2="17" />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        {context && (
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--rust)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 4 }}>
            {context}
          </div>
        )}
        <div style={{ fontSize: '0.9rem', color: 'var(--text)', lineHeight: 1.45, wordBreak: 'break-word' }}>
          {detail}
        </div>
      </div>
    </div>
  )
}

/// Row-per-weekday editor for business hours. Keeps things simple: one
/// open/close pair per day (Mon-Sun). Multi-period support (lunch splits)
/// exists in Square but the operator wanted the essentials first — a
/// "+ add period" affordance would slot in here without a shape change
/// on the wire.
const DAYS_OF_WEEK: Array<{ id: BusinessHoursPeriod['dayOfWeek']; label: string }> = [
  { id: 'MON', label: 'Monday' },
  { id: 'TUE', label: 'Tuesday' },
  { id: 'WED', label: 'Wednesday' },
  { id: 'THU', label: 'Thursday' },
  { id: 'FRI', label: 'Friday' },
  { id: 'SAT', label: 'Saturday' },
  { id: 'SUN', label: 'Sunday' },
]

interface DayHoursDraft {
  open: boolean
  start: string // "HH:MM"
  end: string
}

function initialDaysFromHours(hours: BusinessHours | null): Record<BusinessHoursPeriod['dayOfWeek'], DayHoursDraft> {
  const base: Record<BusinessHoursPeriod['dayOfWeek'], DayHoursDraft> = {
    SUN: { open: false, start: '10:00', end: '18:00' },
    MON: { open: false, start: '10:00', end: '18:00' },
    TUE: { open: false, start: '10:00', end: '18:00' },
    WED: { open: false, start: '10:00', end: '18:00' },
    THU: { open: false, start: '10:00', end: '18:00' },
    FRI: { open: false, start: '10:00', end: '18:00' },
    SAT: { open: false, start: '10:00', end: '18:00' },
  }
  if (!hours) return base
  for (const p of hours.periods) {
    base[p.dayOfWeek] = {
      open: true,
      start: p.startLocalTime.slice(0, 5), // trim "10:00:00" → "10:00"
      end: p.endLocalTime.slice(0, 5),
    }
  }
  return base
}

/// Serialise the editor state to the wire shape. Only open days become
/// periods; times are padded to HH:MM:SS so Square accepts them without
/// interpretation ambiguity.
function daysToBusinessHours(days: Record<BusinessHoursPeriod['dayOfWeek'], DayHoursDraft>): BusinessHours | null {
  const periods: BusinessHoursPeriod[] = []
  for (const d of DAYS_OF_WEEK) {
    const draft = days[d.id]
    if (!draft.open) continue
    periods.push({
      dayOfWeek: d.id,
      startLocalTime: draft.start.length === 5 ? `${draft.start}:00` : draft.start,
      endLocalTime: draft.end.length === 5 ? `${draft.end}:00` : draft.end,
    })
  }
  return periods.length > 0 ? { periods } : null
}

function BusinessHoursEditor({
  days,
  onChange,
}: {
  days: Record<BusinessHoursPeriod['dayOfWeek'], DayHoursDraft>
  onChange: (next: Record<BusinessHoursPeriod['dayOfWeek'], DayHoursDraft>) => void
}) {
  function patch(day: BusinessHoursPeriod['dayOfWeek'], p: Partial<DayHoursDraft>) {
    onChange({ ...days, [day]: { ...days[day], ...p } })
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      {DAYS_OF_WEEK.map((d) => {
        const draft = days[d.id]
        return (
          <div
            key={d.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr 1fr',
              gap: 8,
              alignItems: 'center',
              padding: '6px 10px',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-md)',
              background: draft.open ? 'var(--surface)' : 'var(--surface-raised)',
            }}
          >
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: '0.85rem',
                cursor: 'pointer',
                userSelect: 'none',
                margin: 0,
                fontWeight: draft.open ? 700 : 500,
                color: draft.open ? 'var(--text)' : 'var(--text-dim)',
              }}
            >
              <input
                type="checkbox"
                checked={draft.open}
                onChange={(e) => patch(d.id, { open: e.target.checked })}
              />
              {d.label}
            </label>
            <input
              type="time"
              value={draft.start}
              onChange={(e) => patch(d.id, { start: e.target.value })}
              disabled={!draft.open}
              aria-label={`${d.label} open time`}
              style={{ minHeight: 32 }}
            />
            <input
              type="time"
              value={draft.end}
              onChange={(e) => patch(d.id, { end: e.target.value })}
              disabled={!draft.open}
              aria-label={`${d.label} close time`}
              style={{ minHeight: 32 }}
            />
          </div>
        )
      })}
    </div>
  )
}

function CreateLocationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (message: string) => void
}) {
  useBodyScrollLock()
  // Sensible defaults: MARKET (Square-linked), current browser timezone,
  // US country. Operator can change any of these before submitting.
  const defaultTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : 'UTC'
  const [name, setName] = useState('')
  const [kind, setKind] = useState<LocationKind>('MARKET')
  const [timezone, setTimezone] = useState(defaultTz)
  const [syncToSquare, setSyncToSquare] = useState(true)
  const [businessHoursDays, setBusinessHoursDays] = useState(() => initialDaysFromHours(null))
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [country, setCountry] = useState('US')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const goingToSquare = kind === 'MARKET' && syncToSquare

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const hours = daysToBusinessHours(businessHoursDays)
      const result = await createAdminLocation({
        name: name.trim(),
        kind,
        timezone: timezone.trim(),
        syncToSquare: kind === 'MARKET' ? syncToSquare : false,
        ...(hours ? { businessHours: hours } : {}),
        ...(goingToSquare
          ? {
            address: {
              line1: line1.trim(),
              ...(line2.trim() ? { line2: line2.trim() } : {}),
              city: city.trim(),
              state: state.trim(),
              postalCode: postalCode.trim(),
              country: country.trim().toUpperCase(),
            },
          }
          : {}),
      })
      onCreated(
        result.syncedToSquare
          ? `Created "${result.location.name}" locally and in Square.`
          : `Created "${result.location.name}" locally (not linked to Square).`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the location.')
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create location"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 40,
        overflowY: 'auto',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="card modal-card-scroll"
        style={{
          maxWidth: 560,
          width: '100%',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-lg)',
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>New location</h2>
          <button
            className="btn btn-ghost"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            style={{ minHeight: 32, minWidth: 32, padding: 4 }}
            type="button"
          >
            ✕
          </button>
        </div>

        {error && <ModalError message={error} />}

        <div className="stack" style={{ gap: 14 }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="loc-name">Name</label>
            <input
              id="loc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Portland (Pioneer Square)"
              autoComplete="off"
            />
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label>Type</label>
            <div className="segmented" role="tablist" aria-label="Location kind">
              {(
                [
                  { id: 'MARKET' as LocationKind, label: 'Market' },
                  // { id: 'WAREHOUSE' as LocationKind, label: 'Warehouse' },
                ]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="tab"
                  aria-selected={kind === opt.id}
                  className={`segmented-btn${kind === opt.id ? ' active' : ''}`}
                  onClick={() => setKind(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              Markets can be linked to Square. Warehouses stay local — Square has no warehouse concept.
            </p>
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="loc-tz">Timezone</label>
            <input
              id="loc-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York"
              autoComplete="off"
            />
            <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              IANA name. Defaulted from your browser; change if this location is in a different zone.
            </p>
          </div>

          {kind === 'MARKET' && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-raised)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={syncToSquare}
                onChange={(e) => setSyncToSquare(e.target.checked)}
              />
              <span style={{ flex: 1, fontSize: '0.88rem' }}>
                Also create this location in Square (recommended for markets)
              </span>
            </label>
          )}

          {goingToSquare && (
            <>
              <div className="section-heading" style={{ margin: '4px 0 0' }}>
                <h3 style={{ margin: 0, fontSize: '0.85rem' }}>Address (required by Square)</h3>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="loc-line1">Street</label>
                <input id="loc-line1" value={line1} onChange={(e) => setLine1(e.target.value)} autoComplete="off" />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="loc-line2">
                  Suite / unit <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span>
                </label>
                <input id="loc-line2" value={line2} onChange={(e) => setLine2(e.target.value)} autoComplete="off" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="loc-city">City</label>
                  <input id="loc-city" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="off" />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="loc-state">State / region</label>
                  <input id="loc-state" value={state} onChange={(e) => setState(e.target.value)} autoComplete="off" />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="loc-zip">Postal code</label>
                  <input id="loc-zip" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} autoComplete="off" />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="loc-country">Country</label>
                  <input
                    id="loc-country"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    maxLength={2}
                    placeholder="US"
                    autoComplete="off"
                  />
                  <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                    ISO 3166-1 alpha-2 (US, GB, CA, AU…). The UK is <strong>GB</strong>, not "UK".
                  </p>
                </div>
              </div>
            </>
          )}

          <div className="section-heading" style={{ margin: '4px 0 0' }}>
            <h3 style={{ margin: 0, fontSize: '0.85rem' }}>
              Business hours <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span>
            </h3>
          </div>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-dim)' }}>
            Toggle a day on and set open + close times. Unchecked days count as closed.
          </p>
          <BusinessHoursEditor days={businessHoursDays} onChange={setBusinessHoursDays} />

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
            <button className="btn" onClick={onClose} disabled={busy} type="button">
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || name.trim().length === 0 || (goingToSquare && (!line1 || !city || !state || !postalCode || !country))}
              style={{ width: 'auto', paddingLeft: 20, paddingRight: 20 }}
              type="button"
            >
              {busy ? 'Creating…' : goingToSquare ? 'Create + push to Square' : 'Create locally'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function EditLocationModal({
  target,
  onClose,
  onSaved,
}: {
  target: AdminLocationDto
  onClose: () => void
  onSaved: (row: AdminLocationDto, syncedToSquare: boolean) => void
}) {
  useBodyScrollLock()
  const isSquareLinked = target.kind === 'MARKET' && target.squareLocationId !== null
  const canLinkToSquare = target.kind === 'MARKET' && !isSquareLinked

  const [name, setName] = useState(target.name)
  const [timezone, setTimezone] = useState(target.timezone)
  // "Link to Square on save" — only relevant when currently unlinked.
  // Auto-off by default so the operator doesn't accidentally push an
  // unlinked-on-purpose market up to Square by hitting Save.
  const [linkToSquare, setLinkToSquare] = useState(false)
  // Pre-fill from the row's cached address columns — populated by the
  // create / update / sync flows. No Square round-trip on modal open;
  // legacy rows that pre-date the address cache come through as empty
  // strings and the operator fills them in.
  const [line1, setLine1] = useState(target.addressLine1 ?? '')
  const [line2, setLine2] = useState(target.addressLine2 ?? '')
  const [city, setCity] = useState(target.addressCity ?? '')
  const [state, setState] = useState(target.addressState ?? '')
  const [postalCode, setPostalCode] = useState(target.addressPostalCode ?? '')
  const [country, setCountry] = useState(target.addressCountry ?? 'US')
  const [businessHoursDays, setBusinessHoursDays] = useState(() => initialDaysFromHours(target.businessHours))
  const initialHoursSnapshot = JSON.stringify(target.businessHours ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Snapshot of the initial address so we can diff on save and skip the
  // Square update when nothing changed. Captured once at mount from the
  // same row values used to seed the inputs above.
  const initialAddress = {
    line1: target.addressLine1 ?? '',
    line2: target.addressLine2 ?? '',
    city: target.addressCity ?? '',
    state: target.addressState ?? '',
    postalCode: target.addressPostalCode ?? '',
    country: target.addressCountry ?? 'US',
  }

  // Address section is visible whenever a Square-related interaction is
  // possible: the row is already linked (address changes mirror to Square),
  // or the operator has ticked the link-to-Square box (address is required
  // to create the Square entry).
  const showAddress = isSquareLinked || (canLinkToSquare && linkToSquare)
  const addressComplete =
    line1.trim() !== '' &&
    city.trim() !== '' &&
    state.trim() !== '' &&
    postalCode.trim() !== '' &&
    country.trim().length === 2
  // For an already-linked row the fields are pre-populated with Square's
  // current values. We only send the address in the update if the operator
  // actually changed something — that way an untouched Save is cheap
  // (no wasted Square API call) and honest (we know it wasn't the operator
  // intending "make it exactly like this again").
  const addressChanged =
    isSquareLinked &&
    (line1.trim() !== initialAddress.line1 ||
      line2.trim() !== initialAddress.line2 ||
      city.trim() !== initialAddress.city ||
      state.trim() !== initialAddress.state ||
      postalCode.trim() !== initialAddress.postalCode ||
      country.trim().toUpperCase() !== initialAddress.country.toUpperCase())

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const nameChanged = name.trim() !== target.name
      const tzChanged = timezone.trim() !== target.timezone
      const hoursChanged = JSON.stringify(daysToBusinessHours(businessHoursDays)) !== initialHoursSnapshot
      // For a link-to-Square save the address is required and always sent.
      // For an already-linked row, only sent if it actually differs from
      // what Square currently has.
      const sendAddress = (canLinkToSquare && linkToSquare) || addressChanged
      const payload = {
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(tzChanged ? { timezone: timezone.trim() } : {}),
        ...(sendAddress
          ? {
            address: {
              line1: line1.trim(),
              ...(line2.trim() ? { line2: line2.trim() } : {}),
              city: city.trim(),
              state: state.trim(),
              postalCode: postalCode.trim(),
              country: country.trim().toUpperCase(),
            },
          }
          : {}),
        ...(hoursChanged ? { businessHours: daysToBusinessHours(businessHoursDays) } : {}),
        ...(canLinkToSquare && linkToSquare ? { linkToSquare: true } : {}),
      }
      const result = await updateAdminLocation(target.id, payload)
      onSaved(result.location, result.syncedToSquare)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save location.')
      setBusy(false)
    }
  }

  const submitLabel = busy
    ? 'Saving…'
    : canLinkToSquare && linkToSquare
      ? 'Save + link to Square'
      : isSquareLinked
        ? 'Save + sync to Square'
        : 'Save'

  const submitDisabled =
    busy ||
    name.trim().length === 0 ||
    timezone.trim().length === 0 ||
    (canLinkToSquare && linkToSquare && !addressComplete)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${target.name}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 40,
        overflowY: 'auto',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="card modal-card-scroll" style={{ maxWidth: 560, width: '100%', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Edit "{target.name}"</h2>
          <button
            className="btn btn-ghost"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            style={{ minHeight: 32, minWidth: 32, padding: 4 }}
            type="button"
          >
            ✕
          </button>
        </div>

        {error && <ModalError message={error} />}

        <div className="stack" style={{ gap: 14 }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="ed-name">Name</label>
            <input id="ed-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label>Type</label>
            <p style={{ margin: 0, fontSize: '0.85rem' }}>
              {target.kind === 'MARKET' ? 'Market' : 'Warehouse'}
            </p>
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="ed-tz">Timezone</label>
            <input id="ed-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} autoComplete="off" />
            <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              IANA name (e.g. America/New_York).
            </p>
          </div>

          {canLinkToSquare && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-raised)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={linkToSquare}
                onChange={(e) => setLinkToSquare(e.target.checked)}
              />
              <span style={{ flex: 1, fontSize: '0.88rem' }}>
                Link this location to Square on save (creates it in Square using the address below)
              </span>
            </label>
          )}

          {showAddress && (
            <>
              <div className="section-heading" style={{ margin: '4px 0 0' }}>
                <h3 style={{ margin: 0, fontSize: '0.85rem' }}>
                  {canLinkToSquare && linkToSquare ? 'Address (required to link to Square)' : 'Address at Square'}
                </h3>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="ed-line1">Street</label>
                <input id="ed-line1" value={line1} onChange={(e) => setLine1(e.target.value)} autoComplete="off" />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="ed-line2">
                  Suite / unit <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span>
                </label>
                <input id="ed-line2" value={line2} onChange={(e) => setLine2(e.target.value)} autoComplete="off" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="ed-city">City</label>
                  <input id="ed-city" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="off" />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="ed-state">State / region</label>
                  <input id="ed-state" value={state} onChange={(e) => setState(e.target.value)} autoComplete="off" />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="ed-zip">Postal code</label>
                  <input id="ed-zip" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} autoComplete="off" />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="ed-country">Country</label>
                  <input id="ed-country" value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} autoComplete="off" />
                  <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                    ISO 3166-1 alpha-2 (US, GB, CA…). The UK is <strong>GB</strong>.
                  </p>
                </div>
              </div>
            </>
          )}

          <div className="section-heading" style={{ margin: '4px 0 0' }}>
            <h3 style={{ margin: 0, fontSize: '0.85rem' }}>
              Business hours <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span>
            </h3>
          </div>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-dim)' }}>
            Toggle a day on and set open + close times. Unchecked days count as closed.
            {isSquareLinked && ' Changes are mirrored to Square in the same save.'}
          </p>
          <BusinessHoursEditor days={businessHoursDays} onChange={setBusinessHoursDays} />

          {(isSquareLinked || (canLinkToSquare && linkToSquare)) && (
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              {canLinkToSquare && linkToSquare
                ? 'A new Square location will be created and its id stored here.'
                : 'Changes to name, timezone, address and business hours are mirrored to Square in the same call.'}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
            <button className="btn" onClick={onClose} disabled={busy} type="button">
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={submitDisabled}
              style={{ width: 'auto', paddingLeft: 20, paddingRight: 20 }}
              type="button"
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function LocationsAdminPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER']}>
      <LocationsAdminBody />
    </RequireAuth>
  )
}
