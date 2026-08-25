'use client'

import { useEffect, useMemo, useState } from 'react'
import type {
  CategoryDto,
  ColourFamilyDto,
  IntakeResult,
  SizeOptionDto,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { useAuth } from '../../lib/auth-context'
import {
  ApiError,
  createWarehouseVariant,
  listCategories,
  listColourFamilies,
  listSizeOptions,
  listWarehouseVariants,
  receiveIntake,
} from '../../lib/api'
import { useToast } from '../../lib/toast'

/// Doc 3 §3.1. Receive inventory: pick a warehouse SKU, enter quantity,
/// confirm. `idempotencyToken` is generated once when this component mounts
/// and rotated on every successful submit -- a double-tap on Confirm is a
/// retry (no second row); a fresh intake is a fresh token (yes, second row).
/// If the product doesn't exist yet, Owner and Warehouse Manager may create
/// it inline using the same controlled vocabulary already proven in the
/// catalogue migration.

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

interface Selected {
  wv: WarehouseVariantSummary
  qty: number
}

const CREATOR_ROLES = ['OWNER', 'WAREHOUSE_MANAGER'] as const

function IntakeBody() {
  const toast = useToast()
  const { user } = useAuth()
  const [variants, setVariants] = useState<WarehouseVariantSummary[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [token, setToken] = useState<string>(() => newIdempotencyToken())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [lastResult, setLastResult] = useState<
    (IntakeResult & { label: string }) | null
  >(null)

  const canCreate = user ? CREATOR_ROLES.includes(user.role as (typeof CREATOR_ROLES)[number]) : false

  async function refreshVariants(): Promise<WarehouseVariantSummary[]> {
    const next = await listWarehouseVariants()
    setVariants(next)
    return next
  }

  useEffect(() => {
    refreshVariants().catch((err) =>
      setError(err instanceof ApiError ? err.message : 'Could not load the warehouse catalog.'),
    )
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    return variants
      .filter((v) =>
        `${v.itemGroupName} ${v.colourVariantName} ${v.sizeOptionName} ${v.warehouseSku}`
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 10)
  }, [query, variants])

  async function submit() {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const result = await receiveIntake({
        warehouseVariantId: selected.wv.id,
        quantity: selected.qty,
        idempotencyToken: token,
        note: note.trim() || undefined,
      })
      const label = `${selected.wv.itemGroupName} · ${selected.wv.colourVariantName} · ${selected.wv.sizeOptionName}`
      setLastResult({ ...result, label })
      toast.success(
        result.created
          ? `Recorded intake of ${selected.qty} — on hand now ${result.onHand}`
          : `Already recorded (${selected.qty}) — on hand ${result.onHand}`,
      )
      // Rotate the token so the NEXT confirm is a fresh intake, not another
      // retry of the one we just wrote.
      setToken(newIdempotencyToken())
      setSelected(null)
      setNote('')
      setQuery('')
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not record the intake.'
      setError(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  function pick(wv: WarehouseVariantSummary) {
    setSelected({ wv, qty: 1 })
    setQuery('')
  }

  function bumpQty(delta: number) {
    setSelected((prev) => (prev ? { ...prev, qty: Math.max(1, prev.qty + delta) } : prev))
  }

  async function onCreated(newVariant: WarehouseVariantSummary) {
    setCreating(false)
    // Refresh the catalog list in the background so future searches see the
    // new row -- but don't block picking it, it's already in hand.
    refreshVariants().catch(() => undefined)
    pick(newVariant)
    toast.success(`Created ${newVariant.itemGroupName} · ${newVariant.colourVariantName}`)
  }

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse only"
        title="Receive inventory"
        description="Log stock that just arrived at the warehouse. Find the warehouse SKU, enter how many arrived, and confirm. The stock ledger updates immediately."
      />

      {error && <p className="error-banner">{error}</p>}

      {lastResult && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--pine)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{lastResult.created ? 'Recorded' : 'Already recorded'}</strong>
            <span className="chip chip-pine">On hand: {lastResult.onHand}</span>
          </div>
          <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>{lastResult.label}</p>
        </div>
      )}

      {!selected && (
        <>
          <div className="field">
            <label htmlFor="intake-search">Find a product</label>
            <input
              id="intake-search"
              placeholder="Search item, colour, size, or warehouse SKU…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>

          {matches.length > 0 ? (
            <div className="list" style={{ marginTop: 12 }}>
              {matches.map((v) => (
                <button
                  key={v.id}
                  onClick={() => pick(v)}
                  className="list-row"
                  style={{ border: '1px solid var(--line-strong)', textAlign: 'left', width: '100%' }}
                >
                  <div className="list-row-body">
                    <div className="list-row-title">{v.itemGroupName}</div>
                    <div className="list-row-meta">
                      {v.colourVariantName} · {v.sizeOptionName} · <span className="mono">{v.warehouseSku}</span>
                    </div>
                  </div>
                  <span className="eyebrow">Choose</span>
                </button>
              ))}
            </div>
          ) : query.length > 0 ? (
            <div className="card" style={{ marginTop: 12 }}>
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                No warehouse SKU matched.{' '}
                {canCreate
                  ? 'If this really is a new product, create it now:'
                  : "Product creation is warehouse-manager only — ask them to add it."}
              </p>
              {canCreate && (
                <button
                  type="button"
                  className="btn"
                  style={{ marginTop: 12 }}
                  onClick={() => setCreating(true)}
                >
                  + Create new product
                </button>
              )}
            </div>
          ) : null}
        </>
      )}

      {selected && (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="list-row-title">{selected.wv.itemGroupName}</div>
            <div className="list-row-meta" style={{ marginTop: 4 }}>
              {selected.wv.colourVariantName} · {selected.wv.sizeOptionName} ·{' '}
              <span className="mono">{selected.wv.warehouseSku}</span>
            </div>
          </div>

          <div className="field">
            <label>Quantity received</label>
            <div className="stepper" style={{ marginTop: 6 }}>
              <button className="stepper-btn" onClick={() => bumpQty(-1)} aria-label="Decrease">
                −
              </button>
              <span className="stepper-value">{selected.qty}</span>
              <button className="stepper-btn" onClick={() => bumpQty(1)} aria-label="Increase">
                +
              </button>
              <button className="stepper-btn" onClick={() => bumpQty(9)} aria-label="Add ten">
                +10
              </button>
              <button className="stepper-btn" onClick={() => bumpQty(99)} aria-label="Add hundred">
                +100
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="intake-note">Note (optional)</label>
            <input
              id="intake-note"
              placeholder="e.g. PO#, delivery batch, shade check"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setSelected(null)
                setNote('')
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Recording…' : `Confirm intake of ${selected.qty}`}
            </button>
          </div>
        </>
      )}

      {creating && (
        <NewProductModal
          initialItemGroup={query}
          onClose={() => setCreating(false)}
          onCreated={onCreated}
        />
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
