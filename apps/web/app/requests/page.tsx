'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { LocationDto, RestockRequestDto } from '@winterborn/shared'
import { RequireAuth } from '../../components/RequireAuth'
import { ApiError, listLocations, listRequests } from '../../lib/api'

const STATE_FILTERS = ['ALL', 'OPEN', 'PACKING', 'DISPATCHED', 'CLOSED'] as const
type StateFilter = (typeof STATE_FILTERS)[number]

function chipClassFor(state: string): string {
  if (state === 'DISPATCHED' || state === 'ARRIVED' || state === 'CLOSED') return 'chip chip-pine'
  if (state === 'PACKING') return 'chip chip-signal'
  return 'chip'
}

function RequestsBody() {
  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [filter, setFilter] = useState<StateFilter>('ALL')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([listRequests(), listLocations()])
      .then(([r, l]) => {
        if (cancelled) return
        setRequests(r)
        setLocations(l)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load requests.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const locationName = useMemo(() => {
    const map = new Map(locations.map((l) => [l.id, l.name]))
    return (id: string) => map.get(id) ?? id
  }, [locations])

  const filtered =
    filter === 'ALL'
      ? requests
      : requests.filter((r) =>
          filter === 'CLOSED' ? r.state === 'CLOSED' || r.state === 'ARRIVED' : r.state === filter,
        )

  return (
    <div>
      {error && <p className="error-banner">{error}</p>}

      <Link href="/requests/new" className="btn btn-primary" style={{ marginBottom: 20 }}>
        + New request
      </Link>

      <div className="row" style={{ overflowX: 'auto', paddingBottom: 4, marginBottom: 16 }}>
        {STATE_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className="chip"
            style={{
              cursor: 'pointer',
              background: filter === s ? 'var(--signal)' : 'transparent',
              color: filter === s ? 'var(--signal-ink)' : 'var(--text-dim)',
              borderColor: filter === s ? 'var(--signal)' : 'var(--line-strong)',
              flexShrink: 0,
            }}
          >
            {s.toLowerCase()}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing here</p>
          <p className="empty-state-body">No requests match this filter yet.</p>
        </div>
      ) : (
        <div className="list">
          {filtered.map((r) => (
            <Link key={r.id} href={`/requests/${r.id}`} className="list-row">
              <div className="list-row-body">
                <div className="list-row-title">{locationName(r.locationId)}</div>
                <div className="list-row-meta">
                  {r.lines.length} line{r.lines.length === 1 ? '' : 's'} ·{' '}
                  {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </div>
              </div>
              <span className={chipClassFor(r.state)}>{r.state.toLowerCase()}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RequestsPage() {
  return (
    <RequireAuth>
      <RequestsBody />
    </RequireAuth>
  )
}
