'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import type { LocationDto, RequestState, RestockRequestDto, VariationSummary } from '@winterborn/shared'
import { RequireAuth } from '../../../components/RequireAuth'
import { Swatch } from '../../../components/Swatch'
import { ApiError, getRequest, listLocations, listVariations, transitionRequest, updateRequestLine } from '../../../lib/api'

const EDITABLE_STATES: RequestState[] = ['DRAFT', 'OPEN']

const NEXT_TRANSITION: Partial<Record<RequestState, { to: RequestState; label: string }>> = {
  DRAFT: { to: 'OPEN', label: 'Open request' },
  OPEN: { to: 'PACKING', label: 'Start packing' },
  PACKING: { to: 'DISPATCHED', label: 'Mark dispatched' },
  DISPATCHED: { to: 'CLOSED', label: 'Close request' },
  ARRIVED: { to: 'CLOSED', label: 'Close request' },
}

function RequestDetailBody() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [request, setRequest] = useState<RestockRequestDto | null>(null)
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const [r, l, v] = await Promise.all([getRequest(params.id), listLocations(), listVariations()])
      setRequest(r)
      setLocations(l)
      setVariations(v)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this request.')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id])

  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations])
  const locationName = locations.find((l) => l.id === request?.locationId)?.name ?? request?.locationId

  async function setQty(lineId: string, qty: number) {
    if (!request || qty < 1) return
    setBusy(true)
    try {
      await updateRequestLine(request.id, lineId, { qtyRequested: qty })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that line.')
    } finally {
      setBusy(false)
    }
  }

  async function doTransition(to: RequestState) {
    if (!request) return
    setBusy(true)
    setError(null)
    try {
      await transitionRequest(request.id, to)
      if (to === 'PACKING') {
        router.push(`/pack/${request.id}`)
        return
      }
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That transition was refused.')
    } finally {
      setBusy(false)
    }
  }

  if (!request) {
    return (
      <div className="screen-loading">
        {error ? <p className="error-banner">{error}</p> : <div className="spinner" aria-hidden="true" />}
      </div>
    )
  }

  const editable = EDITABLE_STATES.includes(request.state)
  const next = NEXT_TRANSITION[request.state]

  return (
    <div>
      {error && <p className="error-banner">{error}</p>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row-between" style={{ marginBottom: 6 }}>
          <h1 style={{ fontSize: '1.2rem' }}>{locationName}</h1>
          <span className="chip">{request.state.toLowerCase()}</span>
        </div>
        <p className="eyebrow" style={{ margin: 0 }}>
          {request.createdFrom.toLowerCase()} · {new Date(request.createdAt).toLocaleString()}
        </p>
      </div>

      <div className="section-heading">
        <h2>Lines</h2>
        <span className="eyebrow">{request.lines.length}</span>
      </div>
      <div className="list" style={{ marginBottom: 24 }}>
        {request.lines.map((line) => {
          const meta = variationById.get(line.variationId)
          return (
            <div key={line.id} className="list-row">
              <Swatch familyName={meta?.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">{meta?.itemGroupName ?? line.variationId}</div>
                <div className="list-row-meta">
                  {meta?.colourFamilyName} · {meta?.sizeOptionName}
                </div>
              </div>
              {editable ? (
                <div className="stepper">
                  <button
                    className="stepper-btn"
                    onClick={() => setQty(line.id, line.qtyRequested - 1)}
                    disabled={busy}
                    aria-label="Decrease"
                  >
                    −
                  </button>
                  <span className="stepper-value">{line.qtyRequested}</span>
                  <button
                    className="stepper-btn"
                    onClick={() => setQty(line.id, line.qtyRequested + 1)}
                    disabled={busy}
                    aria-label="Increase"
                  >
                    +
                  </button>
                </div>
              ) : (
                <div className="mono" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                  {line.qtyRequested}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {!editable && request.state !== 'DRAFT' && (
        <p className="eyebrow" style={{ marginBottom: 16 }}>
          Lines are locked — packing has started.
        </p>
      )}

      <div className="stack">
        {request.state === 'PACKING' && (
          <Link href={`/pack/${request.id}`} className="btn btn-primary">
            Continue packing
          </Link>
        )}
        {next && (
          <button className="btn btn-block" onClick={() => doTransition(next.to)} disabled={busy}>
            {busy ? 'Working…' : next.label}
          </button>
        )}
      </div>
    </div>
  )
}

export default function RequestDetailPage() {
  return (
    <RequireAuth>
      <RequestDetailBody />
    </RequireAuth>
  )
}
