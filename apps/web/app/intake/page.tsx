'use client'

import { useEffect, useMemo, useState } from 'react'
import type {
  CategoryDto,
  ColourFamilyDto,
  IntakeResult,
  SizeOptionDto,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { Swatch } from '../../components/Swatch'
import { useAuth } from '../../lib/auth-context'
import {
  ApiError,
  createWarehouseVariant,
  listCategories,
  listColourFamilies,
  listSizeOptions,
  listVariations,
  listWarehouseVariants,
  receiveIntake,
} from '../../lib/api'
import { useToast } from '../../lib/toast'

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
    return variations
      .filter((v) =>
        `${v.itemGroupName} ${v.colourFamilyName} ${v.sizeOptionName}`.toLowerCase().includes(q),
      )
      .filter((v) => !takenIds.has(v.id))
      .slice(0, 10)
  }, [query, variations, families])

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

  async function onCreated(newVariant: WarehouseVariantSummary) {
    setCreating(false)
    // Refresh so the new variant is available under its family and can
    // be selected without a page reload.
    const [freshVariations, freshVariants] = await Promise.all([listVariations(), listWarehouseVariants()])
    setVariations(freshVariations)
    setVariants(freshVariants)
    const parentFamily = freshVariations.find((v) => v.id === newVariant.variationId)
    if (parentFamily) {
      const already = families.find((f) => f.variationId === parentFamily.id)
      if (!already) {
        addFamilyFromVariations(parentFamily, freshVariants)
      } else {
        setOpenId(parentFamily.id)
      }
    }
    toast.success(`Created ${newVariant.itemGroupName} · ${newVariant.colourVariantName}`)
  }

  /// Helper for onCreated -- we need to seed a DraftFamily with freshly
  /// fetched variants (not the stale state closure).
  function addFamilyFromVariations(v: VariationSummary, allVariants: WarehouseVariantSummary[]) {
    const familyVariants = allVariants.filter((wv) => wv.variationId === v.id)
    familyVariants.sort((a, b) => a.colourVariantName.localeCompare(b.colourVariantName))
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
        variants: familyVariants,
        qtyByVariant: initialQty,
        tokenByVariant: tokens,
        note: '',
      },
    ])
    setOpenId(v.id)
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
          placeholder="Search item, colour family, size, or SKU…"
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
                <Swatch familyName={v.colourFamilyName} />
                <div className="list-row-body">
                  <div className="list-row-title">{v.itemGroupName}</div>
                  <div className="list-row-meta">
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
            {/* {canCreate
              ? 'If this really is a new product, create it now:'
              : "Product creation is warehouse-manager only — ask them to add it."} */}
          </p>
          {/* {canCreate && (
            <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
              + Create new product
            </button>
          )} */}
        </div>
      ) : null}

      <div className="section-heading">
        <h2>Items being received</h2>
        <span className="eyebrow">
          {lineCount} line{lineCount === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
        </span>
      </div>

      {families.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>Search above to add what just arrived.</p>
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
                    <Swatch familyName={f.familyName} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="list-row-title">{f.itemGroupName}</div>
                      <div className="list-row-meta">
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
                            <Swatch familyName={v.colourVariantName} />
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
        <NewProductModal initialItemGroup={query} onClose={() => setCreating(false)} onCreated={onCreated} />
      )}
    </div>
  )
}

function NewProductModal({
  initialItemGroup,
  onClose,
  onCreated,
}: {
  initialItemGroup: string
  onClose: () => void
  onCreated: (v: WarehouseVariantSummary) => void
}) {
  const toast = useToast()
  const [categories, setCategories] = useState<CategoryDto[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [families, setFamilies] = useState<ColourFamilyDto[]>([])
  const [colourFamilyId, setColourFamilyId] = useState('')
  const [sizes, setSizes] = useState<SizeOptionDto[]>([])
  const [sizeOptionId, setSizeOptionId] = useState('')
  const [itemGroupName, setItemGroupName] = useState(initialItemGroup)
  const [colourVariantName, setColourVariantName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listCategories()
      .then((rows) => {
        setCategories(rows)
        if (rows.length > 0) setCategoryId(rows[0]!.id)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load categories.'))
  }, [])

  useEffect(() => {
    if (!categoryId) return
    // Reset dependent selections when the category changes -- a family/size
    // from the previous category would fail server-side validation anyway.
    setColourFamilyId('')
    setSizeOptionId('')
    Promise.all([listColourFamilies(categoryId), listSizeOptions(categoryId)])
      .then(([f, s]) => {
        setFamilies(f)
        setSizes(s)
        if (f.length > 0) setColourFamilyId(f[0]!.id)
        if (s.length > 0) setSizeOptionId(s[0]!.id)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load vocabulary.'))
  }, [categoryId])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await createWarehouseVariant({
        categoryId,
        colourFamilyId,
        sizeOptionId,
        itemGroupName: itemGroupName.trim(),
        colourVariantName: colourVariantName.trim(),
      })
      onCreated(created)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not create the product.'
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  const canSubmit =
    !busy &&
    categoryId.length > 0 &&
    colourFamilyId.length > 0 &&
    sizeOptionId.length > 0 &&
    itemGroupName.trim().length > 0 &&
    colourVariantName.trim().length > 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h2>New product</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <p className="error-banner">{error}</p>}

        <p className="section-desc" style={{ marginTop: 0 }}>
          Category, colour family, and size come from the controlled vocabulary. Item name and colour variant can be new
          — we'll reuse an existing row if the spelling already matches.
        </p>

        <div className="field">
          <label htmlFor="np-category">Category</label>
          <select id="np-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="np-item">Item name</label>
          <input
            id="np-item"
            placeholder="e.g. Merino Beanie"
            value={itemGroupName}
            onChange={(e) => setItemGroupName(e.target.value)}
            maxLength={120}
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="np-family">Colour family</label>
          <select
            id="np-family"
            value={colourFamilyId}
            onChange={(e) => setColourFamilyId(e.target.value)}
            disabled={families.length === 0}
          >
            {families.length === 0 && <option value="">—</option>}
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="np-variant">Colour variant name</label>
          <input
            id="np-variant"
            placeholder="e.g. 40 Charcoal"
            value={colourVariantName}
            onChange={(e) => setColourVariantName(e.target.value)}
            maxLength={120}
          />
        </div>

        <div className="field">
          <label htmlFor="np-size">Size</label>
          <select
            id="np-size"
            value={sizeOptionId}
            onChange={(e) => setSizeOptionId(e.target.value)}
            disabled={sizes.length === 0}
          >
            {sizes.length === 0 && <option value="">—</option>}
            {sizes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {busy ? 'Creating…' : 'Create product'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function IntakePage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']}>
      <IntakeBody />
    </RequireAuth>
  )
}
