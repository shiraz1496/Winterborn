'use client'

import { useEffect, useMemo, useState } from 'react'
import type {
  IntakeResult,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { FolderChainPicker } from '../../components/FolderChainPicker'
import { PageHeader } from '../../components/PageHeader'
import { ProductThumb, firstPhoto } from '../../components/ProductThumb'
import { RequireAuth } from '../../components/RequireAuth'
import { useAuth } from '../../lib/auth-context'
import {
  ApiError,
  createProduct,
  listVariations,
  listWarehouseVariants,
  receiveIntake,
} from '../../lib/api'
import { useToast } from '../../lib/toast'

/// Duplicated from lib/photo-upload.ts rather than imported statically --
/// that module pulls in browser-image-compression, and a static import
/// would ship it in every intake-page bundle regardless of viewport. The
/// real functions are dynamically imported only where photo capture is
/// actually reachable (mobile/tablet), so desktop never fetches that chunk.
const MAX_PHOTOS_PER_SKU = 8

/// Camera/upload photo capture only makes sense on the device staff
/// actually does intake on -- a phone or tablet in the warehouse, not a
/// desktop browser. Re-checks on resize/orientation change so rotating a
/// tablet doesn't lose the affordance mid-form.
function useIsMobileOrTablet(breakpoint = 1024): boolean {
  const [isSmall, setIsSmall] = useState(false)
  useEffect(() => {
    const check = () => setIsSmall(window.innerWidth < breakpoint)
    check()
    window.addEventListener('resize', check)
    window.addEventListener('orientationchange', check)
    return () => {
      window.removeEventListener('resize', check)
      window.removeEventListener('orientationchange', check)
    }
  }, [breakpoint])
  return isSmall
}

/// Doc 3 §3.1. Receive inventory: pick a warehouse SKU, enter quantity,
/// confirm. Mirrors the New Request page's UX so warehouse staff never
/// have to relearn a second pattern -- search a family, expand it, enter
/// per-variant counts for what actually arrived, submit.
///
/// One `receiveIntake` call is fired per variant with qty > 0, each
/// tagged with its own idempotency token so a retried submit lands one
/// row per variant (not two, not zero).

function newIdempotencyToken(): string {
  // crypto.randomUUID() exists in modern browsers and Node 20+, but guard
  // against very old iOS Safari (< 15.4) so a warehouse tablet from 2019
  // still receives inventory. The fallback is not cryptographic; it does
  // not need to be -- the token only namespaces one operator's own retries.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/// One family being received. Contains a per-variant qty map so an
/// operator can log "3 Navy + 2 Sky Blue" under the same family in one
/// submit. Each variant has its own idempotency token, rotated after a
/// successful submit, so a mid-submit retry never double-counts.
interface DraftFamily {
  variationId: string
  itemGroupName: string
  familyName: string
  sizeName: string
  /// Root-first ancestor chain incl. the leaf folder. Carried through
  /// from the search result so the "items being received" row matches
  /// the picker row (same "Miscellaneous › Buiji (fake) Silk" trail).
  categoryPath: string[]
  variants: WarehouseVariantSummary[]
  qtyByVariant: Record<string, number>
  tokenByVariant: Record<string, string>
  note: string
}

interface FamilyResult {
  variationId: string
  itemGroupName: string
  familyName: string
  sizeName: string
  lines: Array<{ colourVariantName: string; quantity: number; onHand: number; created: boolean }>
}

const CREATOR_ROLES = ['OWNER', 'WAREHOUSE_MANAGER'] as const

function IntakeBody() {
  const toast = useToast()
  const { user } = useAuth()
  const canCreate = user ? CREATOR_ROLES.includes(user.role as (typeof CREATOR_ROLES)[number]) : false

  const [variations, setVariations] = useState<VariationSummary[]>([])
  const [variants, setVariants] = useState<WarehouseVariantSummary[]>([])
  const [query, setQuery] = useState('')
  const [families, setFamilies] = useState<DraftFamily[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [lastResults, setLastResults] = useState<FamilyResult[]>([])

  useEffect(() => {
    Promise.all([listVariations(), listWarehouseVariants()])
      .then(([v, wv]) => {
        setVariations(v)
        setVariants(wv)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the warehouse catalog.'))
  }, [])

  const variantsByVariation = useMemo(() => {
    const m = new Map<string, WarehouseVariantSummary[]>()
    for (const wv of variants) {
      const list = m.get(wv.variationId) ?? []
      list.push(wv)
      m.set(wv.variationId, list)
    }
    for (const [, list] of m) list.sort((a, b) => a.colourVariantName.localeCompare(b.colourVariantName))
    return m
  }, [variants])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const takenIds = new Set(families.map((f) => f.variationId))
    // Variations whose SKU or specific colour-variant name matches —
    // both live on WarehouseVariantSummary, not VariationSummary, so we
    // pre-index them once and OR into the main filter. `colourVariantName`
    // is the operator-visible colour ("Dark Gray"), distinct from the
    // family bucket ("Gray") on the variation itself.
    const variantSideMatchIds = new Set(
      variants
        .filter(
          (wv) =>
            wv.warehouseSku.toLowerCase().includes(q) ||
            wv.colourVariantName.toLowerCase().includes(q),
        )
        .map((wv) => wv.variationId),
    )
    return variations
      .filter((v) => {
        if (variantSideMatchIds.has(v.id)) return true
        // Searching against the full folder path (not just the leaf) so a
        // parent-folder query like "Scarves" surfaces every product under
        // "Scarves > Scarves (Peru)" and "Scarves > Scarves (Ecuador)"
        // — consistent with the catalog deep-search behaviour.
        const haystack = [
          ...v.categoryPath,
          v.itemGroupName,
          v.colourFamilyName,
          v.sizeOptionName,
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
      .filter((v) => !takenIds.has(v.id))
      .slice(0, 10)
  }, [query, variations, variants, families])

  function addFamily(v: VariationSummary) {
    const familyVariants = variantsByVariation.get(v.id) ?? []
    // If there's only one variant under this family, pre-fill it with 1
    // so a common case (single-variant SKU) is a one-tap intake.
    const initialQty: Record<string, number> = {}
    if (familyVariants.length === 1) initialQty[familyVariants[0]!.id] = 1
    const tokens: Record<string, string> = {}
    for (const wv of familyVariants) tokens[wv.id] = newIdempotencyToken()
    setFamilies((prev) => [
      ...prev,
      {
        variationId: v.id,
        itemGroupName: v.itemGroupName,
        familyName: v.colourFamilyName,
        sizeName: v.sizeOptionName,
        categoryPath: v.categoryPath,
        variants: familyVariants,
        qtyByVariant: initialQty,
        tokenByVariant: tokens,
        note: '',
      },
    ])
    setOpenId(v.id)
    setQuery('')
  }

  function setVariantQty(familyId: string, variantId: string, qty: number) {
    setFamilies((prev) =>
      prev.map((f) => {
        if (f.variationId !== familyId) return f
        const next = { ...f.qtyByVariant }
        const clamped = Math.max(0, Math.floor(qty))
        if (clamped === 0) delete next[variantId]
        else next[variantId] = clamped
        return { ...f, qtyByVariant: next }
      }),
    )
  }

  function bumpVariant(familyId: string, variantId: string, delta: number) {
    setFamilies((prev) =>
      prev.map((f) => {
        if (f.variationId !== familyId) return f
        const current = f.qtyByVariant[variantId] ?? 0
        const next = { ...f.qtyByVariant }
        const clamped = Math.max(0, current + delta)
        if (clamped === 0) delete next[variantId]
        else next[variantId] = clamped
        return { ...f, qtyByVariant: next }
      }),
    )
  }

  function setNote(familyId: string, note: string) {
    setFamilies((prev) => prev.map((f) => (f.variationId === familyId ? { ...f, note } : f)))
  }

  function removeFamily(familyId: string) {
    setFamilies((prev) => prev.filter((f) => f.variationId !== familyId))
    if (openId === familyId) setOpenId(null)
  }

  const totalUnits = useMemo(
    () => families.reduce((sum, f) => sum + Object.values(f.qtyByVariant).reduce((s, n) => s + n, 0), 0),
    [families],
  )
  const lineCount = useMemo(
    () => families.reduce((sum, f) => sum + Object.values(f.qtyByVariant).filter((q) => q > 0).length, 0),
    [families],
  )

  async function submit() {
    if (lineCount === 0) return
    setBusy(true)
    setError(null)
    const results: FamilyResult[] = []
    try {
      for (const f of families) {
        const entries = Object.entries(f.qtyByVariant).filter(([, q]) => q > 0)
        if (entries.length === 0) continue
        const lines: FamilyResult['lines'] = []
        for (const [variantId, qty] of entries) {
          const v = f.variants.find((x) => x.id === variantId)
          if (!v) continue
          const res = await receiveIntake({
            warehouseVariantId: variantId,
            quantity: qty,
            idempotencyToken: f.tokenByVariant[variantId] ?? newIdempotencyToken(),
            note: f.note.trim() || undefined,
          })
          lines.push({ colourVariantName: v.colourVariantName, quantity: qty, onHand: res.onHand, created: res.created })
        }
        results.push({
          variationId: f.variationId,
          itemGroupName: f.itemGroupName,
          familyName: f.familyName,
          sizeName: f.sizeName,
          lines,
        })
      }
      setLastResults(results)
      toast.success(`Recorded intake — ${totalUnits} unit${totalUnits === 1 ? '' : 's'} across ${lineCount} variant${lineCount === 1 ? '' : 's'}`)
      setFamilies([])
      setOpenId(null)
      setQuery('')
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not record the intake.'
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  /// The matrix modal creates its SKUs and records their INTAKE events
  /// itself, so all we need to do here is refresh the local catalog
  /// cache (so the search dropdown finds the new items immediately) and
  /// confirm to the operator that it landed. No auto-add to the intake
  /// queue — that would double-count any qty the operator entered.
  async function onProductCreated(summary: { skusCreated: number; totalUnitsRecorded: number; itemGroupName: string }) {
    setCreating(false)
    const [freshVariations, freshVariants] = await Promise.all([listVariations(), listWarehouseVariants()])
    setVariations(freshVariations)
    setVariants(freshVariants)
    toast.success(
      `Created ${summary.itemGroupName} — ${summary.skusCreated} SKU${summary.skusCreated === 1 ? '' : 's'}` +
      (summary.totalUnitsRecorded > 0
        ? `, ${summary.totalUnitsRecorded} unit${summary.totalUnitsRecorded === 1 ? '' : 's'} recorded`
        : ''),
    )
  }

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse only"
        title="Receive inventory"
        description="Log stock that just arrived. Search a product, expand it to enter counts per colour variant, then confirm. Each variant lands on its own ledger row so future dispatches can pull the right colour."
      />

      {error && <p className="error-banner">{error}</p>}

      {lastResults.length > 0 && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--pine)' }}>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <strong>Last intake</strong>
            <button type="button" className="btn btn-ghost" style={{ minHeight: 28, padding: '4px 10px' }} onClick={() => setLastResults([])}>
              Clear
            </button>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            {lastResults.map((r) => (
              <div key={r.variationId} style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <div className="list-row-title">{r.itemGroupName}</div>
                <div className="list-row-meta" style={{ marginBottom: 6 }}>
                  {r.familyName} · {r.sizeName}
                </div>
                {r.lines.map((l) => (
                  <div
                    key={`${r.variationId}:${l.colourVariantName}`}
                    className="row-between"
                    style={{ padding: '2px 0' }}
                  >
                    <span>{l.colourVariantName}</span>
                    <span className="mono">
                      {l.created ? '+' : '='}
                      {l.quantity} · on hand {l.onHand}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="intake-search">Add a product</label>
        <input
          id="intake-search"
          placeholder="Search folder, item, colour, colour family, size, or SKU…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </div>

      {matches.length > 0 ? (
        <div className="list" style={{ marginBottom: 20 }}>
          {matches.map((v) => {
            const variantCount = variantsByVariation.get(v.id)?.length ?? 0
            return (
              <button
                key={v.id}
                onClick={() => addFamily(v)}
                className="list-row"
                style={{ border: '1px solid var(--line-strong)', textAlign: 'left', width: '100%' }}
              >
                <ProductThumb
                  photoUrl={firstPhoto(variantsByVariation.get(v.id) ?? [])}
                  familyName={v.colourFamilyName}
                  alt={v.itemGroupName}
                />
                <div className="list-row-body">
                  <div className="list-row-title">{v.itemGroupName}</div>
                  <div className="list-row-meta">
                    <span style={{ color: 'var(--text-faint)' }}>
                      {(v.categoryPath.length > 1 ? v.categoryPath.slice(1) : v.categoryPath).join(' › ')} ·{' '}
                    </span>
                    {v.colourFamilyName} · {v.sizeOptionName}
                  </div>
                </div>
                <span className="chip">
                  {variantCount} variant{variantCount === 1 ? '' : 's'}
                </span>
              </button>
            )
          })}
        </div>
      ) : query.length > 0 ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            No product matched.{' '}
            {canCreate
              ? 'If this really is a new product, create it now:'
              : "Product creation is warehouse-manager only — ask them to add it."}
          </p>
          {canCreate && (
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
              + Create new product
            </button>
          )}
        </div>
      ) : null}

      <div className="section-heading">
        <h2>Items being received</h2>
        <span className="eyebrow">
          {lineCount} line{lineCount === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
        </span>
      </div>

      {families.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing added yet</p>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
            Use the search above to add products that just arrived.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ marginBottom: 24 }}>
          {families.map((f) => {
            const familyTotal = Object.values(f.qtyByVariant).reduce((s, n) => s + n, 0)
            const open = openId === f.variationId
            return (
              <div key={f.variationId} className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : f.variationId)}
                    style={{
                      all: 'unset',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flex: 1,
                      minWidth: 0,
                      cursor: 'pointer',
                    }}
                  >
                    <ProductThumb
                      photoUrl={firstPhoto(f.variants)}
                      familyName={f.familyName}
                      alt={f.itemGroupName}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="list-row-title">{f.itemGroupName}</div>
                      <div className="list-row-meta">
                        <span style={{ color: 'var(--text-faint)' }}>
                          {(f.categoryPath.length > 1 ? f.categoryPath.slice(1) : f.categoryPath).join(' › ')} ·{' '}
                        </span>
                        {f.familyName} · {f.sizeName}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                        {familyTotal}
                      </div>
                      <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>
                        {f.variants.length} variant{f.variants.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => removeFamily(f.variationId)}
                    aria-label="Remove"
                    style={{ minHeight: 40, padding: '6px 10px' }}
                  >
                    ✕
                  </button>
                </div>

                {open && (
                  <div className="stack" style={{ marginTop: 14, gap: 8 }}>
                    {f.variants.length === 0 ? (
                      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                        No variants configured for this family — cannot record intake.
                      </p>
                    ) : (
                      f.variants.map((v) => {
                        const qty = f.qtyByVariant[v.id] ?? 0
                        return (
                          <div key={v.id} className="list-row" style={{ border: '1px solid var(--line)' }}>
                            <ProductThumb
                              photoUrl={v.photoUrl}
                              familyName={v.colourVariantName}
                              alt={v.colourVariantName}
                            />
                            <div className="list-row-body">
                              <div className="list-row-title">{v.colourVariantName}</div>
                              <div className="list-row-meta mono">{v.warehouseSku}</div>
                            </div>
                            <div className="stepper">
                              <button
                                className="stepper-btn"
                                onClick={() => bumpVariant(f.variationId, v.id, -1)}
                                disabled={qty <= 0}
                                aria-label="Decrease"
                              >
                                −
                              </button>
                              <input
                                type="number"
                                className="stepper-input"
                                min={0}
                                step={1}
                                value={qty}
                                onChange={(e) => setVariantQty(f.variationId, v.id, Number(e.target.value))}
                                onFocus={(e) => e.currentTarget.select()}
                                aria-label={`Quantity of ${v.colourVariantName}`}
                              />
                              <button
                                className="stepper-btn"
                                onClick={() => bumpVariant(f.variationId, v.id, 1)}
                                aria-label="Increase"
                              >
                                +
                              </button>
                              <button
                                className="stepper-btn"
                                onClick={() => bumpVariant(f.variationId, v.id, 10)}
                                aria-label="Add ten"
                              >
                                +10
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}

                    <div className="field" style={{ marginTop: 8 }}>
                      <label htmlFor={`note-${f.variationId}`}>Note (optional)</label>
                      <input
                        id={`note-${f.variationId}`}
                        placeholder="PO#, delivery batch, shade check…"
                        value={f.note}
                        onChange={(e) => setNote(f.variationId, e.target.value)}
                        maxLength={500}
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <button className="btn btn-primary" onClick={submit} disabled={busy || lineCount === 0}>
        {busy
          ? 'Recording…'
          : `Confirm intake${lineCount > 0 ? ` (${totalUnits} unit${totalUnits === 1 ? '' : 's'})` : ''}`}
      </button>

      {creating && (
        <NewProductModal initialItemGroup={query} onClose={() => setCreating(false)} onCreated={onProductCreated} />
      )}
    </div>
  )
}

const PRIMARY_AXIS_CANDIDATES = ['Size', 'Style'] as const

const NONE_KEY = '__none__'

function matrixKey(primary: string | null, colour: string | null): string {
  return `${primary ?? NONE_KEY}::${colour ?? NONE_KEY}`
}

function NewProductModal({
  initialItemGroup,
  onClose,
  onCreated,
}: {
  initialItemGroup: string
  onClose: () => void
  onCreated: (summary: { skusCreated: number; totalUnitsRecorded: number; itemGroupName: string }) => void
}) {
  const toast = useToast()
  const [chain, setChain] = useState<string[]>([])
  const [itemGroupName, setItemGroupName] = useState(initialItemGroup)
  const [primaryAxisName, setPrimaryAxisName] = useState<string | null>(null)
  const [addingCustomAxis, setAddingCustomAxis] = useState(false)
  const [customAxisDraft, setCustomAxisDraft] = useState('')
  const [primaryValues, setPrimaryValues] = useState<string[]>([])
  const [primaryPending, setPrimaryPending] = useState('')
  const [colors, setColors] = useState<string[]>([])
  const [colorPending, setColorPending] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [unitCostDollars, setUnitCostDollars] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [photosByCell, setPhotosByCell] = useState<Record<string, File[]>>({})
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({})
  const canAttachPhotos = useIsMobileOrTablet()

  const leafCategoryId = chain[chain.length - 1] ?? null

  async function addPhotos(primary: string | null, colour: string | null, fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    // Snapshot into a plain array before any `await` -- FileList is a live
    // reference tied to the <input>, and the caller clears the input's
    // value right after invoking this (so the same element can pick the
    // same file again later). Reading `fileList` after an await point would
    // silently see an already-emptied list.
    const files = Array.from(fileList)
    const key = matrixKey(primary, colour)
    setPhotoErrors((prev) => ({ ...prev, [key]: '' }))
    const room = Math.max(0, MAX_PHOTOS_PER_SKU - (photosByCell[key]?.length ?? 0))
    const dropped = files.length > room
    if (dropped) {
      setPhotoErrors((prev) => ({ ...prev, [key]: `Only ${MAX_PHOTOS_PER_SKU} photos per variant -- some were not added.` }))
    }
    const { prepareProductPhoto } = await import('../../lib/photo-upload')
    for (const file of files.slice(0, room)) {
      try {
        const prepared = await prepareProductPhoto(file)
        setPhotosByCell((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), prepared] }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not use that photo.'
        setPhotoErrors((prev) => ({ ...prev, [key]: msg }))
      }
    }
  }

  function removePhoto(primary: string | null, colour: string | null, index: number) {
    const key = matrixKey(primary, colour)
    setPhotosByCell((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((_, i) => i !== index) }))
  }

  function commitPrimaryValue() {
    const v = primaryPending.trim()
    if (!v || primaryValues.includes(v)) {
      setPrimaryPending('')
      return
    }
    setPrimaryValues((prev) => [...prev, v])
    setPrimaryPending('')
  }

  function removePrimaryValue(v: string) {
    setPrimaryValues((prev) => prev.filter((x) => x !== v))
    // Drop qty cells that referenced this value.
    setQuantities((prev) => {
      const next: Record<string, string> = {}
      for (const [k, val] of Object.entries(prev)) {
        if (!k.startsWith(`${v}::`)) next[k] = val
      }
      return next
    })
  }

  function commitColor() {
    const v = colorPending.trim()
    if (!v || colors.includes(v)) {
      setColorPending('')
      return
    }
    setColors((prev) => [...prev, v])
    setColorPending('')
  }

  function removeColor(v: string) {
    setColors((prev) => prev.filter((x) => x !== v))
    setQuantities((prev) => {
      const next: Record<string, string> = {}
      for (const [k, val] of Object.entries(prev)) {
        if (!k.endsWith(`::${v}`)) next[k] = val
      }
      return next
    })
  }

  function pickPrimaryAxis(name: string) {
    setPrimaryAxisName(name)
    setAddingCustomAxis(false)
    setCustomAxisDraft('')
  }

  function clearPrimaryAxis() {
    setPrimaryAxisName(null)
    setPrimaryValues([])
    setPrimaryPending('')
    // Rewrite existing keys: `primary::colour` → `__none__::colour`
    setQuantities((prev) => {
      const next: Record<string, string> = {}
      for (const [k, val] of Object.entries(prev)) {
        const [, colour] = k.split('::')
        if (colour !== undefined) next[`${NONE_KEY}::${colour}`] = val
      }
      return next
    })
  }

  function setCellQty(primary: string | null, colour: string | null, raw: string) {
    setQuantities((prev) => ({ ...prev, [matrixKey(primary, colour)]: raw }))
  }

  const rows: Array<string | null> = primaryAxisName && primaryValues.length > 0 ? primaryValues : [null]
  const cols: Array<string | null> = colors.length > 0 ? colors : [null]
  const { nonZeroCount, totalUnits } = useMemo(() => {
    let n = 0
    let units = 0
    for (const r of rows) {
      for (const c of cols) {
        const q = Number.parseInt(quantities[matrixKey(r, c)] ?? '0', 10)
        if (Number.isFinite(q) && q > 0) {
          n++
          units += q
        }
      }
    }
    return { nonZeroCount: n, totalUnits: units }
  }, [rows, cols, quantities])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (!leafCategoryId) throw new Error('Pick a folder for this product.')
      if (!itemGroupName.trim()) throw new Error('Product name is required.')
      if (primaryAxisName && primaryValues.length === 0) {
        throw new Error(`Add at least one ${primaryAxisName.toLowerCase()} value, or remove the axis.`)
      }
      const cost = unitCostDollars.trim()
      if (!cost) throw new Error('Unit cost is required.')
      const parsedCost = Number.parseFloat(cost)
      if (!Number.isFinite(parsedCost) || parsedCost < 0) throw new Error('Unit cost must be a number ≥ 0.')
      const unitCostCents = Math.round(parsedCost * 100)
      if (nonZeroCount === 0) throw new Error('Enter a quantity for at least one variant.')

      const quantitiesPayload: Record<string, number> = {}
      for (const r of rows) {
        for (const c of cols) {
          const raw = quantities[matrixKey(r, c)]
          if (!raw) continue
          const q = Number.parseInt(raw, 10)
          if (!Number.isFinite(q) || q <= 0) continue
          quantitiesPayload[matrixKey(r, c)] = q
        }
      }

      const cellsBeingCreated = Object.fromEntries(
        Object.entries(photosByCell).filter(([key]) => key in quantitiesPayload),
      )
      const hasPhotos = Object.values(cellsBeingCreated).some((files) => files.length > 0)
      const photoUrls = hasPhotos ? await (await import('../../lib/photo-upload')).uploadProductPhotos(cellsBeingCreated) : {}

      const res = await createProduct({
        categoryId: leafCategoryId,
        itemGroupName: itemGroupName.trim(),
        primaryAxis: primaryAxisName && primaryValues.length > 0
          ? { name: primaryAxisName, values: primaryValues }
          : null,
        colors,
        quantities: quantitiesPayload,
        unitCostCents,
        photoUrls,
      })
      onCreated({
        skusCreated: res.skusCreated,
        totalUnitsRecorded: res.totalUnitsRecorded,
        itemGroupName: itemGroupName.trim(),
      })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not create the product.'
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{ maxWidth: 720 }}
      >
        <div className="modal-head">
          <h2>New product</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <p className="error-banner">{error}</p>}

        <p className="section-desc" style={{ marginTop: 0 }}>
          Pick where this product lives, name it, define its variants (an optional Size / Style / custom axis, plus
          colours), and enter the quantity you have of each combination. Every non-zero cell becomes a SKU with an
          intake recorded at the primary warehouse.
        </p>

        <div className="field">
          <label>Folder</label>
          <FolderChainPicker value={chain} onChange={setChain} />
        </div>

        <div className="field">
          <label htmlFor="np-item">Product name</label>
          <input
            id="np-item"
            placeholder="e.g. Merino Beanie"
            value={itemGroupName}
            onChange={(e) => setItemGroupName(e.target.value)}
            maxLength={120}
          />
        </div>

        <div className="field">
          <label>Primary variant axis (optional)</label>
          {!primaryAxisName && !addingCustomAxis && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {PRIMARY_AXIS_CANDIDATES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="btn"
                  onClick={() => pickPrimaryAxis(name)}
                  style={{ minHeight: 32, padding: '4px 12px', fontSize: '0.82rem' }}
                >
                  + {name}
                </button>
              ))}
              <button
                type="button"
                className="btn"
                onClick={() => setAddingCustomAxis(true)}
                style={{ minHeight: 32, padding: '4px 12px', fontSize: '0.82rem' }}
              >
                + Custom axis…
              </button>
            </div>
          )}
          {!primaryAxisName && addingCustomAxis && (
            <div style={axisCardStyle}>
              <label style={labelStyle}>Custom axis name</label>
              <input
                autoFocus
                type="text"
                placeholder="e.g. Yarn count, Fit"
                value={customAxisDraft}
                onChange={(e) => setCustomAxisDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const n = customAxisDraft.trim()
                    if (n) pickPrimaryAxis(n)
                  } else if (e.key === 'Escape') {
                    setAddingCustomAxis(false)
                    setCustomAxisDraft('')
                  }
                }}
                style={inputStyle}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setAddingCustomAxis(false); setCustomAxisDraft('') }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!customAxisDraft.trim()}
                  onClick={() => {
                    const n = customAxisDraft.trim()
                    if (n) pickPrimaryAxis(n)
                  }}
                >
                  Add axis
                </button>
              </div>
            </div>
          )}
          {primaryAxisName && (
            <div style={axisCardStyle}>
              <div className="row-between" style={{ marginBottom: 6 }}>
                <strong style={{ fontSize: '0.9rem' }}>{primaryAxisName}</strong>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={clearPrimaryAxis}
                  style={{ minHeight: 24, padding: '2px 8px', fontSize: '0.75rem' }}
                >
                  Remove axis
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {primaryValues.map((v) => (
                  <span key={v} style={chipStyle}>
                    {v}
                    <span
                      onClick={() => removePrimaryValue(v)}
                      style={{ marginLeft: 6, cursor: 'pointer', opacity: 0.7 }}
                      aria-label="Remove value"
                    >
                      ×
                    </span>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  placeholder={`Add ${primaryAxisName.toLowerCase()} value`}
                  value={primaryPending}
                  onChange={(e) => setPrimaryPending(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitPrimaryValue()
                    }
                  }}
                  style={{ flex: 1, ...inputStyle }}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={commitPrimaryValue}
                  disabled={!primaryPending.trim()}
                  style={{ minHeight: 34, padding: '0 12px', fontSize: '0.82rem' }}
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="field">
          <label>Colours</label>
          <div style={axisCardStyle}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {colors.length === 0 && (
                <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>
                  Leave empty for products with no colour axis (e.g. Dryer Balls).
                </span>
              )}
              {colors.map((v) => (
                <span key={v} style={chipStyle}>
                  {v}
                  <span
                    onClick={() => removeColor(v)}
                    style={{ marginLeft: 6, cursor: 'pointer', opacity: 0.7 }}
                    aria-label="Remove colour"
                  >
                    ×
                  </span>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                placeholder="Add colour value"
                value={colorPending}
                onChange={(e) => setColorPending(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitColor()
                  }
                }}
                style={{ flex: 1, ...inputStyle }}
              />
              <button
                type="button"
                className="btn"
                onClick={commitColor}
                disabled={!colorPending.trim()}
                style={{ minHeight: 34, padding: '0 12px', fontSize: '0.82rem' }}
              >
                Add
              </button>
            </div>
          </div>
        </div>

        <div className="field">
          <label>Quantities</label>
          <MatrixTable
            rows={rows}
            cols={cols}
            primaryAxisLabel={primaryAxisName ?? ''}
            quantities={quantities}
            onCellChange={setCellQty}
          />
          <p style={{ margin: '6px 0 0', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
            One SKU is created per non-zero cell. Cells left at 0 aren't created; add them later via a fresh intake.
          </p>
        </div>

        {nonZeroCount > 0 && (
          <div className="field">
            <label>Photos</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rows.flatMap((r) =>
                cols
                  .filter((c) => {
                    const q = Number.parseInt(quantities[matrixKey(r, c)] ?? '0', 10)
                    return Number.isFinite(q) && q > 0
                  })
                  .map((c) => {
                    const key = matrixKey(r, c)
                    const label = [r, c].filter(Boolean).join(' · ') || itemGroupName.trim() || 'Product'
                    const files = photosByCell[key] ?? []
                    return (
                      <div key={key} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>{label}</span>
                          <div style={{ flex: 1 }} />
                          <label
                            className="btn btn-ghost"
                            style={{ minHeight: 30, padding: '0 10px', fontSize: '0.78rem', cursor: files.length >= MAX_PHOTOS_PER_SKU ? 'not-allowed' : 'pointer' }}
                          >
                            + Add photo
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              multiple
                              disabled={files.length >= MAX_PHOTOS_PER_SKU}
                              onChange={(e) => {
                                void addPhotos(r, c, e.target.files)
                                e.target.value = ''
                              }}
                              style={{ display: 'none' }}
                            />
                          </label>
                        </div>
                        {files.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {files.map((file, i) => (
                              <PhotoThumb key={i} file={file} onRemove={() => removePhoto(r, c, i)} />
                            ))}
                          </div>
                        )}
                        {photoErrors[key] && (
                          <p style={{ margin: '6px 0 0', color: 'var(--danger, #c0392b)', fontSize: '0.75rem' }}>{photoErrors[key]}</p>
                        )}
                      </div>
                    )
                  }),
              )}
            </div>
            <p style={{ margin: '6px 0 0', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
              Up to {MAX_PHOTOS_PER_SKU} photos per variant. Uploaded when you submit the product below.
            </p>
          </div>
        )}

        <div className="field">
          <label htmlFor="np-cost">Unit cost (USD)</label>
          <input
            id="np-cost"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 12.50"
            value={unitCostDollars}
            onChange={(e) => setUnitCostDollars(e.target.value)}
            required
          />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20, alignItems: 'center' }}>
          <span className="eyebrow" style={{ color: 'var(--text-dim)' }}>
            {nonZeroCount} SKU{nonZeroCount === 1 ? '' : 's'} · {totalUnits.toLocaleString()} unit{totalUnits === 1 ? '' : 's'}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !leafCategoryId || !itemGroupName.trim() || nonZeroCount === 0}
          >
            {busy ? 'Creating…' : 'Create product'}
          </button>
        </div>
      </form>
    </div>
  )
}

/// Local object URL per File, revoked on unmount/replacement so a long
/// intake session doesn't accumulate blob: URLs.
function PhotoThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div style={{ position: 'relative', width: 64, height: 64 }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local blob: preview, not an optimizable remote asset */}
      <img
        src={url}
        alt=""
        style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)' }}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove photo"
        style={{
          position: 'absolute',
          top: -6,
          right: -6,
          width: 20,
          height: 20,
          borderRadius: '50%',
          border: '1px solid var(--line)',
          background: 'var(--surface)',
          fontSize: '0.7rem',
          lineHeight: '18px',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  )
}

function MatrixTable({
  rows,
  cols,
  primaryAxisLabel,
  quantities,
  onCellChange,
}: {
  rows: Array<string | null>
  cols: Array<string | null>
  primaryAxisLabel: string
  quantities: Record<string, string>
  onCellChange: (primary: string | null, colour: string | null, raw: string) => void
}) {
  const hasPrimary = rows.length > 1 || (rows[0] !== null && rows[0] !== undefined)
  const hasColours = cols.length > 1 || (cols[0] !== null && cols[0] !== undefined)

  // 1×1 case (no primary axis, no colours) — the matrix collapses to a
  // single unlabelled input. Rendering it as a table with two dashed
  // headers looks like broken data; show a plain "Quantity" input
  // instead so it reads as "how many of this one product do you have?".
  if (!hasPrimary && !hasColours) {
    return (
      <input
        type="number"
        min={0}
        step={1}
        value={quantities[matrixKey(null, null)] ?? ''}
        onChange={(e) => onCellChange(null, null, e.target.value)}
        placeholder="0"
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--line)',
          background: 'var(--surface)',
          fontSize: '0.9rem',
          boxSizing: 'border-box',
        }}
      />
    )
  }

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ background: 'var(--surface-sunken)' }}>
            <th style={cellHeader}>{primaryAxisLabel || ''}</th>
            {cols.map((c, i) => (
              <th key={`col-${i}`} style={cellHeader}>
                {c ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`row-${i}`} style={{ borderTop: '1px solid var(--line)' }}>
              <th style={{ ...cellHeader, textAlign: 'left', background: 'var(--surface-raised)' }}>{r ?? ''}</th>
              {cols.map((c, j) => (
                <td key={`cell-${i}-${j}`} style={{ padding: 6 }}>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={quantities[matrixKey(r, c)] ?? ''}
                    onChange={(e) => onCellChange(r, c, e.target.value)}
                    placeholder="0"
                    style={{
                      width: '100%',
                      padding: '6px 8px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--line)',
                      background: 'var(--surface)',
                      fontSize: '0.85rem',
                      textAlign: 'right',
                      boxSizing: 'border-box',
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const cellHeader = {
  padding: '8px 10px',
  fontWeight: 700,
  fontSize: '0.78rem',
  textAlign: 'center' as const,
  color: 'var(--text-dim)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
}

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: '0.78rem',
  border: '1px solid var(--line-strong)',
  background: 'var(--surface)',
  color: 'var(--text-dim)',
} as const

const axisCardStyle = {
  padding: 10,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--line)',
  background: 'var(--surface-raised)',
} as const

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line)',
  fontSize: '0.9rem',
  background: 'var(--surface)',
  boxSizing: 'border-box' as const,
}

const labelStyle = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 700,
  marginBottom: 4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  color: 'var(--text-dim)',
}

export default function IntakePage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']}>
      <IntakeBody />
    </RequireAuth>
  )
}
