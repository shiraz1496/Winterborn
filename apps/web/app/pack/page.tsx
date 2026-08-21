'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { LocationDto, RestockRequestDto } from '@winterborn/shared'
import { RequireAuth } from '../../components/RequireAuth'
import { ApiError, listLocations, listRequests } from '../../lib/api'

function PackIndexBody() {
  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([listRequests(), listLocations()])
      .then(([r, l]) => {
        setRequests(r)
        setLocations(l)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load requests.'))
      .finally(() => setLoading(false))
  }, [])

  const locationName = useMemo(() => {
    const map = new Map(locations.map((l) => [l.id, l.name]))
    return (id: string) => map.get(id) ?? id
  }, [locations])

  const packable = requests.filter((r) => r.state === 'OPEN' || r.state === 'PACKING')

  return (
    <div>
      {error && <p className="error-banner">{error}</p>}
      <p className="eyebrow" style={{ marginBottom: 16 }}>
        Requests ready to pack
      </p>
      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : packable.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing to pack</p>
          <p className="empty-state-body">Open a request from the Requests tab to get it moving.</p>
        </div>
      ) : (
        <div className="list">
          {packable.map((r) => (
            <Link key={r.id} href={`/pack/${r.id}`} className="list-row">
              <div className="list-row-body">
                <div className="list-row-title">{locationName(r.locationId)}</div>
                <div className="list-row-meta">
                  {r.lines.length} line{r.lines.length === 1 ? '' : 's'}
                </div>
              </div>
              <span className={`chip ${r.state === 'PACKING' ? 'chip-signal' : ''}`}>{r.state.toLowerCase()}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PackIndexPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE', 'OPERATOR']}>
      <PackIndexBody />
    </RequireAuth>
  )
}
