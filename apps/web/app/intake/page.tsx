'use client'

import { useEffect, useMemo, useState } from 'react'
import type { IntakeResult, WarehouseVariantSummary } from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { ApiError, listWarehouseVariants, receiveIntake } from '../../lib/api'
import { useToast } from '../../lib/toast'

/// Doc 3 §3.1. Receive inventory: pick a warehouse SKU, enter quantity,
/// confirm. `idempotencyToken` is generated once when this component mounts
/// and rotated on every successful submit -- a double-tap on Confirm is a
/// retry (no second row); a fresh intake is a fresh token (yes, second row).

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

function IntakeBody() {
  const toast = useToast()
  const [variants, setVariants] = useState<WarehouseVariantSummary[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [token, setToken] = useState<string>(() => newIdempotencyToken())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<
    (IntakeResult & { label: string }) | null
  >(null)

  useEffect(() => {
    listWarehouseVariants()
      .then(setVariants)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the warehouse catalog.'))
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
                No warehouse SKU matched. Product creation is warehouse-manager only — ask them to add it.
              </p>
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
