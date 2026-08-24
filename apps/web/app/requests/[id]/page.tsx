'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import type {
  LocationDto,
  RequestLineAnalysis,
  RequestState,
  RestockRequestDto,
  VariationSummary,
} from '@winterborn/shared'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { Swatch } from '../../../components/Swatch'
import { useToast } from '../../../lib/toast'
import {
  ApiError,
  getRequest,
  getRequestAnalysis,
  listLocations,
  listVariations,
  transitionRequest,
  updateRequestLine,
} from '../../../lib/api'

const EDITABLE_STATES: RequestState[] = ['DRAFT', 'OPEN']

const NEXT_TRANSITION: Partial<Record<RequestState, { to: RequestState; label: string }>> = {
  DRAFT: { to: 'OPEN', label: 'Open request' },
  OPEN: { to: 'PACKING', label: 'Start packing' },
  PACKING: { to: 'DISPATCHED', label: 'Mark dispatched' },
  DISPATCHED: { to: 'CLOSED', label: 'Close request' },
  ARRIVED: { to: 'CLOSED', label: 'Close request' },
}

const FLOW: RequestState[] = ['DRAFT', 'OPEN', 'PACKING', 'DISPATCHED', 'CLOSED']

function RequestDetailBody() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const toast = useToast()
  const [request, setRequest] = useState<RestockRequestDto | null>(null)
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [analysis, setAnalysis] = useState<RequestLineAnalysis[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const [r, l, v, a] = await Promise.all([
        getRequest(params.id),
        listLocations(),
        listVariations(),
        getRequestAnalysis(params.id).catch(() => [] as RequestLineAnalysis[]),
      ])
      setRequest(r)
      setLocations(l)
      setVariations(v)
      setAnalysis(a)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this request.')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id])

  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations])
  const analysisByLine = useMemo(() => new Map(analysis.map((a) => [a.lineId, a])), [analysis])
  const locationName = locations.find((l) => l.id === request?.locationId)?.name ?? request?.locationId

  async function setQty(lineId: string, qty: number) {
    if (!request || qty < 1) return
    setBusy(true)
    try {
      await updateRequestLine(request.id, lineId, { qtyRequested: qty })
      await load()
      toast.success(`Quantity updated to ${qty}`)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not update that line.'
      setError(msg)
      toast.error(msg)
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
        toast.success('Request opened for packing')
        router.push(`/pack/${request.id}`)
        return
      }
      await load()
      toast.success(`Request ${to.toLowerCase()}`)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'That transition was refused.'
      setError(msg)
      toast.error(msg)
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
  const currentStepIdx = FLOW.indexOf(request.state)

  return (
    <div>
      <PageHeader
        eyebrow={`${request.createdFrom.toLowerCase()} request · ${new Date(request.createdAt).toLocaleDateString()}`}
        title={locationName ?? 'Request'}
        description="Each line is one colour family this market needs. Adjust the quantity, review the recommendation, then move the request to the next step."
      />

      <div className="step-track" aria-label="Request workflow">
        {FLOW.map((s, i) => (
          <Fragment key={s}>
            {i > 0 && <span className="step-arrow">→</span>}
            <span
              className={`step ${
                i < currentStepIdx ? 'step-done' : i === currentStepIdx ? 'step-current' : ''
              }`}
            >
              {s.toLowerCase()}
            </span>
          </Fragment>
        ))}
      </div>

      {error && <p className="error-banner">{error}</p>}

      <div className="section-heading">
        <h2>Lines</h2>
        <span className="eyebrow">{request.lines.length}</span>
      </div>
      <p className="section-desc">
        One row per colour family. Adjust the requested quantity with − / +. If the system has a recommendation it
        appears as a chip; tap the (?) for what it&apos;s based on. A red &quot;would starve&quot; warning means fulfilling this
        line in full would leave other markets short of the same family.
      </p>
      <div className="list" style={{ marginBottom: 24 }}>
        {request.lines.map((line) => {
          const meta = variationById.get(line.variationId)
          const a = analysisByLine.get(line.id)
          const rec = a?.recommendation
          const alloc = a?.allocation
          return (
            <div key={line.id} className="list-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <Swatch familyName={meta?.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">{meta?.itemGroupName ?? line.variationId}</div>
                <div className="list-row-meta">
                  {meta?.colourFamilyName} · {meta?.sizeOptionName}
                </div>
                {(rec || alloc) && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {rec && rec.qty != null && rec.qty !== line.qtyRequested && (
                      <>
                        <span
                          className={rec.qty < line.qtyRequested ? 'chip chip-signal' : 'chip chip-pine'}
                        >
                          Recommend {rec.qty}
                        </span>
                        <InfoTooltip label="How this recommendation was calculated">
                          <strong>Peak-week velocity</strong> at this market: <span className="mono">{rec.minLevel ?? '—'}</span>
                          <br />
                          <strong>Current on-hand</strong>: <span className="mono">{rec.onHand}</span>
                          {rec.weeksRemaining != null && (
                            <>
                              <br />
                              <strong>Weeks left in season</strong>: <span className="mono">{rec.weeksRemaining}</span>
                            </>
                          )}
                          <br />
                          The recommendation aims to cover the next two weeks of peak demand, minus what&apos;s already on
                          the shelf. Style level only — never colour.
                        </InfoTooltip>
                      </>
                    )}
                    {rec && rec.qty == null && (
                      <>
                        <span className="chip">No baseline</span>
                        <InfoTooltip label="Why no recommendation">
                          No threshold is configured for this family at this market yet. Run the threshold seeder, or
                          set one manually, before the system can recommend a quantity.
                        </InfoTooltip>
                      </>
                    )}
                    {alloc?.wouldStarveOthers && (
                      <>
                        <span className="chip chip-rust">
                          Would starve {alloc.otherLocationCount} other
                          {alloc.otherLocationCount === 1 ? '' : 's'}
                        </span>
                        <InfoTooltip label="Why this line risks starving other markets">
                          <strong>Warehouse on-hand</strong>: <span className="mono">{alloc.warehouseOnHand}</span>
                          <br />
                          <strong>Claimed by other markets</strong>: <span className="mono">{alloc.otherOpenDemand}</span>
                          {' across '}
                          {alloc.otherLocationCount} location{alloc.otherLocationCount === 1 ? '' : 's'}
                          <br />
                          Sending {line.qtyRequested} to this market would leave less than what&apos;s already
                          promised elsewhere. Consider a smaller quantity, or make sure a bigger intake is on the way.
                        </InfoTooltip>
                      </>
                    )}
                  </div>
                )}
              </div>
              {editable ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {rec && rec.qty != null && rec.qty !== line.qtyRequested && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => setQty(line.id, rec.qty!)}
                      disabled={busy}
                      title="Set to the system's recommended quantity"
                    >
                      Use rec
                    </button>
                  )}
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
