'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { LocationDto, RestockRequestDto } from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
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

  // Doc 3 §3.5: bundle nearby restock needs into one dispatch run. A
  // destination with more than one packable request is a consolidation
  // candidate -- pack them together and save the second shipment.
  const consolidation = useMemo(() => {
    const groups = new Map<string, RestockRequestDto[]>()
    for (const r of packable) {
      const list = groups.get(r.locationId) ?? []
      list.push(r)
      groups.set(r.locationId, list)
    }
    return [...groups.entries()]
      .filter(([, reqs]) => reqs.length > 1)
      .map(([locationId, reqs]) => ({
        locationId,
        requests: reqs,
        totalLines: reqs.reduce((n, r) => n + r.lines.length, 0),
      }))
      .sort((a, b) => b.requests.length - a.requests.length)
  }, [packable])

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse floor"
        title="Pack"
        description="Every request that's ready to be turned into physical boxes. If multiple requests are going to the same market, the Consolidate section at the top flags them so you can combine into one dispatch."
      />

      {error && <p className="error-banner">{error}</p>}

      {consolidation.length > 0 && (
        <>
          <div className="section-heading">
            <h2>Consolidate</h2>
            <span className="eyebrow">{consolidation.length} destination{consolidation.length === 1 ? '' : 's'}</span>
          </div>
          <div className="list" style={{ marginBottom: 24 }}>
            {consolidation.map((c) => (
              <div key={c.locationId} className="list-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <div className="list-row-body">
                  <div className="list-row-title">{locationName(c.locationId)}</div>
                  <div className="list-row-meta">
                    {c.requests.length} open requests · {c.totalLines} line{c.totalLines === 1 ? '' : 's'} total ·
                    combine into one dispatch
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {c.requests.map((r) => (
                    <Link key={r.id} href={`/pack/${r.id}`} className="chip chip-pine" style={{ cursor: 'pointer' }}>
                      {r.state.toLowerCase()} · {r.lines.length}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-heading">
        <h2>Requests ready to pack</h2>
        <span className="eyebrow">{packable.length}</span>
      </div>
      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : packable.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing to pack</p>
          <p className="empty-state-body">
            A request needs to be in the Open state before it shows up here. Open one from the Requests tab.
          </p>
          <Link href="/requests" className="empty-state-cta">
            → Requests
          </Link>
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
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']}>
      <PackIndexBody />
    </RequireAuth>
  )
}
