'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import type {
  BoxDto,
  BoxLabelDto,
  LocationDto,
  RequestLineAnalysis,
  RequestState,
  RestockRequestDto,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { BoxLabel } from '../../../components/BoxLabel'
import { CopyButton } from '../../../components/CopyButton'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { PageHeader } from '../../../components/PageHeader'
import { SectionHeading } from '../../../components/SectionHeading'
import { RequireAuth } from '../../../components/RequireAuth'
import { Scanner } from '../../../components/Scanner'
import { ProductThumb, firstPhoto } from '../../../components/ProductThumb'
import { useAuth } from '../../../lib/auth-context'
import { printLabelElement } from '../../../lib/print-label'
import { useToast } from '../../../lib/toast'
import {
  ApiError,
  getBoxLabel,
  getRequest,
  getRequestAnalysis,
  listBoxes,
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
  const [boxes, setBoxes] = useState<BoxDto[]>([])
  const [labels, setLabels] = useState<Record<string, BoxLabelDto>>({})
  const [openLabelBoxIds, setOpenLabelBoxIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openFamilyId, setOpenFamilyId] = useState<string | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)

  async function load() {
    try {
      const [r, l, v, wv, a, b] = await Promise.all([
        getRequest(params.id),
        listLocations(),
        listVariations(),
        listWarehouseVariants(),
        getRequestAnalysis(params.id).catch(() => [] as RequestLineAnalysis[]),
        listBoxes({ requestId: params.id }).catch(() => [] as BoxDto[]),
      ])
      setRequest(r)
      setLocations(l)
      setVariations(v)
      setWarehouseVariants(wv)
      setAnalysis(a)
      setBoxes(b)
      // Default: every box's QR label is open. Fetch them in parallel
      // so operators land on the request page and see all the QRs
      // without an extra click each. Only warehouse-side roles use
      // this section anyway (labels are printed at pack time), so a
      // few extra label fetches on a request with 5-10 boxes is fine.
      if (b.length > 0) {
        setOpenLabelBoxIds(new Set(b.map((box) => box.id)))
        void Promise.all(
          b.map((box) =>
            getBoxLabel(box.id)
              .then((label) => ({ id: box.id, label }))
              .catch(() => null),
          ),
        ).then((results) => {
          const next: Record<string, BoxLabelDto> = {}
          for (const r of results) {
            if (r) next[r.id] = r.label
          }
          setLabels((prev) => ({ ...prev, ...next }))
        })
      }
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
  /// Grouped by variation so a family card can pull the first non-null
  /// photo across its variants for the thumbnail (same pattern as pack /
  /// shipment views).
  const warehouseVariantsByVariation = useMemo(() => {
    const m = new Map<string, WarehouseVariantSummary[]>()
    for (const wv of warehouseVariants) {
      const list = m.get(wv.variationId) ?? []
      list.push(wv)
      m.set(wv.variationId, list)
    }
    return m
  }, [warehouseVariants])
  const analysisByLine = useMemo(() => new Map(analysis.map((a) => [a.lineId, a])), [analysis])

  /// Per-request-line: how many units the warehouse actually packed +
  /// dispatched FOR THIS REQUEST. Multi-request boxes carry lines that
  /// belong to sibling requests too; we filter by the line's own
  /// requestId (falling back to Box.requestId for the single-request
  /// path) so a shared box doesn't double-count.
  ///
  /// Request lines are at the family (Variation) level; a
  /// warehouse-variant-specific line matches only its own SKU, a
  /// family-level line matches every SKU under that variation.
  const shippedByLine = useMemo(() => {
    const wvVariationById = new Map(warehouseVariants.map((wv) => [wv.id, wv.variationId]))
    const out = new Map<string, number>()
    if (!request) return out
    for (const line of request.lines) {
      let shipped = 0
      for (const box of boxes) {
        for (const boxLine of box.lines) {
          // Only credit lines that are actually owned by this request.
          const lineRequestId = boxLine.requestId ?? box.requestId ?? null
          if (lineRequestId !== request.id) continue
          if (line.warehouseVariantId) {
            if (boxLine.warehouseVariantId === line.warehouseVariantId) shipped += boxLine.quantity
          } else {
            if (wvVariationById.get(boxLine.warehouseVariantId) === line.variationId) {
              shipped += boxLine.quantity
            }
          }
        }
      }
      out.set(line.id, shipped)
    }
    return out
  }, [request, boxes, warehouseVariants])

  const packingHasStarted = request
    ? request.state === 'PACKING' ||
      request.state === 'DISPATCHED' ||
      request.state === 'ARRIVED' ||
      request.state === 'CLOSED'
    : false

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

  /// Toggle a single box's QR label. Labels are eagerly fetched on
  /// page load and open by default (see `load()`), so this handler
  /// just flips visibility in-place; the label data is already in
  /// state. Kept as an async fallback for the rare case a label wasn't
  /// prefetched (network hiccup during load).
  async function toggleBoxLabel(boxId: string) {
    setOpenLabelBoxIds((prev) => {
      const next = new Set(prev)
      if (next.has(boxId)) next.delete(boxId)
      else next.add(boxId)
      return next
    })
    if (labels[boxId]) return
    try {
      const label = await getBoxLabel(boxId)
      setLabels((prev) => ({ ...prev, [boxId]: label }))
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load the label.'
      toast.error(msg)
      setOpenLabelBoxIds((prev) => {
        const next = new Set(prev)
        next.delete(boxId)
        return next
      })
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

      <SectionHeading
        title="Items requested"
        description={
          <>
            One card per product family. Tap a card to see the specific variants and quantities that were requested.
            {editable && ' Steppers to adjust quantities appear inside each variant row.'}
          </>
        }
        right={
          <span className="eyebrow">
            {(() => {
              const familyCount = new Set(request.lines.map((l) => l.variationId)).size
              return `${familyCount} item${familyCount === 1 ? '' : 's'} · ${request.lines.length} line${request.lines.length === 1 ? '' : 's'}`
            })()}
          </span>
        }
      />
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
                  {/* Row as a clickable div (role="button") rather than a
                      real `<button>` so we can safely nest the CopyButton
                      inside for the product name — button-in-button is
                      invalid HTML. Keyboard accessibility preserved via
                      tabIndex + Enter/Space handlers. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenFamilyId(open ? null : variationId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setOpenFamilyId(open ? null : variationId)
                      }
                    }}
                    aria-expanded={open}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      width: '100%',
                      cursor: 'pointer',
                    }}
                  >
                    <ProductThumb
                      photoUrl={firstPhoto(warehouseVariantsByVariation.get(variationId) ?? [])}
                      familyName={familyMeta?.colourFamilyName ?? ''}
                      alt={familyMeta?.itemGroupName ?? ''}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span
                          className="list-row-title"
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {familyMeta?.itemGroupName ?? variationId}
                        </span>
                        {familyMeta?.itemGroupName && (
                          <CopyButton
                            text={familyMeta.itemGroupName}
                            label="Copy product name"
                            size="sm"
                          />
                        )}
                      </div>
                      <div className="list-row-meta">
                        {familyMeta?.colourFamilyName} · {familyMeta?.sizeOptionName}
                        {' · '}
                        {lines.length} variant{lines.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="mono" style={{ fontWeight: 700, fontSize: '1.1rem' }}>{total}</div>
                      {/* Larger chevron — the previous ▴/▾ characters
                          were tiny in the dim `eyebrow` styling and
                          invisible on some displays. */}
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        aria-hidden="true"
                        style={{
                          color: 'var(--text-dim)',
                          transition: 'transform 0.15s',
                          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                          flexShrink: 0,
                        }}
                      >
                        <path
                          d="M3 5l4 4 4-4"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  </div>

                  {open && (
                    <div className="stack" style={{ marginTop: 14, gap: 8 }}>
                      {lines.map((line) => {
        const meta = variationById.get(line.variationId)
        const a = analysisByLine.get(line.id)
        const rec = a?.recommendation
        const alloc = a?.allocation
        return (
          <div key={line.id} className="list-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', border: '1px solid var(--line)' }}>
              {(() => {
                const wv = line.warehouseVariantId
                  ? warehouseVariantById.get(line.warehouseVariantId)
                  : undefined
                // Variant-level line: use that specific SKU's photo.
                // Family-level line: fall back to the first photo across
                // the family's variants so the row isn't blank.
                const photoUrl = wv
                  ? wv.photoUrl
                  : firstPhoto(warehouseVariantsByVariation.get(line.variationId) ?? [])
                const familyName = wv?.colourVariantName ?? meta?.colourFamilyName ?? ''
                return (
                  <ProductThumb
                    photoUrl={photoUrl}
                    familyName={familyName}
                    alt={wv?.colourVariantName ?? meta?.itemGroupName ?? ''}
                  />
                )
              })()}
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
                {packingHasStarted && (() => {
                  const shipped = shippedByLine.get(line.id) ?? 0
                  const requested = line.qtyRequested
                  if (shipped >= requested) {
                    return (
                      <div style={{ marginTop: 6 }}>
                        <span className="chip chip-pine">Shipped {shipped}</span>
                      </div>
                    )
                  }
                  if (shipped === 0) {
                    return (
                      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="chip chip-rust">Not shipped</span>
                        <span style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>
                          Warehouse didn&apos;t include this item.
                        </span>
                      </div>
                    )
                  }
                  return (
                    <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="chip chip-signal">
                        Short — {shipped} of {requested} shipped
                      </span>
                    </div>
                  )
                })()}
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
      <Scanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        expectedRequestId={request.id}
        onScanned={(res) => {
          setScannerOpen(false)
          const boxLabel = res.box.qrToken.slice(0, 8).toUpperCase()
          // Summarise what's actually in the box so the operator sees
          // the truth of what landed at the market (not just a count).
          // Truncated to keep the toast readable — full contents are
          // still visible on the request page's Boxes section.
          const contentsSummary = res.box.contents.length === 0
            ? ''
            : res.box.contents.length <= 2
              ? ` (${res.box.contents.map((c) => `${c.colourVariantName} ×${c.quantity}`).join(', ')})`
              : ` (${res.box.contents
                  .slice(0, 2)
                  .map((c) => `${c.colourVariantName} ×${c.quantity}`)
                  .join(', ')} + ${res.box.contents.length - 2} more)`

          const multi = res.requests.length > 1
          const closed = res.requests.filter((r) => r.closed).map((r) => `#${r.id.slice(0, 6)}`)
          const advanced = res.requests
            .filter((r) => !r.closed)
            .map((r) => `#${r.id.slice(0, 6)} (${r.boxesReceived}/${r.boxesTotal})`)
          const summary = [
            closed.length > 0 ? `closed ${closed.join(', ')}` : null,
            advanced.length > 0 ? `advanced ${advanced.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join(' · ')

          if (res.box.alreadyReceived) {
            toast.info(`Box ${boxLabel} was already received.`)
          } else if (multi) {
            toast.success(`Box ${boxLabel} received${contentsSummary} — ${summary}`)
          } else if (res.request?.closed) {
            toast.success(`Box ${boxLabel} received${contentsSummary} — request closed.`)
          } else if (res.request) {
            toast.success(
              `Box ${boxLabel} received${contentsSummary} — ${res.request.boxesReceived} of ${res.request.boxesTotal} in.`,
            )
          } else {
            toast.success(`Box ${boxLabel} received${contentsSummary}.`)
          }
          void load()
        }}
      />

      {(() => {
        // Boxes section — visible for warehouse-side roles + owner once
        // packing has produced any boxes. Each box has a "Show QR label"
        // button that lazy-fetches the label and expands the printable
        // BoxLabel component inline. From here the operator can print or
        // reprint the QR after dispatch without needing to bounce back to
        // /pack/[requestId].
        if (!user || boxes.length === 0) return null
        const warehouseRoles: AppRole[] = ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']
        if (!warehouseRoles.includes(user.role as AppRole)) return null

        /// Shared boxes live in the shipment view — one QR covers the
        /// whole group, so surfacing it under a single request would
        /// duplicate it across each grouped request's detail page. Only
        /// show boxes that are exclusively this request's. Anything
        /// shared is redirected via a shipment link at the top of the
        /// list.
        const isSharedBox = (box: (typeof boxes)[number]) => {
          const ids = new Set<string>()
          if (box.requestId) ids.add(box.requestId)
          for (const line of box.lines) if (line.requestId) ids.add(line.requestId)
          if (ids.size === 0) return false
          for (const id of ids) if (id !== request.id) return true
          return false
        }
        const soloBoxes = boxes.filter((b) => !isSharedBox(b))
        const sharedBoxes = boxes.filter(isSharedBox)

        // Build the shipment link from every distinct request touched
        // by any of the shared boxes so one link covers them all.
        const groupedIds = new Set<string>([request.id])
        for (const box of sharedBoxes) {
          if (box.requestId) groupedIds.add(box.requestId)
          for (const line of box.lines) if (line.requestId) groupedIds.add(line.requestId)
        }
        const shipmentHref = `/requests/shipment?ids=${[...groupedIds]
          .map((id) => encodeURIComponent(id))
          .join(',')}`

        if (soloBoxes.length === 0 && sharedBoxes.length === 0) return null

        return (
          <div className="section" style={{ marginTop: 24 }}>
            <SectionHeading
              title="Boxes"
              description={
                soloBoxes.length === 0
                  ? 'No boxes exclusive to this request — every box is shared with the shipment above.'
                  : 'Every packed box for this request. Show the QR label to print, reprint, or hand to the market manager to scan on arrival.'
              }
              right={
                <span className="eyebrow">
                  {soloBoxes.length} box{soloBoxes.length === 1 ? '' : 'es'}
                  {sharedBoxes.length > 0 ? ` · ${sharedBoxes.length} in shared shipment` : ''}
                </span>
              }
            />
            {sharedBoxes.length > 0 && (
              <div
                className="card"
                style={{ padding: 12, marginBottom: 12, borderColor: 'var(--pine)' }}
              >
                <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>
                      {sharedBoxes.length} box{sharedBoxes.length === 1 ? '' : 'es'} shared with{' '}
                      {groupedIds.size - 1} other request
                      {groupedIds.size - 1 === 1 ? '' : 's'}
                    </strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: 2 }}>
                      QR labels for shared boxes live on the shipment view so one label
                      isn't printed from three places.
                    </div>
                  </div>
                  <Link href={shipmentHref} className="btn">
                    → Open shipment
                  </Link>
                </div>
              </div>
            )}
            <div className="stack" style={{ gap: 10 }}>
              {soloBoxes.map((box) => {
                const isOpen = openLabelBoxIds.has(box.id)
                const label = labels[box.id]
                return (
                  <div key={box.id} className="card" style={{ padding: 12 }}>
                    <div
                      className="row-between"
                      style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}
                    >
                      <div>
                        <div className="list-row-title mono">{box.qrToken.slice(0, 12).toUpperCase()}</div>
                        <div className="list-row-meta">
                          {box.lines.length} line{box.lines.length === 1 ? '' : 's'} · {box.state.toLowerCase()}
                          {box.arrivedAt ? ` · arrived ${new Date(box.arrivedAt).toLocaleDateString()}` : ''}
                          {(() => {
                            // Other requests this box also fulfils — surfaced
                            // so a shared physical box reads as such instead
                            // of looking like a duplicate.
                            const otherIds = new Set<string>()
                            for (const l of box.lines) {
                              if (l.requestId && l.requestId !== params.id) otherIds.add(l.requestId)
                            }
                            if (box.requestId && box.requestId !== params.id) otherIds.add(box.requestId)
                            if (otherIds.size === 0) return null
                            return (
                              <>
                                {' · also '}
                                {[...otherIds].map((id) => (
                                  <span key={id} style={{ color: 'var(--text-dim)' }}>
                                    #{id.slice(0, 6)}
                                  </span>
                                ))}
                              </>
                            )
                          })()}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void toggleBoxLabel(box.id)}
                      >
                        {isOpen ? 'Hide QR label' : 'Show QR label'}
                      </button>
                    </div>
                    {isOpen && (
                      <div id={`box-label-wrap-${box.id}`} style={{ marginTop: 14 }}>
                        {label ? (
                          <>
                            <BoxLabel label={label} />
                            <button
                              type="button"
                              className="btn btn-block no-print"
                              style={{ marginTop: 10 }}
                              onClick={() => printLabelElement(`box-label-wrap-${box.id}`)}
                            >
                              Print
                            </button>
                          </>
                        ) : (
                          <div className="screen-loading" style={{ minHeight: 120 }}>
                            <div className="spinner" aria-hidden="true" />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

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
          // Grouped-shipment guard: if any of this request's boxes also
          // carries lines for a sibling request, receiving happens at the
          // shipment level (one scan closes every grouped request). Hide
          // the per-request scan/not-received controls and point the MM at
          // the shipment view instead — otherwise the same physical box
          // would show two "Scan to receive" buttons in two places.
          const groupedRequestIds = new Set<string>()
          groupedRequestIds.add(request.id)
          for (const box of boxes) {
            if (box.requestId && box.requestId !== request.id) groupedRequestIds.add(box.requestId)
            for (const line of box.lines) {
              if (line.requestId && line.requestId !== request.id) groupedRequestIds.add(line.requestId)
            }
          }
          if (groupedRequestIds.size > 1) {
            const shipmentHref = `/requests/shipment?ids=${[...groupedRequestIds]
              .map((id) => encodeURIComponent(id))
              .join(',')}`
            return (
              <div className="stack">
                <p className="eyebrow" style={{ margin: 0, color: 'var(--text-dim)' }}>
                  Part of a shared shipment with {groupedRequestIds.size - 1} other request
                  {groupedRequestIds.size - 1 === 1 ? '' : 's'} — receive them together.
                </p>
                <Link href={shipmentHref} className="btn btn-primary">
                  → Open shipment to receive
                </Link>
              </div>
            )
          }

          const boxesReceived = boxes.filter((b) => b.state === 'ARRIVED').length
          const boxesTotal = boxes.length
          return (
            <div className="stack">
              {boxesTotal > 0 && (
                <p className="eyebrow" style={{ margin: 0, color: 'var(--text-dim)' }}>
                  {boxesReceived} of {boxesTotal} box{boxesTotal === 1 ? '' : 'es'} received
                </p>
              )}
              <button
                className="btn btn-primary"
                onClick={() => setScannerOpen(true)}
                disabled={busy}
              >
                Scan to receive
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
