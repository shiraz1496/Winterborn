'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import type {
  BoxDto,
  BoxLabelDto,
  LocationDto,
  RestockRequestDto,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { BoxLabel } from '../../../../components/BoxLabel'
import { PageHeader } from '../../../../components/PageHeader'
import { SectionHeading } from '../../../../components/SectionHeading'
import { ProductThumb, firstPhoto } from '../../../../components/ProductThumb'
import { RequireAuth } from '../../../../components/RequireAuth'
import { Swatch } from '../../../../components/Swatch'
import { printLabelElement } from '../../../../lib/print-label'
import { useToast } from '../../../../lib/toast'
import {
  ApiError,
  discardBox,
  dispatchBox,
  getBoxLabel,
  listBoxes,
  listLocations,
  listRequests,
  listVariations,
  listWarehouseVariants,
  packBox,
  availableAtWarehouse,
  transitionRequest,
} from '../../../../lib/api'

/// One draft row: how many units of a warehouse variant to put in the
/// next box. The active-request selector governs which request the
/// resulting Box row is bound to on submit — Box.requestId is 1:1 in
/// the current schema, so a single Pack this box click writes one box
/// against exactly one request.
interface DraftEntry {
  warehouseVariantId: string
  variationId: string
  quantity: number
  meta: WarehouseVariantSummary
}

function insufficientStockDetails(
  err: unknown,
): Array<{ warehouseVariantId: string; requested: number; available: number }> {
  if (!(err instanceof ApiError)) return []
  if (err.code !== 'INSUFFICIENT_STOCK') return []
  const d = err.details
  if (!Array.isArray(d)) return []
  return d.filter(
    (row): row is { warehouseVariantId: string; requested: number; available: number } =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as { warehouseVariantId: unknown }).warehouseVariantId === 'string' &&
      typeof (row as { requested: unknown }).requested === 'number' &&
      typeof (row as { available: unknown }).available === 'number',
  )
}

