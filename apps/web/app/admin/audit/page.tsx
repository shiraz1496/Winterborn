'use client'

import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { DateRangePicker } from '../../../components/DateRangePicker'
import { SearchableSelect } from '../../../components/SearchableSelect'
import { ApiError, listAudit, type AuditEntry } from '../../../lib/api'
import { useToast } from '../../../lib/toast'

/// Owner-only chronological audit trail. Merges AuditLog (state/config
/// changes) and LedgerEvent (inventory movements) into one stream so every
/// change carries its six W's: What (entity + field + old→new), Who (actor
/// + role), When (timestamp), Where (location), Why (reason/note), How
/// (source: UI / CLI / API / MIGRATION / WEBHOOK / SYSTEM).

const ENTITY_LABELS: Record<string, string> = {
  ItemGroup: 'Product',
  WarehouseVariant: 'SKU',
  ColourVariant: 'Colour',
  Category: 'Folder',
  User: 'User',
  Box: 'Box',
  Load: 'Load',
  RestockRequest: 'Request',
  Variation: 'Variation',
  Threshold: 'Threshold',
  Location: 'Location',
}

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  itemGroupName: 'product name',
  colourVariantName: 'colour',
  sizeOptionName: 'size',
  warehouseSku: 'SKU',
  unitCostCents: 'unit cost',
  photoUrls: 'photos',
  colourFamilyId: 'colour family',
  categoryId: 'folder',
  state: 'state',
  onHandCorrection: 'stock count',
  isActive: 'active status',
  role: 'role',
  password: 'password',
  locationId: 'location',
  discarded: 'status',
  dispatchedAt: 'dispatch time',
  created: '',
}

/// Ledger event types render as plain-English inventory actions.
const LEDGER_ACTION: Record<string, string> = {
  INTAKE: 'Received',
  DISPATCH: 'Dispatched',
  SALE: 'Sold',
  CORRECTION: 'Corrected stock by',
  WRITE_OFF: 'Wrote off',
  RETURN: 'Returned',
}

/// Concrete label per source enum. These are the words the owner reads
/// on every row, so they need to name the actual channel — not paraphrase.
const SOURCE_LABELS: Record<string, string> = {
  UI: 'Web app',
  API: 'API',
  CLI: 'CLI',
  MIGRATION: 'Migration',
  WEBHOOK: 'Webhook',
  SYSTEM: 'System',
  POLL: 'Square Poll',
  SCRIPT: 'Script',
}

/// Longer explanation shown in the legend so an owner glancing at
/// "System" vs "Web app" understands what each channel actually means.
const SOURCE_DESCRIPTIONS: Record<string, string> = {
  UI: 'Someone clicked a button in the web app',
  API: 'A programmatic call to the REST API',
  CLI: 'An operator ran a command-line script',
  MIGRATION: 'A one-off data migration script',
  WEBHOOK: 'An inbound Square webhook event',
  SYSTEM: 'An automated background job with no logged-in user',
  POLL: 'The Square polling worker',
  SCRIPT: 'An ad-hoc script',
}

/// Colour per source so the owner can tell channels apart at a glance
/// without reading each label. Uses the CSS variables the rest of the app
/// already ships (--pine, --rust, --signal, --line-strong) plus a neutral
/// fallback so a new source enum value never crashes the row.
const SOURCE_COLOURS: Record<string, string> = {
  UI: 'var(--pine, #4a6b52)',
  API: 'var(--signal, #6b8fb5)',
  CLI: 'var(--rust, #b56b47)',
  MIGRATION: 'var(--warn, #b58b47)',
  WEBHOOK: 'var(--signal, #6b8fb5)',
  SYSTEM: 'var(--text-faint, #999)',
  POLL: 'var(--signal, #6b8fb5)',
  SCRIPT: 'var(--rust, #b56b47)',
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  WAREHOUSE_MANAGER: 'Warehouse manager',
  WAREHOUSE_OPERATOR: 'Warehouse operator',
  MARKET_MANAGER: 'Market manager',
  SALES: 'Sales',
}

/// Category → colour used for the row's left accent bar and the small
/// action dot. Grouping actions this way lets the owner skim a busy day
/// for "creates" or "deletes" without reading every sentence.
type ActionCategory = 'CREATE' | 'UPDATE' | 'TRANSITION' | 'DELETE' | 'INVENTORY' | 'CORRECTION'

