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
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { Swatch } from '../../../components/Swatch'
import { useAuth } from '../../../lib/auth-context'
import { useToast } from '../../../lib/toast'
import {
  ApiError,
  getRequest,
  getRequestAnalysis,
  listLocations,
  listVariations,
  listWarehouseVariants,
  reportRequestMissing,
  transitionRequest,
  updateRequestLine,
} from '../../../lib/api'

const EDITABLE_STATES: RequestState[] = ['DRAFT', 'OPEN']

type AppRole = 'OWNER' | 'WAREHOUSE_MANAGER' | 'WAREHOUSE_OPERATOR' | 'MARKET_MANAGER' | 'SALES'

/// Each transition names WHO is allowed to trigger it. Doc §2/§9:
///   - DRAFT → OPEN         requester submits — MM for their market, OWNER anywhere.
///                          WM does not open requests they didn't file.
///   - OPEN → PACKING       warehouse approves + starts packing (WM, WO, OWNER).
///                          MM never sees this button.
///   - PACKING → DISPATCHED warehouse sends the box out (WM, WO, OWNER).
///   - DISPATCHED/ARRIVED → CLOSED   arrival is confirmed at the destination,
///                          so MARKET_MANAGER only. Warehouse never closes a
///                          shipment they can't physically see. OWNER kept out
///                          on purpose: closing = "market received it", and
///                          only the market can attest to that.
///
/// Buttons only render for roles in `allowed`. This is the single source of
/// truth on the UI side — matched by server-side guards in
/// RequestsService.transition/reportMissing.
const NEXT_TRANSITION: Partial<Record<RequestState, { to: RequestState; label: string; allowed: AppRole[] }>> = {
  DRAFT: { to: 'OPEN', label: 'Submit request', allowed: ['MARKET_MANAGER', 'OWNER'] },
  OPEN: { to: 'PACKING', label: 'Start packing', allowed: ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'] },
  PACKING: { to: 'DISPATCHED', label: 'Mark dispatched', allowed: ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR'] },
  DISPATCHED: { to: 'CLOSED', label: 'Received & close', allowed: ['MARKET_MANAGER'] },
  ARRIVED: { to: 'CLOSED', label: 'Received & close', allowed: ['MARKET_MANAGER'] },
}

const FLOW: RequestState[] = ['DRAFT', 'OPEN', 'PACKING', 'DISPATCHED', 'CLOSED']

function RequestDetailBody() {
  const { user } = useAuth()
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const toast = useToast()
  const [request, setRequest] = useState<RestockRequestDto | null>(null)
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [warehouseVariants, setWarehouseVariants] = useState<WarehouseVariantSummary[]>([])
  const [analysis, setAnalysis] = useState<RequestLineAnalysis[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openFamilyId, setOpenFamilyId] = useState<string | null>(null)

  async function load() {
    try {
      const [r, l, v, wv, a] = await Promise.all([
        getRequest(params.id),
        listLocations(),
        listVariations(),
        listWarehouseVariants(),
        getRequestAnalysis(params.id).catch(() => [] as RequestLineAnalysis[]),
      ])
      setRequest(r)
      setLocations(l)
      setVariations(v)
      setWarehouseVariants(wv)
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
  const warehouseVariantById = useMemo(
    () => new Map(warehouseVariants.map((wv) => [wv.id, wv])),
    [warehouseVariants],
  )
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

  async function doReportMissing() {
    if (!request) return
    setBusy(true)
    setError(null)
    try {
      await reportRequestMissing(request.id)
      toast.info('Reported not received — the warehouse manager has been notified.')
      await load()
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not report.'
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

  // Lines are editable only when both are true:
  //   1. State allows it (DRAFT or OPEN — after packing starts, the
  //      manifest is what's real; lines are history).
  //   2. Role owns the request. The requester (MM of this location) or
  //      the OWNER may edit. Warehouse never modifies what the market
  //      asked for; WO/SALES never edit anything.
  const stateAllowsEdit = EDITABLE_STATES.includes(request.state)
  const roleCanEdit =
    user?.role === 'OWNER' ||
    (user?.role === 'MARKET_MANAGER' && user.locationId === request.locationId)
  const editable = stateAllowsEdit && roleCanEdit
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
        <h2>Items requested</h2>
        <span className="eyebrow">
          {(() => {
            const familyCount = new Set(request.lines.map((l) => l.variationId)).size
            return `${familyCount} item${familyCount === 1 ? '' : 's'} · ${request.lines.length} line${request.lines.length === 1 ? '' : 's'}`
          })()}
        </span>
      </div>
      <p className="section-desc">
        One card per product family. Tap a card to see the specific variants and quantities that were requested.
        {editable && ' Steppers to adjust quantities appear inside each variant row.'}
      </p>
      {(() => {
        // Group request lines by variationId. If the same variant appears
        // more than once we still render it once with a summed qty.
        const groups = new Map<string, typeof request.lines>()
        for (const line of request.lines) {
          const list = groups.get(line.variationId) ?? []
          list.push(line)
          groups.set(line.variationId, list)
        }
        return (
          <div className="stack" style={{ marginBottom: 24 }}>
            {[...groups.entries()].map(([variationId, lines]) => {
              const familyMeta = variationById.get(variationId)
              const total = lines.reduce((s, l) => s + l.qtyRequested, 0)
              const open = openFamilyId === variationId
              return (
                <div key={variationId} className="card">
                  <button
                    type="button"
                    onClick={() => setOpenFamilyId(open ? null : variationId)}
                    style={{
                      all: 'unset',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      width: '100%',
                      cursor: 'pointer',
                    }}
                  >
                    <Swatch familyName={familyMeta?.colourFamilyName} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="list-row-title">{familyMeta?.itemGroupName ?? variationId}</div>
                      <div className="list-row-meta">
                        {familyMeta?.colourFamilyName} · {familyMeta?.sizeOptionName}
                        {' · '}
                        {lines.length} variant{lines.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="mono" style={{ fontWeight: 700, fontSize: '1.1rem' }}>{total}</div>
                      <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>{open ? '▴' : '▾'}</span>
                    </div>
                  </button>

                  {open && (
                    <div className="stack" style={{ marginTop: 14, gap: 8 }}>
                      {lines.map((line) => {
        const meta = variationById.get(line.variationId)
        const a = analysisByLine.get(line.id)
        const rec = a?.recommendation
        const alloc = a?.allocation
        return (
          <div key={line.id} className="list-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', border: '1px solid var(--line)' }}>
              <Swatch familyName={line.warehouseVariantId ? warehouseVariantById.get(line.warehouseVariantId)?.colourVariantName : meta?.colourFamilyName} />
              <div className="list-row-body">
                <div className="list-row-title">
                  {line.warehouseVariantId && warehouseVariantById.get(line.warehouseVariantId)
                    ? warehouseVariantById.get(line.warehouseVariantId)!.colourVariantName
                    : `Any ${meta?.colourFamilyName ?? 'colour'}`}
                </div>
                <div className="list-row-meta mono">
                  {line.warehouseVariantId && warehouseVariantById.get(line.warehouseVariantId)
                    ? warehouseVariantById.get(line.warehouseVariantId)!.warehouseSku
                    : meta?.sizeOptionName}
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
                  )}
                </div>
              )
            })}
          </div>
        )
      })()}

      {!editable && request.state !== 'DRAFT' && (
        <p className="eyebrow" style={{ marginBottom: 16 }}>
          Lines are locked — packing has started.
        </p>
      )}

      {/* Action strip. Split into two buttons on DISPATCHED/ARRIVED so
          the receiving side (any role that can close: MM or warehouse)
          can either confirm arrival ("Received & close" -> CLOSED) or
          flag it as missing ("Not received" -> AuditLog row +
          notification to Owner/WM). Every other state uses the single
          "next transition" button gated by role. */}
      {(() => {
        if (!user) return null
        const warehouseRoles: AppRole[] = ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']
        const canPack = warehouseRoles.includes(user.role as AppRole)
        const canTransition = next && next.allowed.includes(user.role as AppRole)
        const inTransit = request.state === 'DISPATCHED' || request.state === 'ARRIVED'
        // "Received & close" and "Not received" are destination-side actions.
        // Only the MARKET_MANAGER of this request's location can see them.
        const canReceive =
          inTransit && user.role === 'MARKET_MANAGER' && user.locationId === request.locationId

        if (canReceive) {
          return (
            <div className="stack">
              <button
                className="btn btn-primary"
                onClick={() => doTransition('CLOSED')}
                disabled={busy}
              >
                {busy ? 'Working…' : 'Received & close'}
              </button>
              <button
                className="btn btn-block btn-danger"
                onClick={doReportMissing}
                disabled={busy}
              >
                Not received
              </button>
            </div>
          )
        }

        // No packing / transition rendered while in-transit: those are
        // MM's call, not the warehouse's.
        if (inTransit) return null

        if (!canPack && !canTransition) return null

        return (
          <div className="stack">
            {request.state === 'PACKING' && canPack && (
              <Link href={`/pack/${request.id}`} className="btn btn-primary">
                Continue packing
              </Link>
            )}
            {canTransition && (
              <button className="btn btn-block" onClick={() => doTransition(next.to)} disabled={busy}>
                {busy ? 'Working…' : next.label}
              </button>
            )}
          </div>
        )
      })()}
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
