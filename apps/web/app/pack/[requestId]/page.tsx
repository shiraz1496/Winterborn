'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { BoxDto, BoxLabelDto, LocationDto, RestockRequestDto, VariationSummary, WarehouseVariantSummary } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { SectionHeading } from '../../../components/SectionHeading'
import { BoxLabel } from '../../../components/BoxLabel'
import { ProductThumb, firstPhoto } from '../../../components/ProductThumb'
import { printLabelElement } from '../../../lib/print-label'
import { useToast } from '../../../lib/toast'
import {
  ApiError,
  discardBox,
  dispatchBox,
  getBoxLabel,
  getRequest,
  listBoxes,
  availableAtWarehouse,
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

/// Extract the InsufficientStockException details array from an ApiError.
/// Returns [] for any other error shape so callers can safely branch on
/// `.length > 0`.
function insufficientStockDetails(err: unknown): Array<{ warehouseVariantId: string; requested: number; available: number }> {
  if (!(err instanceof ApiError)) return []
  if (err.code !== 'INSUFFICIENT_STOCK') return []
  const d = err.details
  if (!Array.isArray(d)) return []
  return d.filter(
    (row): row is { warehouseVariantId: string; requested: number; available: number } =>
      typeof row === 'object' && row !== null &&
      typeof (row as { warehouseVariantId: unknown }).warehouseVariantId === 'string' &&
      typeof (row as { requested: unknown }).requested === 'number' &&
      typeof (row as { available: unknown }).available === 'number',
  )
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
  const [hasPrefilled, setHasPrefilled] = useState<string | null>(null)
  // Live warehouse stock per warehouseVariant. Refetched after every
  // successful pack so the "N available" counters and the over-allocation
  // warnings track reality as boxes get packed.
  const [warehouseStock, setWarehouseStock] = useState<Map<string, number>>(new Map())

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

      // "N available" chip on each variant row reflects NET available at
      // the warehouse (on-hand minus stock already committed to other
      // PACKING boxes) — the same number the pack service enforces
      // server-side. Reading raw on-hand instead used to cause "6
      // available" chips followed by a "Not enough stock" server reject
      // whenever leftover PACKING boxes had reserved units the client
      // couldn't see. Fetched here per page load and again after every
      // successful pack.
      const variantIdsForThisRequest = perLine.flatMap((list) => list.map((v) => v.id))
      if (variantIdsForThisRequest.length > 0) {
        try {
          const { available } = await availableAtWarehouse(variantIdsForThisRequest)
          const map = new Map<string, number>()
          for (const k of Object.keys(available)) map.set(k, available[k] ?? 0)
          setWarehouseStock(map)
        } catch {
          // Non-fatal — the pack UI still works without the warning.
        }
      }
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

  /// Direct-set the draft quantity for a variant. Used by the editable
  /// input on each row so the packer can type "50" instead of clicking
  /// +50 times. Accepts any integer >= 0; 0 removes the entry.
  function setDraftQty(variant: WarehouseVariantSummary, value: number) {
    const clamped = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    setDraft((prev) => {
      const next = new Map(prev)
      if (clamped <= 0) {
        next.delete(variant.id)
      } else {
        next.set(variant.id, {
          warehouseVariantId: variant.id,
          variationId: variant.variationId,
          quantity: clamped,
          meta: variant,
        })
      }
      return next
    })
  }

  /// Once the request + variants + already-packed boxes are all loaded,
  /// pre-fill the draft with whatever the market manager requested per
  /// variant (minus what's already been packed in prior boxes). Runs
  /// exactly once per request id so a manual edit is not clobbered by
  /// a later boxes-reload. Family-level lines (no warehouseVariantId)
  /// are left alone -- the packer still decides which specific variant
  /// to send for those.
  useEffect(() => {
    if (!request) return
    if (hasPrefilled === request.id) return
    // Wait until warehouseVariant metadata is loaded for every line.
    const allVariantsLoaded = request.lines.every((l) => variantsByLine[l.id])
    if (!allVariantsLoaded) return

    // Sum already-packed per warehouseVariantId across existing boxes,
    // but SKIP PACKING boxes belonging solely to this request — those
    // get discarded on re-pack, so treating them as "already packed"
    // would show the operator an empty draft (0 remaining) on reload.
    // Only DISPATCHED / ARRIVED (immutable, out the door) count.
    const packedPerVariant = new Map<string, number>()
    for (const box of boxes) {
      if (box.state === 'PACKING') {
        // Solo-for-this-request PACKING boxes are re-writable — leave
        // them out. Shared PACKING boxes we can't rewrite from this
        // page still count.
        const ids = new Set<string>()
        if (box.requestId) ids.add(box.requestId)
        for (const line of box.lines) if (line.requestId) ids.add(line.requestId)
        const isSoloForThis =
          ids.has(request.id) && [...ids].every((id) => id === request.id)
        if (isSoloForThis) continue
      }
      for (const line of box.lines) {
        packedPerVariant.set(
          line.warehouseVariantId,
          (packedPerVariant.get(line.warehouseVariantId) ?? 0) + line.quantity,
        )
      }
    }

    // Sum requested qty per variant across lines (guards against the
    // theoretical case of two lines pointing at the same warehouseVariantId).
    const requestedPerVariant = new Map<string, { line: (typeof request.lines)[number]; qty: number }>()
    for (const line of request.lines) {
      if (!line.warehouseVariantId) continue // family-level; skip
      const existing = requestedPerVariant.get(line.warehouseVariantId)
      requestedPerVariant.set(line.warehouseVariantId, {
        line,
        qty: (existing?.qty ?? 0) + line.qtyRequested,
      })
    }

    const seeded = new Map<string, DraftEntry>()
    for (const [wvId, { line, qty }] of requestedPerVariant) {
      const meta = variantMeta.get(wvId)
      if (!meta) continue
      const alreadyPacked = packedPerVariant.get(wvId) ?? 0
      const remaining = qty - alreadyPacked
      if (remaining <= 0) continue
      seeded.set(wvId, {
        warehouseVariantId: wvId,
        variationId: line.variationId,
        quantity: remaining,
        meta,
      })
    }

    if (seeded.size > 0) setDraft(seeded)
    setHasPrefilled(request.id)
  }, [request, variantsByLine, variantMeta, boxes, hasPrefilled])

  async function submitBox() {
    if (!request || draft.size === 0) return
    setBusy(true)
    setError(null)
    try {
      // Re-pack: if there are existing PACKING boxes solely for this
      // request, discard them first so the new packBox replaces them
      // (matches the "don't create an extra box, rewrite the old one"
      // intent). Shared-with-siblings boxes were filtered out by the
      // caller (route to shipment view in that case).
      const solosToDiscard = boxes.filter((box) => {
        if (box.state !== 'PACKING') return false
        const ids = new Set<string>()
        if (box.requestId) ids.add(box.requestId)
        for (const line of box.lines) if (line.requestId) ids.add(line.requestId)
        if (!ids.has(request.id)) return false
        for (const id of ids) if (id !== request.id) return false
        return true
      })
      for (const box of solosToDiscard) await discardBox(box.id)

      await packBox({
        destinationLocationId: request.locationId,
        requestId: request.id,
        lines: [...draft.values()].map((d) => ({ warehouseVariantId: d.warehouseVariantId, quantity: d.quantity })),
      })
      setDraft(new Map())
      const fresh = await listBoxes({ requestId: request.id })
      setBoxes(fresh)
      // Refresh net-available counters so remaining pack rows show
      // updated "N available" after this box consumed a chunk of stock
      // (and reserved it as a PACKING box until dispatch).
      const variantIds = [...variantMeta.keys()]
      if (variantIds.length > 0) {
        try {
          const { available } = await availableAtWarehouse(variantIds)
          const map = new Map<string, number>()
          for (const k of Object.keys(available)) map.set(k, available[k] ?? 0)
          setWarehouseStock(map)
        } catch {
          // Non-fatal.
        }
      }
      toast.success(solosToDiscard.length > 0 ? 'Box re-packed' : 'Box packed')
    } catch (err) {
      // InsufficientStock from the backend arrives as ApiError with a
      // details array under body.details. Render a per-SKU message so the
      // packer sees exactly which line was over-allocated and by how much.
      const insufficient = insufficientStockDetails(err)
      if (insufficient.length > 0) {
        const summary = insufficient
          .map((d) => {
            const meta = variantMeta.get(d.warehouseVariantId)
            const label = meta ? `${meta.colourVariantName}${meta.sizeOptionName && meta.sizeOptionName !== 'One Size' ? ` / ${meta.sizeOptionName}` : ''}` : d.warehouseVariantId
            return `${label}: tried ${d.requested}, only ${d.available} available`
          })
          .join('\n')
        const msg = `Not enough stock in warehouse:\n${summary}`
        setError(msg)
        toast.error('Not enough stock — see banner for details')
      } else {
        const msg = err instanceof ApiError ? err.message : 'Could not pack that box.'
        setError(msg)
        toast.error(msg)
      }
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
      // Client-side error can be a dropped connection while the server
      // still succeeded — refetch and only show the error if the box
      // is genuinely still in PACKING. This turns a benign transport
      // hiccup into a silent success instead of a scary banner.
      try {
        const fresh = await listBoxes({ requestId: request.id })
        setBoxes(fresh)
        const box = fresh.find((b) => b.id === boxId)
        if (box && box.state !== 'PACKING') {
          toast.success('Box dispatched — ledger updated')
        } else {
          const msg = err instanceof ApiError ? err.message : 'Could not dispatch that box.'
          setError(msg)
          toast.error(msg)
        }
      } catch {
        const msg = err instanceof ApiError ? err.message : 'Could not dispatch that box.'
        setError(msg)
        toast.error(msg)
      }
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
  // True as soon as any draft line asks for more than the warehouse can
  // supply. Used to disable "Pack this box" and show a summary banner.
  const hasDraftOverAllocation = [...draft.values()].some(
    (d) => d.quantity > (warehouseStock.get(d.warehouseVariantId) ?? 0),
  )
  const variationById = new Map(variations.map((v) => [v.id, v]))

  /// Re-pack detection. We split the request's boxes into what's still
  /// mutable (PACKING, warehouse floor) vs already-shipped
  /// (DISPATCHED / ARRIVED). Only mutable solo boxes can be replaced —
  /// shared boxes route the operator to the shipment view instead.
  const totalRequested = request.lines.reduce((s, l) => s + l.qtyRequested, 0)
  const soloPackingBoxesForThisRequest = boxes.filter((box) => {
    if (box.state !== 'PACKING') return false
    const ids = new Set<string>()
    if (box.requestId) ids.add(box.requestId)
    for (const line of box.lines) if (line.requestId) ids.add(line.requestId)
    if (!ids.has(request.id)) return false
    // Solo = every id involved is this request. Shared boxes bail out
    // to the shipment view via the "Also headed to" card at the top.
    for (const id of ids) if (id !== request.id) return false
    return true
  })
  const dispatchedForThisRequest = boxes.reduce((sum, box) => {
    if (box.state !== 'DISPATCHED' && box.state !== 'ARRIVED') return sum
    let n = 0
    for (const line of box.lines) {
      const rid = line.requestId ?? box.requestId ?? null
      if (rid === request.id) n += line.quantity
    }
    return sum + n
  }, 0)
  const packingForThisRequest = soloPackingBoxesForThisRequest.reduce((sum, box) => {
    let n = 0
    for (const line of box.lines) {
      const rid = line.requestId ?? box.requestId ?? null
      if (rid === request.id) n += line.quantity
    }
    return sum + n
  }, 0)
  const isRepack = soloPackingBoxesForThisRequest.length > 0

  // Everything already dispatched → no re-pack path exists (out the door).
  const fullyDispatched = totalRequested > 0 && dispatchedForThisRequest >= totalRequested

  if (fullyDispatched) {
    return (
      <div>
        <PageHeader
          eyebrow={locationName ? `Packed for ${locationName}` : 'Packed'}
          title="This request is fully packed and dispatched"
          description="Every requested unit has already left the warehouse. Dispatched boxes cannot be re-packed."
        />
        {error && <p className="error-banner">{error}</p>}
        <div className="empty-state">
          <p className="empty-state-title">Nothing left to pack</p>
          <p className="empty-state-body">
            Requested: {totalRequested} · Packed & dispatched: {dispatchedForThisRequest}.
          </p>
          <Link href={`/requests/${request.id}`} className="empty-state-cta">
            → Open request detail
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        eyebrow={locationName ? `Packing for ${locationName}` : 'Packing'}
        title="Pack this request"
        description="For each family below, expand and add units of the actual warehouse SKU. Fill a box, click Pack this box, then Dispatch when the truck's ready. Dispatch writes the stock movement to the ledger — no scanner required."
      />

      {error && <p className="error-banner">{error}</p>}

      {isRepack && (
        <div
          className="card"
          style={{
            marginBottom: 20,
            borderColor: 'var(--signal, #b58a2c)',
            background: 'var(--surface-sunken)',
          }}
        >
          <strong>Re-packing this request</strong>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginTop: 4 }}>
            {soloPackingBoxesForThisRequest.length} existing PACKING box
            {soloPackingBoxesForThisRequest.length === 1 ? '' : 'es'} ({packingForThisRequest} unit
            {packingForThisRequest === 1 ? '' : 's'}) will be replaced when you click Pack this box.
            {dispatchedForThisRequest > 0 &&
              ` ${dispatchedForThisRequest} unit${dispatchedForThisRequest === 1 ? '' : 's'} already dispatched stays put.`}
          </div>
        </div>
      )}

      {siblings.length > 0 && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--pine)' }}>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <div>
              <strong>Also headed to {locationName ?? 'this destination'}</strong>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: 2 }}>
                Add another open request to <em>this</em> box — one physical box, one QR label, mixed contents.
              </div>
            </div>
            <span className="chip chip-pine">
              {siblings.length} other{siblings.length === 1 ? '' : 's'} open
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {siblings.map((s) => {
              const units = s.lines.reduce((sum, l) => sum + l.qtyRequested, 0)
              const merged = [request.id, s.id].join(',')
              const mergedHref = `/pack/dest/${encodeURIComponent(request.locationId)}?requests=${encodeURIComponent(merged)}`
              // Distinct product names on the sibling — the ids alone
              // ("#cmthd4") say nothing about what's inside. Dedupe by
              // variation because a request can carry multiple lines
              // per family (variant-level + family-level).
              const productNames: string[] = []
              const seenVariations = new Set<string>()
              for (const line of s.lines) {
                if (seenVariations.has(line.variationId)) continue
                seenVariations.add(line.variationId)
                const name = variationById.get(line.variationId)?.itemGroupName
                if (name) productNames.push(name)
              }
              const productSummary =
                productNames.length === 0
                  ? null
                  : productNames.length <= 2
                    ? productNames.join(', ')
                    : `${productNames.slice(0, 2).join(', ')} + ${productNames.length - 2} more`
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--line)',
                    background: 'var(--surface-sunken)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, fontSize: '0.85rem' }}>
                    <div style={{ fontWeight: 600 }}>
                      {productSummary ?? `#${s.id.slice(0, 6)}`}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: 2 }}>
                      <span className="mono">#{s.id.slice(0, 6)}</span> · {s.lines.length} line
                      {s.lines.length === 1 ? '' : 's'} · {units} unit{units === 1 ? '' : 's'} ·{' '}
                      {s.state.toLowerCase()} ·{' '}
                      {new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                  <Link
                    href={mergedHref}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '6px 10px',
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--signal, #b58a2c)',
                      color: 'var(--signal-ink, #fff)',
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    }}
                    title={`Merge #${s.id.slice(0, 6)} into this box`}
                  >
                    + Add to this box
                  </Link>
                </div>
              )
            })}
          </div>

          {siblings.length > 1 && (
            <div style={{ marginTop: 10, textAlign: 'right' }}>
              <Link
                href={`/pack/dest/${encodeURIComponent(request.locationId)}`}
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--text-dim)',
                  textDecoration: 'underline',
                }}
                title="Merge every open request for this market into a single packing session"
              >
                Add all {siblings.length} at once →
              </Link>
            </div>
          )}
        </div>
      )}

      <SectionHeading
        title="Resolve to variants"
        description="One card per product family. If the market picked specific variants, only those show up with the requested quantity pre-filled. Family-level lines expand to show every warehouse variant so you can decide the split."
      />
      {(() => {
        // Group request lines by family (variationId). Each family may
        // have multiple lines: some variant-level (each with its own
        // warehouseVariantId + qtyRequested) and/or one family-level
        // (no warehouseVariantId). Sum per-variant target quantities
        // across lines so a re-request of the same variant coalesces
        // into one row.
        interface FamilyGroup {
          variationId: string
          lines: typeof request.lines
          familyTotalRequested: number
          variantTargets: Map<string, number>
          hasFamilyLevelLine: boolean
        }
        const groups = new Map<string, FamilyGroup>()
        for (const line of request.lines) {
          // Explicit FamilyGroup annotation so the `lines: []` in the
          // fallback literal widens to typeof request.lines instead of
          // being inferred as never[] (which blocks the g.lines.push below).
          const g: FamilyGroup = groups.get(line.variationId) ?? {
            variationId: line.variationId,
            lines: [],
            familyTotalRequested: 0,
            variantTargets: new Map(),
            hasFamilyLevelLine: false,
          }
          g.lines.push(line)
          g.familyTotalRequested += line.qtyRequested
          if (line.warehouseVariantId) {
            g.variantTargets.set(
              line.warehouseVariantId,
              (g.variantTargets.get(line.warehouseVariantId) ?? 0) + line.qtyRequested,
            )
          } else {
            g.hasFamilyLevelLine = true
          }
          groups.set(line.variationId, g)
        }

        // Merge per-line warehouse-variant lists into one per family.
        function variantsForFamily(g: FamilyGroup) {
          const seen = new Map<string, WarehouseVariantSummary>()
          for (const line of g.lines) {
            for (const v of variantsByLine[line.id] ?? []) {
              seen.set(v.id, v)
            }
          }
          return [...seen.values()]
        }

        // Packed-so-far per variant across every existing box.
        function packedForVariant(wvId: string): number {
          let n = 0
          for (const box of boxes) {
            for (const line of box.lines) {
              if (line.warehouseVariantId === wvId) n += line.quantity
            }
          }
          return n
        }

        return (
          <div className="stack" style={{ marginBottom: 24 }}>
            {[...groups.values()].map((g) => {
              const familyMeta = variationById.get(g.variationId)
              const familyVariants = variantsForFamily(g)
              // Variants to show in the expanded body:
              //   - if any variant-level lines exist, only those variants
              //   - PLUS all variants (for split) if there's a family-level line too
              const requestedVariantIds = new Set(g.variantTargets.keys())
              const shownVariants = g.hasFamilyLevelLine
                ? familyVariants
                : familyVariants.filter((v) => requestedVariantIds.has(v.id))

              // Family-level packed = sum of every variant that belongs to it.
              const familyPacked = familyVariants.reduce((s, v) => s + packedForVariant(v.id), 0)
              const familyRemaining = g.familyTotalRequested - familyPacked
              const open = openLineId === g.variationId

              return (
                <div key={g.variationId} className="card">
                  <button
                    onClick={() => setOpenLineId(open ? null : g.variationId)}
                    style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 12, width: '100%', cursor: 'pointer' }}
                  >
                    <ProductThumb
                      photoUrl={firstPhoto(familyVariants)}
                      familyName={familyMeta?.colourFamilyName ?? ''}
                      alt={familyMeta?.itemGroupName ?? ''}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="list-row-title">{familyMeta?.itemGroupName ?? g.variationId}</div>
                      <div className="list-row-meta">
                        {familyMeta?.colourFamilyName} · {familyMeta?.sizeOptionName}
                        {' · '}
                        {g.lines.length} line{g.lines.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="eyebrow" style={{ color: 'var(--text-faint)', marginBottom: 2 }}>
                        packed / requested
                      </div>
                      <div className="mono" style={{ fontWeight: 700 }}>
                        {familyPacked} / {g.familyTotalRequested}
                      </div>
                      <span className={`chip ${familyRemaining <= 0 ? 'chip-pine' : 'chip-rust'}`}>
                        {familyRemaining <= 0 ? 'resolved' : `${familyRemaining} left`}
                      </span>
                    </div>
                  </button>

                  {open && (
                    <div className="list" style={{ marginTop: 14 }}>
                      {shownVariants.map((v) => {
                        const target = g.variantTargets.get(v.id) ?? null // null = family-level line, no target
                        const packedHere = packedForVariant(v.id)
                        const draftQty = draft.get(v.id)?.quantity ?? 0
                        const warehouseOnHand = warehouseStock.get(v.id) ?? 0
                        const overAllocated = draftQty > warehouseOnHand
                        return (
                          <div
                            key={v.id}
                            className="list-row"
                            style={{
                              border: overAllocated ? '1px solid var(--danger, #c0392b)' : '1px solid var(--line)',
                              alignItems: 'center',
                              background: overAllocated ? 'var(--danger-soft, #fdecea)' : undefined,
                            }}
                          >
                            <ProductThumb
                              photoUrl={v.photoUrl}
                              familyName={v.colourVariantName}
                              alt={v.colourVariantName}
                            />
                            <div className="list-row-body">
                              <div className="list-row-title">
                                {v.colourVariantName}
                                {target != null && (
                                  <span className="chip chip-signal" style={{ marginLeft: 8, fontSize: '0.6rem' }}>
                                    requested {target}
                                  </span>
                                )}
                                <span
                                  className="chip"
                                  style={{
                                    marginLeft: 8,
                                    fontSize: '0.6rem',
                                    background: warehouseOnHand === 0 ? 'var(--danger-soft, #fdecea)' : 'var(--surface-sunken)',
                                    color: warehouseOnHand === 0 ? 'var(--danger, #c0392b)' : 'var(--text-dim)',
                                  }}
                                  title="Units currently on hand at the warehouse"
                                >
                                  {warehouseOnHand} available
                                </span>
                              </div>
                              <div className="list-row-meta mono">
                                {v.warehouseSku}
                                {target != null && ` · packed ${packedHere} / ${target}`}
                              </div>
                              {overAllocated && (
                                <div style={{ marginTop: 4, color: 'var(--danger, #c0392b)', fontSize: '0.72rem', fontWeight: 600 }}>
                                  Cannot send {draftQty} — only {warehouseOnHand} available in warehouse.
                                </div>
                              )}
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
                              <input
                                type="number"
                                className="stepper-input"
                                min={0}
                                step={1}
                                value={draftQty}
                                onChange={(e) => setDraftQty(v, Number(e.target.value))}
                                onFocus={(e) => e.currentTarget.select()}
                                aria-label={`Quantity of ${v.colourVariantName}`}
                                style={overAllocated ? { borderColor: 'var(--danger, #c0392b)' } : undefined}
                              />
                              <button
                                className="stepper-btn"
                                onClick={() => adjustDraft(v, 1)}
                                aria-label="Increase"
                                disabled={draftQty >= warehouseOnHand}
                                title={draftQty >= warehouseOnHand ? 'No more units available in warehouse' : undefined}
                              >
                                +
                              </button>
                            </div>
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

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="row-between" style={{ marginBottom: draftCount > 0 ? 12 : 0 }}>
          <span className="eyebrow">Current box</span>
          <span className="mono" style={{ fontWeight: 700 }}>
            {draftCount} unit{draftCount === 1 ? '' : 's'}
          </span>
        </div>
        {hasDraftOverAllocation && (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--danger-soft, #fdecea)', color: 'var(--danger, #c0392b)', fontSize: '0.8rem', fontWeight: 600 }}>
            One or more lines exceed the warehouse stock — reduce the highlighted rows before packing.
          </div>
        )}
        <button
          className="btn btn-primary"
          onClick={submitBox}
          disabled={busy || draft.size === 0 || hasDraftOverAllocation}
        >
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
                  {labels[box.id] ? 'Hide QR label' : 'Show QR label'}
                </button>
                {box.state === 'PACKING' && (
                  <button className="btn btn-primary" onClick={() => doDispatch(box.id)} disabled={busy}>
                    Dispatch box
                  </button>
                )}
              </div>
              {labels[box.id] && (
                <div id={`box-label-wrap-${box.id}`} style={{ marginTop: 14 }}>
                  <BoxLabel label={labels[box.id]!} />
                  <button
                    className="btn btn-block no-print"
                    style={{ marginTop: 10 }}
                    onClick={() => printLabelElement(`box-label-wrap-${box.id}`)}
                  >
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
