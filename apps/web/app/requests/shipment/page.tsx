'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type {
  BoxDto,
  BoxLabelDto,
  LocationDto,
  RestockRequestDto,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { BoxLabel } from '../../../components/BoxLabel'
import { PageHeader } from '../../../components/PageHeader'
import { ProductThumb, firstPhoto } from '../../../components/ProductThumb'
import { RequireAuth } from '../../../components/RequireAuth'
import { Scanner } from '../../../components/Scanner'
import { useAuth } from '../../../lib/auth-context'
import { printLabelElement } from '../../../lib/print-label'
import { useToast } from '../../../lib/toast'
import {
  ApiError,
  getBoxLabel,
  getRequest,
  listBoxes,
  listLocations,
  listVariations,
  listWarehouseVariants,
  reportRequestMissing,
} from '../../../lib/api'

/// Aggregated view of a shipment — the union of several requests that
/// were packed into a shared physical box. Read-only surface: no packing,
/// no state transitions. Just "what's in this shipment" + the boxes and
/// their QR labels + a jump-back to each constituent request.

function ShipmentBody() {
  const { user } = useAuth()
  const toast = useToast()
  const searchParams = useSearchParams()
  const idsParam = searchParams.get('ids') ?? ''
  const ids = useMemo(
    () => idsParam.split(',').map((s) => s.trim()).filter(Boolean),
    [idsParam],
  )

  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [variantsByVariation, setVariantsByVariation] = useState<Map<string, WarehouseVariantSummary[]>>(new Map())
  const [boxes, setBoxes] = useState<BoxDto[]>([])
  const [labels, setLabels] = useState<Record<string, BoxLabelDto>>({})
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [openLabelBoxIds, setOpenLabelBoxIds] = useState<Set<string>>(new Set())
  const [openProductIds, setOpenProductIds] = useState<Set<string>>(new Set())
  const [scannerOpen, setScannerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  /// Ref-based cancel so `load()` can be re-called (e.g. after a scan)
  /// without racing the initial in-flight load. Each invocation stores
  /// its own flag closure and bails on state writes if superseded.
  async function reload() {
    setLoading(true)
    setError(null)
    try {
      if (ids.length === 0) {
        setError('No shipment specified.')
        return
      }
      const [reqs, locs, allVariations] = await Promise.all([
        Promise.all(ids.map((id) => getRequest(id))),
        listLocations(),
        listVariations(),
      ])
      setRequests(reqs)
      setLocations(locs)
      setVariations(allVariations)

      const destinationId = reqs[0]?.locationId
      const destBoxes = destinationId
        ? await listBoxes({ destinationLocationId: destinationId })
        : []
      const idSet = new Set(ids)
      const shipmentBoxes = destBoxes.filter((b) => {
        if (b.requestId && idSet.has(b.requestId)) return true
        for (const line of b.lines) if (line.requestId && idSet.has(line.requestId)) return true
        return false
      })
      setBoxes(shipmentBoxes)

      const uniqueVariationIds = new Set<string>()
      for (const r of reqs) for (const line of r.lines) uniqueVariationIds.add(line.variationId)
      const variationIds = [...uniqueVariationIds]
      const fetched = await Promise.all(variationIds.map((id) => listWarehouseVariants(id)))
      const byVariation = new Map<string, WarehouseVariantSummary[]>()
      variationIds.forEach((id, i) => byVariation.set(id, fetched[i]!))
      setVariantsByVariation(byVariation)

      setOpenLabelBoxIds(new Set(shipmentBoxes.map((b) => b.id)))
      const labelPromises = shipmentBoxes.map((box) =>
        getBoxLabel(box.id)
          .then((label) => ({ id: box.id, label }))
          .catch(() => null),
      )
      const settled = await Promise.all(labelPromises)
      const labelMap: Record<string, BoxLabelDto> = {}
      for (const entry of settled) if (entry) labelMap[entry.id] = entry.label
      setLabels(labelMap)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this shipment.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        if (ids.length === 0) {
          setError('No shipment specified.')
          return
        }
        // Fetch every request + all boxes across the destination + shared
        // catalog metadata. Boxes are filtered client-side to those that
        // actually touch the shipment (share a requestId with any of the
        // grouped requests).
        const [reqs, locs, allVariations] = await Promise.all([
          Promise.all(ids.map((id) => getRequest(id))),
          listLocations(),
          listVariations(),
        ])
        if (cancelled) return
        setRequests(reqs)
        setLocations(locs)
        setVariations(allVariations)

        const destinationId = reqs[0]?.locationId
        const destBoxes = destinationId
          ? await listBoxes({ destinationLocationId: destinationId })
          : []
        if (cancelled) return
        const idSet = new Set(ids)
        // A box belongs to the shipment if it's pinned to any grouped
        // request (box.requestId) OR if any of its lines carries a
        // grouped request id.
        const shipmentBoxes = destBoxes.filter((b) => {
          if (b.requestId && idSet.has(b.requestId)) return true
          for (const line of b.lines) if (line.requestId && idSet.has(line.requestId)) return true
          return false
        })
        setBoxes(shipmentBoxes)

        // Fetch warehouse variants for every variation referenced by any
        // line — dedupe across requests so shared products aren't
        // re-fetched.
        const uniqueVariationIds = new Set<string>()
        for (const r of reqs) for (const line of r.lines) uniqueVariationIds.add(line.variationId)
        const variationIds = [...uniqueVariationIds]
        const fetched = await Promise.all(variationIds.map((id) => listWarehouseVariants(id)))
        if (cancelled) return
        const byVariation = new Map<string, WarehouseVariantSummary[]>()
        variationIds.forEach((id, i) => byVariation.set(id, fetched[i]!))
        setVariantsByVariation(byVariation)

        // Auto-expand every box's QR label (matches the request detail
        // page behaviour so the operator sees labels ready to print).
        setOpenLabelBoxIds(new Set(shipmentBoxes.map((b) => b.id)))
        for (const box of shipmentBoxes) {
          getBoxLabel(box.id)
            .then((label) => {
              if (!cancelled) setLabels((prev) => ({ ...prev, [box.id]: label }))
            })
            .catch(() => {
              // Non-fatal — the box row still renders without its label.
            })
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this shipment.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [ids])

  const locationName = useMemo(() => {
    const map = new Map(locations.map((l) => [l.id, l.name]))
    return (id: string) => map.get(id) ?? id
  }, [locations])

  const variationById = useMemo(() => new Map(variations.map((v) => [v.id, v])), [variations])

  /// Merged product list across every request in the shipment. Keyed by
  /// variationId, quantity is the sum across requests. A picker/receiver
  /// looking at this view sees the shipment as a single manifest.
  const mergedLines = useMemo(() => {
    const m = new Map<string, { variationId: string; qty: number }>()
    for (const r of requests) {
      for (const line of r.lines) {
        const existing = m.get(line.variationId)
        if (existing) existing.qty += line.qtyRequested
        else m.set(line.variationId, { variationId: line.variationId, qty: line.qtyRequested })
      }
    }
    return [...m.values()].sort((a, b) => {
      const an = variationById.get(a.variationId)?.itemGroupName ?? a.variationId
      const bn = variationById.get(b.variationId)?.itemGroupName ?? b.variationId
      return an.localeCompare(bn)
    })
  }, [requests, variationById])

  const totalUnits = mergedLines.reduce((s, l) => s + l.qty, 0)

  /// Warehouse-variant → parent variation lookup, so a box line can be
  /// credited to the family it belongs to (colour variants live under
  /// one variation).
  const wvToVariation = useMemo(() => {
    const m = new Map<string, string>()
    for (const [vid, list] of variantsByVariation) {
      for (const wv of list) m.set(wv.id, vid)
    }
    return m
  }, [variantsByVariation])

  /// Received-so-far per variation. Only ARRIVED boxes count — that's
  /// stock that has physically landed at the market.
  const receivedByVariation = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of boxes) {
      if (b.state !== 'ARRIVED') continue
      for (const line of b.lines) {
        const vid = wvToVariation.get(line.warehouseVariantId)
        if (!vid) continue
        m.set(vid, (m.get(vid) ?? 0) + line.quantity)
      }
    }
    return m
  }, [boxes, wvToVariation])

  /// Sent-so-far per variation, from the warehouse's outbound POV. Any
  /// box that has left the building — DISPATCHED (in transit) or
  /// ARRIVED — counts. PACKING boxes are still on the warehouse floor
  /// so they don't count as sent.
  const sentByVariation = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of boxes) {
      if (b.state !== 'DISPATCHED' && b.state !== 'ARRIVED') continue
      for (const line of b.lines) {
        const vid = wvToVariation.get(line.warehouseVariantId)
        if (!vid) continue
        m.set(vid, (m.get(vid) ?? 0) + line.quantity)
      }
    }
    return m
  }, [boxes, wvToVariation])

  /// True when a shipment box is out but hasn't been ARRIVED yet — the
  /// operator's stock is "in receiving", not landed.
  const anyInTransit = boxes.some((b) => b.state === 'DISPATCHED')

  /// Which specific variants (SKUs) landed for a given variation, plus
  /// their arrived quantities. Used inside an expanded product row so
  /// the operator sees exactly which colour/size came in.
  const receivedVariantsByVariation = useMemo(() => {
    const wvToVariation = new Map<string, string>()
    for (const [vid, list] of variantsByVariation) {
      for (const wv of list) wvToVariation.set(wv.id, vid)
    }
    const out = new Map<string, Map<string, number>>()
    for (const b of boxes) {
      if (b.state !== 'ARRIVED') continue
      for (const line of b.lines) {
        const vid = wvToVariation.get(line.warehouseVariantId)
        if (!vid) continue
        const inner = out.get(vid) ?? new Map<string, number>()
        inner.set(line.warehouseVariantId, (inner.get(line.warehouseVariantId) ?? 0) + line.quantity)
        out.set(vid, inner)
      }
    }
    return out
  }, [boxes, variantsByVariation])

  /// Report every request in the shipment as missing. Reason lives on
  /// the ledger via the audit log; this button is the MM's escape
  /// hatch when a shared box didn't arrive.
  async function doReportMissing() {
    if (!user) return
    setBusy(true)
    setError(null)
    try {
      // Sequential so an error on one still leaves the earlier ones
      // reported. In practice the request set is 1-3 items.
      for (const r of requests) {
        await reportRequestMissing(r.id)
      }
      toast.info('Reported not received — the warehouse manager has been notified.')
      await reload()
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not report.'
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  async function toggleLabel(boxId: string) {
    setOpenLabelBoxIds((prev) => {
      const next = new Set(prev)
      if (next.has(boxId)) next.delete(boxId)
      else next.add(boxId)
      return next
    })
    if (!labels[boxId]) {
      try {
        const label = await getBoxLabel(boxId)
        setLabels((prev) => ({ ...prev, [boxId]: label }))
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load that label.')
      }
    }
  }

  if (loading) {
    return (
      <div className="screen-loading">
        {error ? <p className="error-banner">{error}</p> : <div className="spinner" aria-hidden="true" />}
      </div>
    )
  }

  if (requests.length === 0) {
    return (
      <div>
        <PageHeader eyebrow="Shipment" title="Not found" />
        <p className="error-banner">{error ?? 'No requests in this shipment.'}</p>
      </div>
    )
  }

  const destinationName = locationName(requests[0]!.locationId)

  return (
    <div>
      <PageHeader
        eyebrow={`Shipment to ${destinationName}`}
        title={`${requests.length} requests · ${totalUnits} units`}
        description="Every product across the grouped requests, merged as it lives in the shared box. The boxes below carry the QR labels — one scan by the market manager checks the whole shipment in at once."
      />

      {error && <p className="error-banner">{error}</p>}

      {(() => {
        // Scan / receive block. Same rules as the request detail page —
        // only the destination's MARKET_MANAGER sees these actions, and
        // only while the shipment is DISPATCHED or ARRIVED. Aggregated
        // across the grouped requests: any of them in-transit means the
        // shipment is in-transit.
        if (!user) return null
        const anyInTransit = requests.some((r) => r.state === 'DISPATCHED' || r.state === 'ARRIVED')
        const canReceive =
          anyInTransit &&
          user.role === 'MARKET_MANAGER' &&
          user.locationId === requests[0]!.locationId
        if (!canReceive) return null
        const boxesReceived = boxes.filter((b) => b.state === 'ARRIVED').length
        const boxesTotal = boxes.length
        return (
          <div className="stack" style={{ marginBottom: 24 }}>
            {boxesTotal > 0 && (
              <p className="eyebrow" style={{ margin: 0, color: 'var(--text-dim)' }}>
                {boxesReceived} of {boxesTotal} box{boxesTotal === 1 ? '' : 'es'} received
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setScannerOpen(true)}
              disabled={busy}
            >
              Scan to receive
            </button>
            <button
              type="button"
              className="btn btn-block btn-danger"
              onClick={doReportMissing}
              disabled={busy}
            >
              Not received
            </button>
          </div>
        )
      })()}

      <Scanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(res) => {
          const boxLabel = res.box.qrToken.slice(0, 8).toUpperCase()
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
          void reload()
        }}
      />

      <div className="section-heading">
        <h2>Products</h2>
        <span className="eyebrow">
          {mergedLines.length} product{mergedLines.length === 1 ? '' : 's'} · {totalUnits} units
        </span>
      </div>
      <div className="stack" style={{ marginBottom: 24 }}>
        {mergedLines.map((line) => {
          const meta = variationById.get(line.variationId)
          const variants = variantsByVariation.get(line.variationId) ?? []
          // Numerator label depends on the viewer's role AND the
          // shipment state. Warehouse-side users care about what's
          // gone out (sent); market-side sees "shipping" while any
          // box is still in transit (numerator = what's already left
          // the warehouse toward them) and flips to "received" once
          // every box has landed.
          const isWarehouseView =
            user?.role === 'OWNER' ||
            user?.role === 'WAREHOUSE_MANAGER' ||
            user?.role === 'WAREHOUSE_OPERATOR'
          const sent = sentByVariation.get(line.variationId) ?? 0
          const received = receivedByVariation.get(line.variationId) ?? 0
          const numerator = isWarehouseView
            ? sent
            : anyInTransit
              ? sent
              : received
          const numeratorLabel = isWarehouseView
            ? 'sent'
            : anyInTransit
              ? 'shipping'
              : 'received'
          const receivedByWv = receivedVariantsByVariation.get(line.variationId)
          const isOpen = openProductIds.has(line.variationId)
          const fullyDone = numerator >= line.qty && line.qty > 0
          // Per-request breakdown for the expanded view.
          const perRequest = requests
            .map((r) => ({
              id: r.id,
              qty: r.lines
                .filter((l) => l.variationId === line.variationId)
                .reduce((s, l) => s + l.qtyRequested, 0),
            }))
            .filter((row) => row.qty > 0)
          return (
            <div key={line.variationId} className="card" style={{ padding: 0 }}>
              <button
                type="button"
                onClick={() =>
                  setOpenProductIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(line.variationId)) next.delete(line.variationId)
                    else next.add(line.variationId)
                    return next
                  })
                }
                style={{
                  all: 'unset',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  padding: 12,
                  cursor: 'pointer',
                  boxSizing: 'border-box',
                }}
              >
                <ProductThumb
                  photoUrl={firstPhoto(variants)}
                  familyName={meta?.colourFamilyName ?? ''}
                  alt={meta?.itemGroupName ?? ''}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="list-row-title">{meta?.itemGroupName ?? line.variationId}</div>
                  <div className="list-row-meta">
                    {meta?.colourFamilyName ?? '—'} · {meta?.sizeOptionName ?? '—'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="eyebrow" style={{ color: 'var(--text-faint)', marginBottom: 2 }}>
                    {numeratorLabel} / requested
                  </div>
                  <div className="mono" style={{ fontWeight: 700, fontSize: '1rem' }}>
                    {numerator} / {line.qty}
                  </div>
                  <span className={`chip ${fullyDone ? 'chip-pine' : 'chip-signal'}`} style={{ marginTop: 2 }}>
                    {fullyDone ? numeratorLabel : `${line.qty - numerator} left`}
                  </span>
                </div>
                <span style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div style={{ padding: '0 12px 12px 12px', borderTop: '1px solid var(--line)' }}>
                  <div className="eyebrow" style={{ margin: '10px 0 6px', color: 'var(--text-dim)' }}>
                    Per-request breakdown
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {perRequest.map((row) => (
                      <div
                        key={row.id}
                        className="row-between"
                        style={{ fontSize: '0.82rem' }}
                      >
                        <Link href={`/requests/${row.id}`} className="mono" style={{ color: 'var(--text-dim)', textDecoration: 'underline' }}>
                          #{row.id.slice(0, 6)}
                        </Link>
                        <span className="mono">×{row.qty}</span>
                      </div>
                    ))}
                  </div>
                  {receivedByWv && receivedByWv.size > 0 && (
                    <>
                      <div className="eyebrow" style={{ margin: '12px 0 6px', color: 'var(--text-dim)' }}>
                        Received SKUs
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {[...receivedByWv.entries()].map(([wvId, qty]) => {
                          const wv = variants.find((v) => v.id === wvId)
                          return (
                            <div key={wvId} className="row-between" style={{ fontSize: '0.82rem' }}>
                              <span>{wv ? `${wv.colourVariantName} · ${wv.sizeOptionName}` : wvId}</span>
                              <span className="mono">×{qty}</span>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {user?.role !== 'MARKET_MANAGER' && (
        <>
          <div className="section-heading">
            <h2>Boxes</h2>
            <span className="eyebrow">
              {boxes.length} box{boxes.length === 1 ? '' : 'es'}
            </span>
          </div>
          {boxes.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                No physical box has been packed for this shipment yet.
              </p>
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
          {boxes.map((box) => {
            const isOpen = openLabelBoxIds.has(box.id)
            const label = labels[box.id]
            return (
              <div key={box.id} className="card" style={{ padding: 12 }}>
                <div className="row-between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div className="list-row-title mono">{box.qrToken.slice(0, 12).toUpperCase()}</div>
                    <div className="list-row-meta">
                      {box.lines.length} line{box.lines.length === 1 ? '' : 's'} · {box.state.toLowerCase()}
                      {box.arrivedAt ? ` · arrived ${new Date(box.arrivedAt).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void toggleLabel(box.id)}
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
                      <p style={{ margin: 0, color: 'var(--text-dim)' }}>Loading label…</p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
        </>
      )}
    </div>
  )
}

export default function ShipmentPage() {
  return (
    <RequireAuth>
      <ShipmentBody />
    </RequireAuth>
  )
}
