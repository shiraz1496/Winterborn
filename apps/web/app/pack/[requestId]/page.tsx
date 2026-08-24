'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { BoxDto, BoxLabelDto, LocationDto, RestockRequestDto, VariationSummary, WarehouseVariantSummary } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { Swatch } from '../../../components/Swatch'
import { BoxLabel } from '../../../components/BoxLabel'
import { useToast } from '../../../lib/toast'
import {
  ApiError,
  dispatchBox,
  getBoxLabel,
  getRequest,
  listBoxes,
  listLocations,
  listRequests,
  listVariations,
  listWarehouseVariants,
  packBox,
  transitionRequest,
} from '../../../lib/api'

interface DraftEntry {
  warehouseVariantId: string
  variationId: string
  quantity: number
  meta: WarehouseVariantSummary
}

function PackBody() {
  const params = useParams<{ requestId: string }>()
  const toast = useToast()
  const [request, setRequest] = useState<RestockRequestDto | null>(null)
  const [siblings, setSiblings] = useState<RestockRequestDto[]>([])
  const [locationName, setLocationName] = useState<string | null>(null)
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [variantsByLine, setVariantsByLine] = useState<Record<string, WarehouseVariantSummary[]>>({})
  const [boxes, setBoxes] = useState<BoxDto[]>([])
  const [variantMeta, setVariantMeta] = useState<Map<string, WarehouseVariantSummary>>(new Map())
  const [draft, setDraft] = useState<Map<string, DraftEntry>>(new Map())
  const [openLineId, setOpenLineId] = useState<string | null>(null)
  const [labels, setLabels] = useState<Record<string, BoxLabelDto>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
      let req = await getRequest(params.requestId)
      if (req.state === 'OPEN') {
        await transitionRequest(req.id, 'PACKING')
        req = await getRequest(params.requestId)
      }
      setRequest(req)

      const perLine = await Promise.all(req.lines.map((l) => listWarehouseVariants(l.variationId)))
      const byLine: Record<string, WarehouseVariantSummary[]> = {}
      const metaMap = new Map<string, WarehouseVariantSummary>()
      req.lines.forEach((l, i) => {
        byLine[l.id] = perLine[i]!
        for (const v of perLine[i]!) metaMap.set(v.id, v)
      })
      setVariantsByLine(byLine)
      setVariantMeta(metaMap)
      setVariations(await listVariations())

      setBoxes(await listBoxes({ requestId: req.id }))

      // Doc 3 §3.5: same destination, other open packable requests. Shown
      // as a hint so the packer can combine into one dispatch run instead
      // of packing this then walking back to pack another for the same
      // market. Fetched in parallel with everything else and never blocks
      // the pack flow.
      const [allRequests, allLocations] = await Promise.all([listRequests(), listLocations()])
      const others = allRequests
        .filter(
          (r) =>
            r.id !== req.id &&
            r.locationId === req.locationId &&
            (r.state === 'OPEN' || r.state === 'PACKING'),
        )
      setSiblings(others)
      const loc = allLocations.find((l: LocationDto) => l.id === req.locationId)
      setLocationName(loc?.name ?? null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this request for packing.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.requestId])

  const packedByVariation = useMemo(() => {
    const totals = new Map<string, number>()
    for (const box of boxes) {
      for (const line of box.lines) {
        const meta = variantMeta.get(line.warehouseVariantId)
        if (!meta) continue
        totals.set(meta.variationId, (totals.get(meta.variationId) ?? 0) + line.quantity)
      }
    }
    return totals
  }, [boxes, variantMeta])

  const draftByVariation = useMemo(() => {
    const totals = new Map<string, number>()
    for (const entry of draft.values()) {
      totals.set(entry.variationId, (totals.get(entry.variationId) ?? 0) + entry.quantity)
    }
    return totals
  }, [draft])

  function remainingFor(variationId: string, requested: number): number {
    return requested - (packedByVariation.get(variationId) ?? 0) - (draftByVariation.get(variationId) ?? 0)
  }

  function adjustDraft(variant: WarehouseVariantSummary, delta: number) {
    setDraft((prev) => {
      const next = new Map(prev)
      const existing = next.get(variant.id)
      const quantity = (existing?.quantity ?? 0) + delta
      if (quantity <= 0) {
        next.delete(variant.id)
      } else {
        next.set(variant.id, { warehouseVariantId: variant.id, variationId: variant.variationId, quantity, meta: variant })
      }
      return next
    })
  }

  async function submitBox() {
    if (!request || draft.size === 0) return
    setBusy(true)
    setError(null)
    try {
      await packBox({
        destinationLocationId: request.locationId,
        requestId: request.id,
        lines: [...draft.values()].map((d) => ({ warehouseVariantId: d.warehouseVariantId, quantity: d.quantity })),
      })
      setDraft(new Map())
      setBoxes(await listBoxes({ requestId: request.id }))
      toast.success('Box packed')
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not pack that box.'
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  async function loadLabel(boxId: string) {
    if (labels[boxId]) {
      setLabels((prev) => {
        const next = { ...prev }
        delete next[boxId]
        return next
      })
      return
    }
    try {
      const label = await getBoxLabel(boxId)
      setLabels((prev) => ({ ...prev, [boxId]: label }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load that label.')
    }
  }

  async function doDispatch(boxId: string) {
    if (!request) return
    setBusy(true)
    setError(null)
    try {
      await dispatchBox(boxId)
      setBoxes(await listBoxes({ requestId: request.id }))
      toast.success('Box dispatched — ledger updated')
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not dispatch that box.'
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  if (loading || !request) {
    return (
      <div className="screen-loading">
        {error ? <p className="error-banner">{error}</p> : <div className="spinner" aria-hidden="true" />}
      </div>
    )
  }

  const draftCount = [...draft.values()].reduce((sum, d) => sum + d.quantity, 0)
  const variationById = new Map(variations.map((v) => [v.id, v]))

  return (
    <div>
      <PageHeader
        eyebrow={locationName ? `Packing for ${locationName}` : 'Packing'}
        title="Pack this request"
        description="For each family below, expand and add units of the actual warehouse SKU. Fill a box, click Pack this box, then Dispatch when the truck's ready. Dispatch writes the stock movement to the ledger — no scanner required."
      />

      {error && <p className="error-banner">{error}</p>}

      {siblings.length > 0 && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--pine)' }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <strong>Also headed to {locationName ?? 'this destination'}</strong>
            <span className="chip chip-pine">
              {siblings.length} other{siblings.length === 1 ? '' : 's'} open
            </span>
          </div>
          <p style={{ margin: '0 0 10px', color: 'var(--text-dim)' }}>
            Combine into one dispatch run rather than sending two boxes to the same market.
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {siblings.map((s) => (
              <Link key={s.id} href={`/pack/${s.id}`} className="chip" style={{ cursor: 'pointer' }}>
                {s.state.toLowerCase()} · {s.lines.length} line{s.lines.length === 1 ? '' : 's'}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="section-heading">
        <h2>Resolve to variants</h2>
      </div>
      <div className="stack" style={{ marginBottom: 24 }}>
        {request.lines.map((line) => {
          const variants = variantsByLine[line.id] ?? []
          const remaining = remainingFor(line.variationId, line.qtyRequested)
          const familyMeta = variationById.get(line.variationId)
          const open = openLineId === line.id
          return (
            <div key={line.id} className="card">
              <button
                onClick={() => setOpenLineId(open ? null : line.id)}
                style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 12, width: '100%', cursor: 'pointer' }}
              >
                <Swatch familyName={familyMeta?.colourFamilyName} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="list-row-title">{familyMeta?.itemGroupName ?? line.variationId}</div>
                  <div className="list-row-meta">
                    {familyMeta?.colourFamilyName} · {familyMeta?.sizeOptionName}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="mono" style={{ fontWeight: 700 }}>
                    {line.qtyRequested - remaining} / {line.qtyRequested}
                  </div>
                  <span className={`chip ${remaining <= 0 ? 'chip-pine' : 'chip-rust'}`}>
                    {remaining <= 0 ? 'resolved' : `${remaining} left`}
                  </span>
                </div>
              </button>

              {open && (
                <div className="list" style={{ marginTop: 14 }}>
                  {variants.map((v) => (
                    <div key={v.id} className="list-row" style={{ border: '1px solid var(--line)' }}>
                      <Swatch familyName={v.colourVariantName} />
                      <div className="list-row-body">
                        <div className="list-row-title">{v.colourVariantName}</div>
                        <div className="list-row-meta mono">{v.warehouseSku}</div>
                      </div>
                      <div className="stepper">
                        <button
                          className="stepper-btn"
                          onClick={() => adjustDraft(v, -1)}
                          disabled={!draft.get(v.id)}
                          aria-label="Decrease"
                        >
                          −
                        </button>
                        <span className="stepper-value">{draft.get(v.id)?.quantity ?? 0}</span>
                        <button className="stepper-btn" onClick={() => adjustDraft(v, 1)} aria-label="Increase">
                          +
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="card" style={{ marginBottom: 24, position: 'sticky', bottom: 76 }}>
        <div className="row-between" style={{ marginBottom: draftCount > 0 ? 12 : 0 }}>
          <span className="eyebrow">Current box</span>
          <span className="mono" style={{ fontWeight: 700 }}>
            {draftCount} unit{draftCount === 1 ? '' : 's'}
          </span>
        </div>
        <button className="btn btn-primary" onClick={submitBox} disabled={busy || draft.size === 0}>
          {busy ? 'Packing…' : 'Pack this box'}
        </button>
      </div>

      <div className="section-heading">
        <h2>Boxes</h2>
        <span className="eyebrow">{boxes.length}</span>
      </div>
      {boxes.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>No boxes packed yet.</p>
        </div>
      ) : (
        <div className="stack">
          {boxes.map((box) => (
            <div key={box.id} className="card">
              <div className="row-between">
                <div>
                  <div className="list-row-title mono">{box.id.slice(0, 8)}</div>
                  <div className="list-row-meta">
                    {box.lines.length} line{box.lines.length === 1 ? '' : 's'}
                  </div>
                </div>
                <span className={`chip ${box.state === 'DISPATCHED' ? 'chip-pine' : 'chip-signal'}`}>
                  {box.state.toLowerCase()}
                </span>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => loadLabel(box.id)}>
                  {labels[box.id] ? 'Hide label' : 'Label'}
                </button>
                {box.state === 'PACKING' && (
                  <button className="btn btn-primary" onClick={() => doDispatch(box.id)} disabled={busy}>
                    Dispatch box
                  </button>
                )}
              </div>
              {labels[box.id] && (
                <div style={{ marginTop: 14 }}>
                  <BoxLabel label={labels[box.id]!} />
                  <button className="btn btn-block no-print" style={{ marginTop: 10 }} onClick={() => window.print()}>
                    Print
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PackPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']}>
      <PackBody />
    </RequireAuth>
  )
}