function DestinationPackBody() {
  const params = useParams<{ locationId: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const locationId = params.locationId
  /// Optional subset filter from the index (`?requests=id1,id2,...`). When
  /// present, only the ticked requests are loaded — matches the bulk-pack
  /// intent. When absent, every open request for this market shows.
  const requestSubset = useMemo(() => {
    const raw = searchParams.get('requests')
    if (!raw) return null
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
    return ids.length > 0 ? new Set(ids) : null
  }, [searchParams])
  const toast = useToast()

  const [requests, setRequests] = useState<RestockRequestDto[]>([])
  /// Open/PACKING requests for this market that are NOT in the current
  /// subset (e.g. the operator arrived here via `?requests=A,B` but the
  /// market also has open C, D). Shown as "add another" candidates so the
  /// scope can grow without going back to the pack index.
  const [availableSiblings, setAvailableSiblings] = useState<RestockRequestDto[]>([])
  const [locationName, setLocationName] = useState<string | null>(null)
  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [variantsByLine, setVariantsByLine] = useState<Record<string, WarehouseVariantSummary[]>>({})
  const [variantMeta, setVariantMeta] = useState<Map<string, WarehouseVariantSummary>>(new Map())
  const [boxes, setBoxes] = useState<BoxDto[]>([])
  const [warehouseStock, setWarehouseStock] = useState<Map<string, number>>(new Map())
  const [draft, setDraft] = useState<Map<string, DraftEntry>>(new Map())
  /// Set of expanded family (variationId) cards. Multiple can be open at
  /// once so the packer can see several products' variant grids without
  /// losing context.
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set())
  const [labels, setLabels] = useState<Record<string, BoxLabelDto>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  /// True after the initial draft seed for this page load. Guarded by a
  /// signature of the requests+variants+boxes so a manual edit isn't
  /// clobbered when the same effect re-fires.
  const [hasPrefilled, setHasPrefilled] = useState(false)

  /// Full page load: pull every OPEN/PACKING request for this destination,
  /// transition them all to PACKING (matches the single-request page's
  /// on-open behaviour so the state chip stays honest), and gather all
  /// variant metadata + already-packed boxes + warehouse stock in one pass.
  async function load() {
    try {
      const [allRequests, allLocations] = await Promise.all([listRequests(), listLocations()])
      const loc = allLocations.find((l) => l.id === locationId)
      setLocationName(loc?.name ?? null)

      const mine = allRequests.filter(
        (r) =>
          r.locationId === locationId &&
          (r.state === 'OPEN' || r.state === 'PACKING') &&
          (requestSubset ? requestSubset.has(r.id) : true),
      )

      // Transition every OPEN request to PACKING so the state chip on
      // each row is accurate the moment the page renders.
      const toTransition = mine.filter((r) => r.state === 'OPEN')
      if (toTransition.length > 0) {
        await Promise.all(toTransition.map((r) => transitionRequest(r.id, 'PACKING')))
      }

      // Refetch after transitions to pick up the new state values.
      const refreshed = toTransition.length > 0 ? await listRequests() : allRequests
      const active = refreshed
        .filter(
          (r) =>
            r.locationId === locationId &&
            (r.state === 'OPEN' || r.state === 'PACKING') &&
            (requestSubset ? requestSubset.has(r.id) : true),
        )
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      setRequests(active)

      // Fetch every box for this destination up front so we can filter
      // "fully-packed" requests out of the sibling picker before we even
      // finish loading. A request whose full demand is already sitting in
      // boxes doesn't want to be added to the current draft — it has
      // nothing left to pack.
      const destBoxes = await listBoxes({ destinationLocationId: locationId })
      setBoxes(destBoxes)

      const packedPerRequest = new Map<string, number>()
      for (const b of destBoxes) {
        for (const line of b.lines) {
          const rid = line.requestId ?? b.requestId ?? null
          if (!rid) continue
          packedPerRequest.set(rid, (packedPerRequest.get(rid) ?? 0) + line.quantity)
        }
      }
      const isFullyPacked = (r: RestockRequestDto) => {
        const requested = r.lines.reduce((sum, l) => sum + l.qtyRequested, 0)
        return (packedPerRequest.get(r.id) ?? 0) >= requested
      }

      // Same-market open/PACKING requests NOT currently in the subset
      // and NOT already fully packed. Only shown when a subset was
      // passed — an unscoped dest view already loaded every open one.
      if (requestSubset) {
        const activeIds = new Set(active.map((r) => r.id))
        const siblings = refreshed
          .filter(
            (r) =>
              r.locationId === locationId &&
              (r.state === 'OPEN' || r.state === 'PACKING') &&
              !activeIds.has(r.id) &&
              !isFullyPacked(r),
          )
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        setAvailableSiblings(siblings)
      } else {
        setAvailableSiblings([])
      }

      // Fetch variants per unique variationId (dedupe across requests so
      // the same family used by two requests isn't fetched twice).
      const uniqueVariationIds = new Set<string>()
      const lineToVariation = new Map<string, string>()
      for (const r of active) {
        for (const line of r.lines) {
          uniqueVariationIds.add(line.variationId)
          lineToVariation.set(line.id, line.variationId)
        }
      }
      const variationIds = [...uniqueVariationIds]
      const variantsByVariation = new Map<string, WarehouseVariantSummary[]>()
      const fetched = await Promise.all(variationIds.map((id) => listWarehouseVariants(id)))
      variationIds.forEach((id, i) => variantsByVariation.set(id, fetched[i]!))

      const byLine: Record<string, WarehouseVariantSummary[]> = {}
      const metaMap = new Map<string, WarehouseVariantSummary>()
      for (const r of active) {
        for (const line of r.lines) {
          const list = variantsByVariation.get(line.variationId) ?? []
          byLine[line.id] = list
          for (const v of list) metaMap.set(v.id, v)
        }
      }
      setVariantsByLine(byLine)
      setVariantMeta(metaMap)
      setVariations(await listVariations())

      // Net available at the warehouse (on-hand minus units already
      // committed to open PACKING boxes) powers the "N available" chip
      // and the over-allocation banner. Reading raw on-hand instead
      // used to let this dest view show "3 available" while the pack
      // service would then reject 3 because 2 were already reserved by
      // another box in progress.
      const variantIds = [...metaMap.keys()]
      if (variantIds.length > 0) {
        try {
          const { available } = await availableAtWarehouse(variantIds)
          const map = new Map<string, number>()
          for (const k of Object.keys(available)) map.set(k, available[k] ?? 0)
          setWarehouseStock(map)
        } catch {
          // Non-fatal — the pack UI still works without the warning.
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this destination for packing.')
    } finally {
      setLoading(false)
    }
  }

  /// Re-load whenever the URL scope changes (`?requests=…` shrinks or
  /// grows). Depending on the raw query string keeps the effect stable
  /// across renders — `requestSubset` is a Set derived from it and would
  /// be a fresh reference each render.
  const requestsQuery = searchParams.get('requests') ?? ''
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, requestsQuery])

  /// Packed-so-far totals per (requestId, warehouseVariantId). Reads
  /// per-line requestId (multi-request boxes) with a fallback to
  /// Box.requestId (single-request boxes). Boxes with no ownership
  /// at all are ignored — nothing to credit.
  const packedByRequestVariant = useMemo(() => {
    const totals = new Map<string, Map<string, number>>()
    for (const box of boxes) {
      for (const line of box.lines) {
        const reqId = line.requestId ?? box.requestId ?? null
        if (!reqId) continue
        let byVariant = totals.get(reqId)
        if (!byVariant) {
          byVariant = new Map()
          totals.set(reqId, byVariant)
        }
        byVariant.set(
          line.warehouseVariantId,
          (byVariant.get(line.warehouseVariantId) ?? 0) + line.quantity,
        )
      }
    }
    return totals
  }, [boxes])

  const packedForRequestVariant = (requestId: string, wvId: string): number =>
    packedByRequestVariant.get(requestId)?.get(wvId) ?? 0

  /// Total packed for a variant, summed ONLY across requests currently
  /// in scope on this page. Prevents boxes packed for other requests
  /// at the same destination (out-of-scope) from inflating the "packed
  /// / requested" counter — the answer to "how much of what we're
  /// packing right now has been packed" is what the UI needs, not the
  /// destination-wide total.
  const packedTotalForVariant = (wvId: string): number => {
    let n = 0
    for (const r of requests) {
      n += packedByRequestVariant.get(r.id)?.get(wvId) ?? 0
    }
    return n
  }

  /// Pre-fill the draft with unfilled targets summed across EVERY open
  /// request at this destination. One row per warehouse variant; qty =
  /// (sum of requested across all requests) − (sum of already-packed
  /// across all requests). Family-level lines (no warehouseVariantId)
  /// are left for the operator to decide the variant split.
  useEffect(() => {
    if (hasPrefilled) return
    if (requests.length === 0) return
    // Wait until variant metadata is loaded for every line on every request.
    const allLoaded = requests.every((r) => r.lines.every((l) => variantsByLine[l.id]))
    if (!allLoaded) return

    const requestedPerVariant = new Map<string, number>()
    const packedPerVariant = new Map<string, number>()
    for (const r of requests) {
      for (const line of r.lines) {
        if (!line.warehouseVariantId) continue
        requestedPerVariant.set(
          line.warehouseVariantId,
          (requestedPerVariant.get(line.warehouseVariantId) ?? 0) + line.qtyRequested,
        )
      }
    }
    /// PACKING boxes get replaced when the operator hits Pack this
    /// box — treat them as "not yet packed" for the pre-fill so the
    /// draft mirrors the current PACKING contents (else remaining would
    /// read 0 and the operator would see an empty draft on reload).
    /// Only DISPATCHED / ARRIVED count as immutable "already packed".
    const scopedIds = new Set(requests.map((r) => r.id))
    for (const box of boxes) {
      if (box.state === 'PACKING') continue
      for (const line of box.lines) {
        const rid = line.requestId ?? box.requestId ?? null
        if (!rid || !scopedIds.has(rid)) continue
        packedPerVariant.set(
          line.warehouseVariantId,
          (packedPerVariant.get(line.warehouseVariantId) ?? 0) + line.quantity,
        )
      }
    }

    const seeded = new Map<string, DraftEntry>()
    for (const [wvId, requested] of requestedPerVariant) {
      const meta = variantMeta.get(wvId)
      if (!meta) continue
      const remaining = requested - (packedPerVariant.get(wvId) ?? 0)
      if (remaining <= 0) continue
      seeded.set(wvId, {
        warehouseVariantId: wvId,
        variationId: meta.variationId,
        quantity: remaining,
        meta,
      })
    }

    setDraft(seeded)
    setHasPrefilled(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, variantsByLine, variantMeta, boxes])

  /// Extend the subset by one sibling. Rebuilds the `?requests=…` query
  /// param including the new id and pushes it — the load effect re-runs
  /// and the sibling is folded into the resolve-to-variants section.
  /// Discards the current in-flight draft (a warning would be nice; kept
  /// simple for now — the operator can re-tick from the resolve section).
  function addSibling(id: string) {
    const currentIds = requests.map((r) => r.id)
    const nextIds = [...new Set([...currentIds, id])]
    const qs = new URLSearchParams({ requests: nextIds.join(',') }).toString()
    setHasPrefilled(false)
    setDraft(new Map())
    router.push(`/pack/dest/${encodeURIComponent(locationId)}?${qs}`)
  }

  /// Drop the subset filter entirely — load every open request for this
  /// market. Handy escape hatch when the operator realises they want it
  /// all.
  function addAllSiblings() {
    setHasPrefilled(false)
    setDraft(new Map())
    router.push(`/pack/dest/${encodeURIComponent(locationId)}`)
  }

  function adjustDraft(variant: WarehouseVariantSummary, delta: number) {
    setDraft((prev) => {
      const next = new Map(prev)
      const existing = next.get(variant.id)
      const quantity = (existing?.quantity ?? 0) + delta
      if (quantity <= 0) {
        next.delete(variant.id)
      } else {
        next.set(variant.id, {
          warehouseVariantId: variant.id,
          variationId: variant.variationId,
          quantity,
          meta: variant,
        })
      }
      return next
    })
  }

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

  async function submitBox() {
    if (requests.length === 0 || draft.size === 0) return
    setBusy(true)
    setError(null)
    try {
      // ------------------------------------------------------------
      // Re-pack: find every PACKING box whose ownership sits entirely
      // inside the currently-scoped request set (single-request or
      // multi-request boxes that fulfil only these requests). Those
      // are the boxes this Pack click replaces. Boxes that share a
      // line with a request OUTSIDE our scope stay untouched so we
      // don't accidentally void someone else's work.
      // ------------------------------------------------------------
      const scopedIds = new Set(requests.map((r) => r.id))
      const boxesToDiscard = boxes.filter((box) => {
        if (box.state !== 'PACKING') return false
        const ids = new Set<string>()
        if (box.requestId) ids.add(box.requestId)
        for (const line of box.lines) if (line.requestId) ids.add(line.requestId)
        // Ignore loose boxes with no request ownership at all.
        if (ids.size === 0) return false
        // Must touch at least one scoped request AND every id must be
        // scoped (no out-of-scope siblings).
        let touchesScope = false
        for (const id of ids) {
          if (!scopedIds.has(id)) return false
          touchesScope = true
        }
        return touchesScope
      })
      const dropIds = new Set(boxesToDiscard.map((b) => b.id))

      // ------------------------------------------------------------
      // Build ONE box's worth of lines. Each line carries its own
      // per-line `requestId` so a physical box that fulfils multiple
      // requests ships as one Box row with one QR label — the backend
      // records ownership at the BoxLine level.
      //
      // For each drafted variant, walk requests in the order shown
      // (oldest-first) and hand each request `min(qty, remaining)`
      // where `remaining = requested − packed`. Only PACKING boxes
      // we're NOT about to discard count as already-packed here —
      // otherwise the boxes we're replacing would inflate the packed
      // total and cause an overpack.
      // ------------------------------------------------------------
      const packedForNonDiscardedPerRequestVariant = (rid: string, wvId: string): number => {
        let n = 0
        for (const b of boxes) {
          if (dropIds.has(b.id)) continue
          for (const line of b.lines) {
            const lineRid = line.requestId ?? b.requestId ?? null
            if (lineRid !== rid) continue
            if (line.warehouseVariantId === wvId) n += line.quantity
          }
        }
        return n
      }
      const remainingPerRequestVariant = new Map<string, Map<string, number>>()
      for (const r of requests) {
        const perVariant = new Map<string, number>()
        for (const line of r.lines) {
          if (!line.warehouseVariantId) continue
          perVariant.set(
            line.warehouseVariantId,
            (perVariant.get(line.warehouseVariantId) ?? 0) + line.qtyRequested,
          )
        }
        for (const [wvId, qty] of perVariant) {
          const packed = packedForNonDiscardedPerRequestVariant(r.id, wvId)
          perVariant.set(wvId, Math.max(0, qty - packed))
        }
        remainingPerRequestVariant.set(r.id, perVariant)
      }

      // Materialise per-line submissions: one line per (variant, request)
      // combo. Two draft units for the same variant that end up split
      // between two requests become two separate lines on the box.
      const packLines: Array<{ warehouseVariantId: string; quantity: number; requestId: string }> = []
      for (const [wvId, entry] of draft) {
        let left = entry.quantity
        for (const r of requests) {
          if (left <= 0) break
          const rem = remainingPerRequestVariant.get(r.id)?.get(wvId) ?? 0
          if (rem <= 0) continue
          const give = Math.min(left, rem)
          packLines.push({ warehouseVariantId: wvId, quantity: give, requestId: r.id })
          remainingPerRequestVariant.get(r.id)!.set(wvId, rem - give)
          left -= give
        }
        // Overpack: no request wants any more, attach the remainder to
        // the first request as an overpack line.
        if (left > 0) {
          const first = requests[0]!
          packLines.push({ warehouseVariantId: wvId, quantity: left, requestId: first.id })
        }
      }

      if (packLines.length === 0) throw new Error('No lines to pack.')

      // Discard the boxes we're rewriting BEFORE creating the fresh
      // one. Sequential + best-effort: if one fails, the fresh box
      // still writes and the operator can retry the delete from the
      // request/shipment detail.
      for (const box of boxesToDiscard) await discardBox(box.id)

      // ONE box, ONE QR label — the server sets Box.requestId to null
      // when it sees mixed line-level requestIds and stores ownership
      // per line instead.
      await packBox({ destinationLocationId: locationId, lines: packLines })

      /// Clear the draft but DO NOT reset `hasPrefilled` — the operator
      /// has already committed a decision this session (which lines are
      /// out of stock, which quantities they intend). Auto-refilling
      /// from the un-packed remaining would erase that (e.g. a variant
      /// they deliberately set to 0 because it's unavailable would come
      /// back at 1). Pre-fill runs once per page load, no more.
      setDraft(new Map())
      const fresh = await listBoxes({ destinationLocationId: locationId })
      setBoxes(fresh)
      // Refresh net-available so the remaining unpacked lines show
      // updated counters after this box's stock was reserved.
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
      const involvedRequests = new Set(packLines.map((l) => l.requestId))
      const verb = boxesToDiscard.length > 0 ? 'Box re-packed' : 'Box packed'
      toast.success(
        involvedRequests.size === 1
          ? verb
          : `${verb} — one label covers ${involvedRequests.size} requests`,
      )
      // Same behaviour as the single-request pack screen: send the
      // operator to the natural post-pack view so they can review the
      // label / print the QR / hit dispatch. One request → its detail;
      // multiple requests packed together → the grouped shipment view
      // (that's what scopes the label + dispatch across the group).
      const involvedIds = [...involvedRequests].filter((id): id is string => !!id)
      if (involvedIds.length === 1) {
        router.push(`/requests/${involvedIds[0]}`)
      } else if (involvedIds.length > 1) {
        const qs = involvedIds.map((id) => encodeURIComponent(id)).join(',')
        router.push(`/requests/shipment?ids=${qs}`)
      }
    } catch (err) {
      const insufficient = insufficientStockDetails(err)
      if (insufficient.length > 0) {
        const summary = insufficient
          .map((d) => {
            const meta = variantMeta.get(d.warehouseVariantId)
            const label = meta
              ? `${meta.colourVariantName}${meta.sizeOptionName && meta.sizeOptionName !== 'One Size' ? ` / ${meta.sizeOptionName}` : ''
              }`
              : d.warehouseVariantId
            return `${label}: tried ${d.requested}, only ${d.available} available`
          })
          .join('\n')
        setError(`Not enough stock in warehouse:\n${summary}`)
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
    setBusy(true)
    setError(null)
    try {
      await dispatchBox(boxId)
      setBoxes(await listBoxes({ destinationLocationId: locationId }))
      toast.success('Box dispatched — ledger updated')
    } catch (err) {
      // Same defensive refetch as the single-request page — a dropped
      // connection can leave the server successful but the client
      // thinking it failed. Only surface an error if the box is still
      // PACKING after the refetch.
      try {
        const fresh = await listBoxes({ destinationLocationId: locationId })
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
        <PageHeader
          eyebrow="Pack"
          title={locationName ?? 'Destination'}
          description="Nothing left to pack for this destination."
        />
        <div className="empty-state">
          <p className="empty-state-title">All caught up</p>
          <p className="empty-state-body">
            Every request going to this market has already been fully packed. Head back to the pack index for another destination.
          </p>
          <Link href="/pack" className="empty-state-cta">
            → Pack
          </Link>
        </div>
      </div>
    )
  }

  const draftCount = [...draft.values()].reduce((sum, d) => sum + d.quantity, 0)
  const hasDraftOverAllocation = [...draft.values()].some(
    (d) => d.quantity > (warehouseStock.get(d.warehouseVariantId) ?? 0),
  )
  const variationById = new Map(variations.map((v) => [v.id, v]))

  // Requested-across-all-requests per variant. Powers the merged
  // "requested" counter next to each variant row.
  const requestedByVariant = new Map<string, number>()
  const requestedByRequestVariant = new Map<string, Map<string, number>>()
  const familyLevelRequestIds = new Map<string, Set<string>>()
  for (const r of requests) {
    let perR = requestedByRequestVariant.get(r.id)
    if (!perR) {
      perR = new Map()
      requestedByRequestVariant.set(r.id, perR)
    }
    for (const line of r.lines) {
      if (line.warehouseVariantId) {
        requestedByVariant.set(
          line.warehouseVariantId,
          (requestedByVariant.get(line.warehouseVariantId) ?? 0) + line.qtyRequested,
        )
        perR.set(
          line.warehouseVariantId,
          (perR.get(line.warehouseVariantId) ?? 0) + line.qtyRequested,
        )
      } else {
        const set = familyLevelRequestIds.get(line.variationId) ?? new Set<string>()
        set.add(r.id)
        familyLevelRequestIds.set(line.variationId, set)
      }
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Pack"
        title={locationName ?? 'Destination'}
        description={`${requests.length} open request${requests.length === 1 ? '' : 's'} going to this market. All lines are merged below. Pick which request the next box is for, fill it, click Pack this box, then repeat.`}
      />

      {error && <p className="error-banner" style={{ whiteSpace: 'pre-wrap' }}>{error}</p>}

      {(() => {
        // Re-pack banner: any PACKING box whose ownership sits entirely
        // inside the currently-scoped requests will be replaced by the
        // next Pack this box click. Same rule as submitBox so the
        // operator sees exactly what's about to be rewritten.
        const scopedIds = new Set(requests.map((r) => r.id))
        const willReplace = boxes.filter((box) => {
          if (box.state !== 'PACKING') return false
          const ids = new Set<string>()
          if (box.requestId) ids.add(box.requestId)
          for (const line of box.lines) if (line.requestId) ids.add(line.requestId)
          if (ids.size === 0) return false
          let touchesScope = false
          for (const id of ids) {
            if (!scopedIds.has(id)) return false
            touchesScope = true
          }
          return touchesScope
        })
        if (willReplace.length === 0) return null
        const willReplaceUnits = willReplace.reduce(
          (sum, b) => sum + b.lines.reduce((s, l) => s + l.quantity, 0),
          0,
        )
        return (
          <div
            className="card"
            style={{
              marginBottom: 20,
              borderColor: 'var(--signal, #b58a2c)',
              background: 'var(--surface-sunken)',
            }}
          >
            <strong>Re-packing this shipment</strong>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)', marginTop: 4 }}>
              {willReplace.length} existing PACKING box{willReplace.length === 1 ? '' : 'es'} (
              {willReplaceUnits} unit{willReplaceUnits === 1 ? '' : 's'}) will be replaced when you
              click Pack this box.
            </div>
          </div>
        )
      })()}

      <div className="section-heading">
        <h2>Requests to this destination</h2>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {requests.map((r) => (
          <Link
            key={r.id}
            href={`/pack/${r.id}`}
            className={`chip ${r.state === 'PACKING' ? 'chip-signal' : ''}`}
            style={{ cursor: 'pointer' }}
            title="Open just this one request in the single-request pack view"
          >
            {r.state.toLowerCase()} · {r.lines.length} line{r.lines.length === 1 ? '' : 's'} ·{' '}
            {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </Link>
        ))}
      </div>

      {availableSiblings.length > 0 && (
        <div
          className="card"
          style={{
            marginBottom: 20,
            borderColor: 'var(--pine)',
            background: 'var(--surface)',
          }}
        >
          <div className="row-between" style={{ marginBottom: 10 }}>
            <div>
              <strong>Add another request to this box</strong>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: 2 }}>
                {availableSiblings.length} other open request
                {availableSiblings.length === 1 ? '' : 's'} going to this market — fold any of them into the current draft.
              </div>
            </div>
            {availableSiblings.length > 1 && (
              <button
                type="button"
                onClick={addAllSiblings}
                style={{
                  all: 'unset',
                  fontSize: '0.78rem',
                  color: 'var(--signal, #b58a2c)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  whiteSpace: 'nowrap',
                }}
              >
                Add all {availableSiblings.length} →
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {availableSiblings.map((s) => {
              const units = s.lines.reduce((sum, l) => sum + l.qtyRequested, 0)
              // Distinct product names on the sibling — the request id
              // alone doesn't say what's inside.
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
                    flexWrap: 'wrap',
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
                  <button
                    type="button"
                    onClick={() => addSibling(s.id)}
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
                      border: '1px solid var(--signal, #b58a2c)',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                    title={`Merge #${s.id.slice(0, 6)} into this box`}
                  >
                    + Add to this box
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <SectionHeading
        title="Resolve to variants"
        description={
          <>
            One card per product family across every request. The <em>requested</em> total is the sum of what every
            open request to this market wants; the <em>packed</em> total is what&apos;s already in boxes for this
            destination.
          </>
        }
      />

      {(() => {
        // Group EVERY line from EVERY request by variation, preserving
        // which request(s) each line belongs to. Family-level lines are
        // flagged so their expansion shows every warehouse variant.
        interface FamilyGroup {
          variationId: string
          familyTotalRequested: number
          familyPacked: number
          variantTargets: Map<string, number>          // wvId → total requested across all requests
          hasFamilyLevelLine: boolean
        }
        const groups = new Map<string, FamilyGroup>()
        for (const r of requests) {
          for (const line of r.lines) {
            const g: FamilyGroup = groups.get(line.variationId) ?? {
              variationId: line.variationId,
              familyTotalRequested: 0,
              familyPacked: 0,
              variantTargets: new Map(),
              hasFamilyLevelLine: false,
            }
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
        }
        // Compute family-level packed AFTER: sum packed for every variant
        // in that family across all boxes for this destination.
        for (const g of groups.values()) {
          // Collect every wv id that belongs to this family via any request line.
          const allVariantIds = new Set<string>()
          for (const r of requests) {
            for (const line of r.lines) {
              if (line.variationId !== g.variationId) continue
              const list = variantsByLine[line.id] ?? []
              for (const v of list) allVariantIds.add(v.id)
            }
          }
          for (const id of allVariantIds) g.familyPacked += packedTotalForVariant(id)
        }

        function variantsForFamily(g: FamilyGroup): WarehouseVariantSummary[] {
          const seen = new Map<string, WarehouseVariantSummary>()
          for (const r of requests) {
            for (const line of r.lines) {
              if (line.variationId !== g.variationId) continue
              for (const v of variantsByLine[line.id] ?? []) seen.set(v.id, v)
            }
          }
          return [...seen.values()]
        }

        return (
          <div className="stack" style={{ marginBottom: 24 }}>
            {[...groups.values()].map((g) => {
              const familyMeta = variationById.get(g.variationId)
              const familyVariants = variantsForFamily(g)
              const requestedVariantIds = new Set(g.variantTargets.keys())
              const shownVariants = g.hasFamilyLevelLine
                ? familyVariants
                : familyVariants.filter((v) => requestedVariantIds.has(v.id))
              const familyRemaining = g.familyTotalRequested - g.familyPacked
              const open = openFamilies.has(g.variationId)

              return (
                <div key={g.variationId} className="card">
                  <button
                    onClick={() =>
                      setOpenFamilies((prev) => {
                        const next = new Set(prev)
                        if (next.has(g.variationId)) next.delete(g.variationId)
                        else next.add(g.variationId)
                        return next
                      })
                    }
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
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="eyebrow" style={{ color: 'var(--text-faint)', marginBottom: 2 }}>
                        packed / requested
                      </div>
                      <div className="mono" style={{ fontWeight: 700 }}>
                        {g.familyPacked} / {g.familyTotalRequested}
                      </div>
                      <span className={`chip ${familyRemaining <= 0 ? 'chip-pine' : 'chip-rust'}`}>
                        {familyRemaining <= 0 ? 'resolved' : `${familyRemaining} left`}
                      </span>
                    </div>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={{
                        color: 'var(--text-faint)',
                        marginLeft: 6,
                        flexShrink: 0,
                        transition: 'transform 0.15s ease',
                        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {open && (
                    <div className="list" style={{ marginTop: 14 }}>
                      {shownVariants.map((v) => {
                        const totalRequested = g.variantTargets.get(v.id) ?? null
                        const totalPacked = packedTotalForVariant(v.id)
                        const draftQty = draft.get(v.id)?.quantity ?? 0
                        const warehouseOnHand = warehouseStock.get(v.id) ?? 0
                        const overAllocated = draftQty > warehouseOnHand
                        // Per-request breakdown for this variant so the
                        // operator sees which request wants how many.
                        const perRequestTargets: Array<{ id: string; label: string; qty: number; packed: number }> = []
                        for (const r of requests) {
                          const qty = requestedByRequestVariant.get(r.id)?.get(v.id) ?? 0
                          if (qty === 0) continue
                          perRequestTargets.push({
                            id: r.id,
                            label: `#${r.id.slice(0, 6)}`,
                            qty,
                            packed: packedForRequestVariant(r.id, v.id),
                          })
                        }
                        return (
                          <div
                            key={v.id}
                            className="list-row"
                            style={{
                              border: overAllocated ? '1px solid var(--danger, #c0392b)' : '1px solid var(--line)',
                              alignItems: 'flex-start',
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
                                {totalRequested != null && (
                                  <span className="chip chip-signal" style={{ marginLeft: 8, fontSize: '0.6rem' }}>
                                    requested {totalRequested}
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
                                {totalRequested != null && ` · packed ${totalPacked} / ${totalRequested}`}
                              </div>
                              {perRequestTargets.length > 1 && (
                                <div style={{ marginTop: 4, fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                                  {perRequestTargets.map((t, i) => (
                                    <span key={t.id}>
                                      {i > 0 && ' · '}
                                      {t.label}: {t.packed}/{t.qty}
                                    </span>
                                  ))}
                                </div>
                              )}
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
        <div className="row-between" style={{ marginBottom: 10 }}>
          <div>
            <span className="eyebrow" style={{ display: 'block', marginBottom: 2 }}>
              Current draft
            </span>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              Units are auto-allocated to whichever of the {requests.length} request
              {requests.length === 1 ? '' : 's'} still wants them (oldest first). Each request
              gets its own dispatched box.
            </span>
          </div>
          <span className="mono" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
            {draftCount} unit{draftCount === 1 ? '' : 's'}
          </span>
        </div>
        {hasDraftOverAllocation && (
          <div
            style={{
              marginBottom: 10,
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--danger-soft, #fdecea)',
              color: 'var(--danger, #c0392b)',
              fontSize: '0.8rem',
              fontWeight: 600,
            }}
          >
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

      {(() => {
        // Only show boxes that touch a currently-scoped request. Other
        // boxes at this destination belong to different requests and
        // pop up in their own dest / request views — surfacing them
        // here just distracts from the pack-and-dispatch loop for the
        // ones the operator picked.
        const scopedIds = new Set(requests.map((r) => r.id))
        const relevantBoxes = boxes.filter((box) => {
          if (box.requestId && scopedIds.has(box.requestId)) return true
          for (const line of box.lines) if (line.requestId && scopedIds.has(line.requestId)) return true
          return false
        })
        return (
          <>
            <div className="section-heading">
              <h2>Boxes</h2>
              <span className="eyebrow">{relevantBoxes.length}</span>
            </div>
            {relevantBoxes.length === 0 ? (
              <div className="card">
                <p style={{ margin: 0, color: 'var(--text-dim)' }}>No boxes packed yet.</p>
              </div>
            ) : (
              <div className="stack">
                {relevantBoxes.map((box) => {
                  // Every distinct request this box helps fulfil, drawn from
                  // both the box-level pin (single-request path) and the
                  // per-line requestIds (multi-request path).
                  const involvedRequestIds = new Set<string>()
                  if (box.requestId) involvedRequestIds.add(box.requestId)
                  for (const line of box.lines) if (line.requestId) involvedRequestIds.add(line.requestId)
                  const requestsSummary =
                    involvedRequestIds.size === 0
                      ? null
                      : involvedRequestIds.size === 1
                        ? `request #${[...involvedRequestIds][0]!.slice(0, 6)}`
                        : `${involvedRequestIds.size} requests: ${[...involvedRequestIds]
                          .map((id) => `#${id.slice(0, 6)}`)
                          .join(', ')}`
                  return (
                    <div key={box.id} className="card">
                      <div className="row-between">
                        <div>
                          <div className="list-row-title mono">{box.id.slice(0, 8)}</div>
                          <div className="list-row-meta">
                            {box.lines.length} line{box.lines.length === 1 ? '' : 's'}
                            {requestsSummary && ` · ${requestsSummary}`}
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
                  )
                })}
              </div>
            )}
          </>
        )
      })()}
    </div>
  )
}

export default function DestinationPackPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']}>
      <DestinationPackBody />
    </RequireAuth>
  )
}