const CATEGORY_COLOURS: Record<ActionCategory, string> = {
  CREATE: 'var(--pine, #4a6b52)',
  UPDATE: 'var(--signal, #6b8fb5)',
  TRANSITION: 'var(--warn, #b58b47)',
  DELETE: 'var(--danger, #c0392b)',
  INVENTORY: 'var(--rust, #b56b47)',
  CORRECTION: 'var(--warn, #b58b47)',
}

const CATEGORY_LABELS: Record<ActionCategory, string> = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  TRANSITION: 'Transition',
  DELETE: 'Deleted',
  INVENTORY: 'Inventory',
  CORRECTION: 'Correction',
}

function categoriseAction(entry: {
  field: string
  origin: 'AUDIT_LOG' | 'LEDGER_EVENT'
}): ActionCategory {
  if (entry.origin === 'LEDGER_EVENT') {
    return entry.field === 'CORRECTION' ? 'CORRECTION' : 'INVENTORY'
  }
  if (entry.field === 'created') return 'CREATE'
  if (entry.field === 'discarded') return 'DELETE'
  if (entry.field === 'state' || entry.field === 'dispatchedAt') return 'TRANSITION'
  if (entry.field === 'onHandCorrection') return 'CORRECTION'
  return 'UPDATE'
}

/// Deterministic actor→colour so the same person always gets the same
/// avatar hue across the trail. Hash the id, wrap into a curated palette
/// (avoiding red/orange since those are reserved for action categories).
const AVATAR_PALETTE = [
  '#4a6b52', '#6b8fb5', '#8b6bb5', '#b58b47', '#4d7a89', '#8fa64d', '#a67c4d', '#7a5b8f',
]
function avatarColour(id: string | null): string {
  if (!id) return 'var(--text-faint, #999)'
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]!
}

function initials(name: string | null): string {
  if (!name) return '·'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}

/// "Today" / "Yesterday" / "Sep 1, 2026" — for the date-group headers.
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

const SOURCE_OPTIONS = ['UI', 'API', 'CLI', 'MIGRATION', 'WEBHOOK', 'SYSTEM', 'POLL', 'SCRIPT'] as const

/// Compose the "who did what" opening for a row. Falls back to "System"
/// when there's no actor (migration writes, integration polls). When the
/// display name *is* the role label (a real case in this codebase — the
/// seed owner user is literally named "Owner"), we skip the redundant
/// "Name (Role)" and just show the name.
function actorPhrase(name: string | null, role: string | null): string {
  if (name && role) {
    const roleLabel = ROLE_LABELS[role] ?? role
    if (name.toLowerCase() === roleLabel.toLowerCase()) return name
    return `${name} (${roleLabel})`
  }
  if (name) return name
  if (role) return `A ${ROLE_LABELS[role]?.toLowerCase() ?? role.toLowerCase()}`
  return 'System'
}

