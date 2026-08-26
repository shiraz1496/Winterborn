'use client'

import { useEffect, useState } from 'react'
import type { AdminLocationDto, SyncSquareLocationsResult } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { ApiError, listAdminLocations, syncSquareLocations } from '../../../lib/api'

function LocationsAdminBody() {
  const [rows, setRows] = useState<AdminLocationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<SyncSquareLocationsResult | null>(null)

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

      <LocationTable rows={marketRows} />
    </div>
  )
}

function LocationTable({ rows }: { rows: AdminLocationDto[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-body">None yet.</p>
      </div>
    )
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Name</th>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Timezone</th>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Square location ID</th>
          <th style={{ padding: '8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Active</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
            <td style={{ padding: '8px', fontWeight: 600 }}>{r.name}</td>
            <td style={{ padding: '8px', color: 'var(--text-faint)' }}>{r.timezone}</td>
            <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '0.78rem' }}>
              {r.squareLocationId ?? <span style={{ color: 'var(--text-faint)' }}>(unlinked)</span>}
            </td>
            <td style={{ padding: '8px' }}>{r.isActive ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
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

export default function LocationsAdminPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER']}>
      <LocationsAdminBody />
    </RequireAuth>
  )
}