/// Turn a raw stored value into something a human reads without decoding.
/// Photos: JSON array → "3 photos". Money: cents → "$12.00". Role enum →
/// friendly label. FK ids (locationId, categoryId, colourFamilyId,
/// sizeOptionId, colourVariantId) return null so the caller falls back to
/// the backend-resolved display name instead of leaking a cuid.
function formatValue(field: string, value: string | null): string {
  if (value === null) return '—'
  if (field === 'photoUrls') {
    try {
      const arr = JSON.parse(value)
      if (Array.isArray(arr)) return `${arr.length} photo${arr.length === 1 ? '' : 's'}`
    } catch {
      // fall through
    }
  }
  if (field === 'unitCostCents') {
    const n = Number.parseInt(value, 10)
    if (Number.isFinite(n)) return `$${(n / 100).toFixed(2)}`
  }
  if (field === 'role') return ROLE_LABELS[value] ?? value
  if (field === 'isActive') return value === 'true' ? 'active' : 'inactive'
  if (
    field === 'colourFamilyId' ||
    field === 'categoryId' ||
    field === 'locationId' ||
    field === 'sizeOptionId' ||
    field === 'colourVariantId'
  ) {
    // The backend resolves these to display names on the audit entry;
    // when it couldn't (row deleted since), we fall through to the raw
    // value which is at worst still a stable identifier for support.
    return value.length > 12 ? '(unknown)' : value
  }
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

/// Prefer a backend-resolved display value when available; otherwise the
/// regular `formatValue`. Keeps FK ids from leaking into the UI while still
/// letting the rest of the field types benefit from client-side formatting.
function displayValue(
  field: string,
  value: string | null,
  resolved: string | null,
): string {
  if (resolved) return resolved
  return formatValue(field, value)
}

/// Produce the one-line human sentence rendered on the collapsed row.
/// Every branch returns a complete sentence so the frontend never has to
/// stitch fragments — makes localisation trivial later, and gives the
/// reader a predictable "actor + verb + object" cadence.
function summarise(entry: {
  entity: string
  entityDisplayName: string | null
  entityId: string
  field: string
  oldValue: string | null
  newValue: string | null
  oldValueDisplay: string | null
  newValueDisplay: string | null
  actorName: string | null
  actorRole: string | null
  origin: 'AUDIT_LOG' | 'LEDGER_EVENT'
  locationName: string | null
  reason: string | null
}): string {
  const who = actorPhrase(entry.actorName, entry.actorRole)
  const target = entry.entityDisplayName ?? entry.entityId
  const targetLabel = ENTITY_LABELS[entry.entity]?.toLowerCase() ?? entry.entity.toLowerCase()

  if (entry.origin === 'LEDGER_EVENT') {
    const verb = LEDGER_ACTION[entry.field] ?? entry.field.toLowerCase()
    const qty = Number.parseInt(entry.newValue ?? '0', 10)
    const abs = Number.isFinite(qty) ? Math.abs(qty) : entry.newValue
    const at = entry.locationName ? ` at ${entry.locationName}` : ''
    if (entry.field === 'CORRECTION') {
      const sign = qty > 0 ? '+' : ''
      return `${who} corrected stock by ${sign}${qty} on ${target}${at}.`
    }
    return `${who} ${verb.toLowerCase()} ${abs} of ${target}${at}.`
  }

  if (entry.field === 'created') {
    return `${who} created ${targetLabel} ${target}.`
  }

  if (entry.field === 'discarded') {
    return `${who} discarded the ${targetLabel} ${target}.`
  }

  if (entry.field === 'state') {
    return `${who} moved ${targetLabel} ${target} from ${entry.oldValue ?? '—'} to ${entry.newValue ?? '—'}.`
  }

  if (entry.field === 'onHandCorrection') {
    const at = entry.locationName ? ` at ${entry.locationName}` : ''
    return `${who} adjusted stock of ${target}${at} from ${entry.oldValue ?? '—'} to ${entry.newValue ?? '—'}.`
  }

  if (entry.field === 'password') {
    return `${who} reset the password for ${target}.`
  }

  if (entry.field === 'photoUrls') {
    const before = formatValue('photoUrls', entry.oldValue)
    const after = formatValue('photoUrls', entry.newValue)
    return `${who} updated photos on ${target} (${before} → ${after}).`
  }

  if (entry.field === 'colourFamilyId') {
    const after = entry.newValueDisplay
    return after
      ? `${who} moved the colour family of ${target} to ${after}.`
      : `${who} reassigned the colour family of ${target}.`
  }

  if (entry.field === 'categoryId') {
    const after = entry.newValueDisplay
    return after
      ? `${who} moved ${target} into the ${after} folder.`
      : `${who} moved ${target} to a different folder.`
  }

  if (entry.field === 'locationId') {
    const after = entry.newValueDisplay
    if (entry.oldValue === null && after) return `${who} assigned ${target} to ${after}.`
    if (after) return `${who} moved ${target} to ${after}.`
    return `${who} changed the location of ${target}.`
  }

  if (entry.field === 'role') {
    const before = formatValue('role', entry.oldValue)
    const after = formatValue('role', entry.newValue)
    return `${who} changed ${target}'s role from ${before} to ${after}.`
  }

  const label = FIELD_LABELS[entry.field] ?? entry.field
  const before = displayValue(entry.field, entry.oldValue, entry.oldValueDisplay)
  const after = displayValue(entry.field, entry.newValue, entry.newValueDisplay)

  // "from — to X" reads worse than "set … to X" when there was no
  // previous value; likewise the reverse for a cleared field.
  const oldMissing = entry.oldValue === null || entry.oldValue === ''
  const newMissing = entry.newValue === null || entry.newValue === ''
  if (oldMissing && !newMissing) {
    return `${who} set the ${label} of ${target} to ${after}.`
  }
  if (!oldMissing && newMissing) {
    return `${who} cleared the ${label} of ${target} (was ${before}).`
  }
  return `${who} changed the ${label} of ${target} from ${before} to ${after}.`
}

function AuditBody() {
  const toast = useToast()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Filters — kept intentionally minimal: channel + date range. Entity /
  // change type / actor id were removed after the owner review: they
  // rarely produced narrow-enough queries to be worth the toolbar space.
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [fromFilter, setFromFilter] = useState<string>('')
  const [toFilter, setToFilter] = useState<string>('')

  async function load(reset = true) {
    if (reset) setLoading(true)
    else setLoadingMore(true)
    try {
      const cursor = reset ? undefined : nextCursor ?? undefined
      const res = await listAudit({
        cursor,
        source: sourceFilter || undefined,
        from: fromFilter || undefined,
        to: toFilter || undefined,
        limit: 50,
      })
      setEntries((prev) => (reset ? res.entries : [...prev, ...res.entries]))
      setNextCursor(res.nextCursor)
      setError(null)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load the audit trail.'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, fromFilter, toFilter])

  const hasActiveFilters = sourceFilter !== '' || fromFilter !== '' || toFilter !== ''

  function resetFilters() {
    setSourceFilter('')
    setFromFilter('')
    setToFilter('')
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      <PageHeader
        eyebrow="Owner only"
        title="Audits"
        description="Every state or config change and every inventory movement, chronological. Each row answers the six W's — what, who, when, where, why, how."
      />

      {error && <p className="error-banner">{error}</p>}

      <div
        className="card"
        style={{
          padding: 14,
          marginBottom: 18,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div className="field" style={{ marginBottom: 0, minWidth: 200 }}>
          <label>Channel</label>
          <SearchableSelect
            value={sourceFilter || null}
            options={SOURCE_OPTIONS.map((s) => ({ id: s, label: SOURCE_LABELS[s] ?? s }))}
            placeholder="All channels"
            emptyMessage="No matching channel."
            onChange={(id) => setSourceFilter(id ?? '')}
            showId={false}
            allowClear
          />
        </div>

        <div className="field" style={{ marginBottom: 0, flex: '1 1 280px', minWidth: 240 }}>
          <label>Date range</label>
          <DateRangePicker
            from={fromFilter || null}
            to={toFilter || null}
            onChange={(f, t) => {
              // DateRangePicker emits ISO strings that go straight to the
              // API; the local string state stays ISO too so no conversion
              // is needed when the query fires.
              setFromFilter(f ?? '')
              setToFilter(t ?? '')
            }}
          />
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={resetFilters}
            style={{ minHeight: 38, padding: '0 12px', fontSize: '0.82rem' }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Channel legend — otherwise "System" vs "Web app" reads as jargon.
          Renders each source as a pill in the same colour and shape used on
          rows, with a one-line explanation of what that channel actually is. */}
      <details style={{ marginBottom: 16 }}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: '0.78rem',
            color: 'var(--text-dim)',
            padding: '4px 0',
          }}
        >
          What do the channel labels mean?
        </summary>
        <div
          style={{
            marginTop: 10,
            padding: 12,
            background: 'var(--surface-sunken)',
            borderRadius: 'var(--radius-md)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10,
            fontSize: '0.8rem',
          }}
        >
          {(Object.keys(SOURCE_LABELS) as Array<keyof typeof SOURCE_LABELS>).map((key) => (
            <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: `1px solid ${SOURCE_COLOURS[key] ?? 'var(--text-faint)'}`,
                  color: SOURCE_COLOURS[key] ?? 'var(--text-faint)',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {SOURCE_LABELS[key]}
              </span>
              <span style={{ color: 'var(--text-dim)', lineHeight: 1.35 }}>
                {SOURCE_DESCRIPTIONS[key]}
              </span>
            </div>
          ))}
        </div>
      </details>

      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No audit entries yet</p>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
            Nothing matches these filters. Try relaxing the date range or clearing the entity filter.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 0 }}>
          {entries.map((e, idx) => {
            const isOpen = expanded.has(e.id)
            const when = new Date(e.at)
            const sentence = summarise(e)
            const howLabel = SOURCE_LABELS[e.source] ?? e.source
            const category = categoriseAction(e)
            const accentColour = CATEGORY_COLOURS[category]
            const sourceColour = SOURCE_COLOURS[e.source] ?? 'var(--text-faint, #999)'
            const previousDayKey = idx > 0 ? dayKey(entries[idx - 1]!.at) : null
            const currentDayKey = dayKey(e.at)
            const showDayHeader = previousDayKey !== currentDayKey

            return (
              <div key={e.id}>
                {showDayHeader && (
                  <div
                    style={{
                      padding: '18px 4px 8px',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--text-dim)',
                      borderBottom: '1px solid var(--line)',
                      marginBottom: 8,
                    }}
                  >
                    {dayLabel(e.at)}
                  </div>
                )}
                <div
                  className="card"
                  style={{
                    padding: 0,
                    marginBottom: 8,
                    overflow: 'hidden',
                    borderLeft: `3px solid ${accentColour}`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleExpanded(e.id)}
                    style={{
                      all: 'unset',
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      gap: 12,
                      alignItems: 'center',
                      width: '100%',
                      padding: '12px 14px',
                      cursor: 'pointer',
                      boxSizing: 'border-box',
                    }}
                  >
                    {/* Actor avatar — deterministic colour per actor so
                        skimming a busy day shows "same person did all these"
                        without reading names. */}
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: '50%',
                        background: avatarColour(e.actorId),
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        flexShrink: 0,
                      }}
                      aria-hidden="true"
                    >
                      {initials(e.actorName)}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ lineHeight: 1.4, fontSize: '0.92rem' }}>{sentence}</div>
                      <div
                        style={{
                          marginTop: 4,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: '0.75rem',
                          color: 'var(--text-dim)',
                        }}
                      >
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '1px 8px',
                            borderRadius: 999,
                            background: 'var(--surface-sunken)',
                            fontSize: '0.68rem',
                            fontWeight: 600,
                            letterSpacing: '0.03em',
                            textTransform: 'uppercase',
                            color: accentColour,
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: accentColour,
                            }}
                            aria-hidden="true"
                          />
                          {CATEGORY_LABELS[category]}
                        </span>
                        <span className="mono">
                          {when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {e.locationName && <span>· {e.locationName}</span>}
                      </div>
                    </div>

                    {/* Source pill on the far right. Small, coloured by the
                        source enum so the eye tracks "webhook" vs "CLI" vs
                        "someone in the app" without reading. */}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        borderRadius: 999,
                        border: `1px solid ${sourceColour}`,
                        color: sourceColour,
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                    >
                      {howLabel}
                    </span>
                  </button>
                  {isOpen && (
                    <div
                      style={{
                        padding: '0 14px 14px 14px',
                        borderTop: '1px solid var(--line)',
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr',
                        gap: '6px 14px',
                        fontSize: '0.85rem',
                        paddingTop: 14,
                        background: 'var(--surface-sunken)',
                      }}
                    >
                      <dt style={{ color: 'var(--text-dim)' }}>What changed</dt>
                      <dd style={{ margin: 0 }}>
                        {FIELD_LABELS[e.field] || e.field}
                        {' on '}
                        <strong>{e.entityDisplayName ?? e.entityId}</strong>
                      </dd>
                      {e.oldValue !== null && (
                        <>
                          <dt style={{ color: 'var(--text-dim)' }}>Previous</dt>
                          <dd style={{ margin: 0, wordBreak: 'break-all' }}>
                            {displayValue(e.field, e.oldValue, e.oldValueDisplay)}
                          </dd>
                        </>
                      )}
                      {e.newValue !== null && (
                        <>
                          <dt style={{ color: 'var(--text-dim)' }}>New</dt>
                          <dd style={{ margin: 0, wordBreak: 'break-all' }}>
                            {displayValue(e.field, e.newValue, e.newValueDisplay)}
                          </dd>
                        </>
                      )}
                      <dt style={{ color: 'var(--text-dim)' }}>Who</dt>
                      <dd style={{ margin: 0 }}>
                        {(() => {
                          const name = e.actorName ?? 'System'
                          const roleLabel = e.actorRole ? ROLE_LABELS[e.actorRole] ?? e.actorRole : null
                          // Same dedupe logic as the row sentence — no "Owner — Owner".
                          if (roleLabel && name.toLowerCase() !== roleLabel.toLowerCase()) {
                            return `${name} — ${roleLabel}`
                          }
                          return name
                        })()}
                      </dd>
                      <dt style={{ color: 'var(--text-dim)' }}>When</dt>
                      <dd style={{ margin: 0 }}>{when.toLocaleString()}</dd>
                      {e.locationName && (
                        <>
                          <dt style={{ color: 'var(--text-dim)' }}>Where</dt>
                          <dd style={{ margin: 0 }}>{e.locationName}</dd>
                        </>
                      )}
                      {e.reason && (
                        <>
                          <dt style={{ color: 'var(--text-dim)' }}>Why</dt>
                          <dd style={{ margin: 0 }}>{e.reason}</dd>
                        </>
                      )}
                      <dt style={{ color: 'var(--text-dim)' }}>How</dt>
                      <dd style={{ margin: 0 }}>{howLabel}</dd>
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {nextCursor && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void load(false)}
              disabled={loadingMore}
              style={{ marginTop: 8 }}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function AuditPage() {
  return (
    <RequireAuth roles={['OWNER']}>
      <AuditBody />
    </RequireAuth>
  )
}
