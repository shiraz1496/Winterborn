'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ItemGroupDetail, ItemGroupMappingProgress } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { SearchableSelect } from '../../../components/SearchableSelect'
import {
  ApiError,
  createProductAttribute,
  createProductAttributeValue,
  getItemGroupMappingDetail,
  listItemGroupsForMapping,
  updateItemGroupMapping,
} from '../../../lib/api'

/**
 * Axis-first mapping modal.
 *
 * Layout:
 *   1. Square item dropdown at the top.
 *   2. "Which axis?" selector — lists this product's declared axes plus
 *      Color / Size / Style / + Custom for adding a new one.
 *   3. When an axis is picked, its values appear below. Each SKU that carries
 *      that value is listed with its own Square variation dropdown, options
 *      formatted "id — name" so operators can read the Square catalog IDs.
 *   4. Save all button batches everything into one PATCH.
 *
 * For multi-axis products (e.g. Sport Socks with Color × Size), operator
 * picks one axis at a time to focus on — the same SKU may appear under
 * multiple axes, and each occurrence edits the same underlying binding.
 */

const CANONICAL_AXES = ['Color', 'Size', 'Style'] as const

interface ValueDraftMap {
  [productAttributeValueId: string]: string | null
}

function normaliseForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[\s/_\-.,;:]+/g, ' ')
}

/// Auto-match an axis value against cached Square variation names.
/// "Cream" ↔ "Cream" is a hit; Square exposes one variation per whatever
/// axis the merchant chose as their variant dimension, so we compare on
/// the value alone, not on a combined Color/Size label.
function autoMatchValue(value: string, candidates: ItemGroupDetail['squareVariationCandidates']): string | null {
  const target = normaliseForMatch(value)
  for (const c of candidates) {
    if (normaliseForMatch(c.name) === target) return c.squareVariationId
  }
  return null
}

function ProgressBadge({ mapped, total }: { mapped: number; total: number }) {
  if (total === 0) return <span className="chip">no SKUs</span>
  if (mapped === total) return <span className="chip chip-pine">{mapped}/{total} ✓</span>
  if (mapped === 0) return <span className="chip" style={{ background: 'var(--danger-soft, #f8d7da)' }}>0/{total}</span>
  return <span className="chip chip-rust">{mapped}/{total}</span>
}

function ProductList({ onSelect, refreshKey }: { onSelect: (itemGroupId: string) => void; refreshKey: number }) {
  const [rows, setRows] = useState<ItemGroupMappingProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [sortBy, setSortBy] = useState<'needsAttention' | 'name'>('needsAttention')

  useEffect(() => {
    setLoading(true)
    listItemGroupsForMapping()
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load products.'))
      .finally(() => setLoading(false))
  }, [refreshKey])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let out = q
      ? rows.filter((r) => r.itemGroupName.toLowerCase().includes(q) || r.categoryName.toLowerCase().includes(q))
      : rows.slice()
    if (sortBy === 'needsAttention') {
      out.sort((a, b) => {
        const aUnmapped = a.totalSkus - a.mappedSkus
        const bUnmapped = b.totalSkus - b.mappedSkus
        if (bUnmapped !== aUnmapped) return bUnmapped - aUnmapped
        return a.itemGroupName.localeCompare(b.itemGroupName)
      })
    } else {
      out.sort((a, b) => a.itemGroupName.localeCompare(b.itemGroupName))
    }
    return out
  }, [rows, filter, sortBy])

  if (loading) {
    return <div className="screen-loading"><div className="spinner" aria-hidden="true" /></div>
  }

  return (
    <div>
      {error && <p className="error-banner">{error}</p>}
      <div className="row" style={{ gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <input
          type="search"
          placeholder="Filter by product name or category…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--line)', fontSize: '0.9rem' }}
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'needsAttention' | 'name')}
          style={{ padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--line)', fontSize: '0.9rem', background: 'var(--surface)' }}
        >
          <option value="needsAttention">Needs attention first</option>
          <option value="name">Alphabetical</option>
        </select>
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state"><p className="empty-state-title">No products match</p></div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {filtered.map((r) => (
            <button
              key={r.itemGroupId}
              type="button"
              onClick={() => onSelect(r.itemGroupId)}
              style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', background: 'var(--surface)' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="list-row-title">{r.itemGroupName}</div>
                <div className="list-row-meta">
                  {r.categoryName} · {r.totalSkus} SKU{r.totalSkus === 1 ? '' : 's'} · {r.attributeCount} axis{r.attributeCount === 1 ? '' : 'es'}
                </div>
              </div>
              <ProgressBadge mapped={r.mappedSkus} total={r.totalSkus} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MappingModal({ itemGroupId, onClose, onSaved }: { itemGroupId: string; onClose: () => void; onSaved: () => void }) {
  const [detail, setDetail] = useState<ItemGroupDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [addAxisBusy, setAddAxisBusy] = useState(false)
  const [addValueBusy, setAddValueBusy] = useState(false)
  // Unified add-axis confirmation: when non-null, a card below the axis
  // dropdown asks the operator to confirm/edit the name. For canonical
  // options (Size / Style / Color) it's pre-filled; for Custom it starts
  // empty and asks for a name.
  const [pendingAxis, setPendingAxis] = useState<{ kind: 'canonical' | 'custom'; name: string } | null>(null)
  // Same shape for adding a value to an existing axis. `axisName` is
  // captured at open time so the card header can still show it if the
  // operator switches axes mid-flow (though the axisId is what saves).
  const [pendingValue, setPendingValue] = useState<{ axisId: string; axisName: string; value: string } | null>(null)
  const [squareItemDraft, setSquareItemDraft] = useState<string | null>(null)
  const [valueDrafts, setValueDrafts] = useState<ValueDraftMap>({})
  const [selectedAxisId, setSelectedAxisId] = useState<string | null>(null)

  /// The representative WarehouseVariant for an axis value — the SKU whose
  /// squareVariationId we read (on load) and write (on save) as the single
  /// binding for that value. Deterministic: alphabetical by warehouseSku so
  /// the same row is always picked across reloads. Reflects the reality that
  /// Square only has one variation per axis value, so per-SKU bindings would
  /// duplicate; we pin the binding to one representative and leave the
  /// others unmapped.
  function representativeSku(skus: ItemGroupDetail['skus'], valueId: string): ItemGroupDetail['skus'][number] | undefined {
    const matches = skus.filter((s) => s.attributeValueIds.includes(valueId))
    matches.sort((a, b) => a.warehouseSku.localeCompare(b.warehouseSku))
    return matches[0]
  }

  async function loadDetail() {
    setLoading(true)
    try {
      const d = await getItemGroupMappingDetail(itemGroupId)
      setDetail(d)
      setSquareItemDraft(d.squareItemId)
      // Populate draft state per attribute-value: read the representative
      // WarehouseVariant's squareVariationId if set, otherwise attempt a
      // name-based auto-match scoped to (1) this product's Square item, and
      // (2) variations that aren't already bound elsewhere. Auto-matching
      // against the entire cross-item cache produced stale IDs pointing at
      // some other product's variation, which the dropdown then rendered
      // as "unmapped" (because the ID wasn't in the current option list)
      // while still flashing the yellow "auto-matched" hint — confusing.
      const scoped = d.squareItemId
        ? d.squareVariationCandidates.filter((c) => c.squareItemId === d.squareItemId && !c.isBoundElsewhere)
        : []
      const initial: ValueDraftMap = {}
      for (const attr of d.attributes) {
        for (const val of attr.values) {
          const rep = representativeSku(d.skus, val.id)
          const current = rep?.squareVariationId ?? null
          initial[val.id] = current ?? autoMatchValue(val.value, scoped)
        }
      }
      setValueDrafts(initial)
      if (d.attributes.length > 0 && !selectedAxisId) setSelectedAxisId(d.attributes[0].id)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load product.')
    } finally {
      setLoading(false)
    }
  }

  // Re-auto-match unmapped values when Square item is picked mid-session.
  // Only fills in null drafts against the new scope; never overrides a
  // saved binding or a manually-picked value.
  useEffect(() => {
    if (!detail) return
    const scoped = squareItemDraft
      ? detail.squareVariationCandidates.filter((c) => c.squareItemId === squareItemDraft && !c.isBoundElsewhere)
      : []
    setValueDrafts((prev) => {
      const next: ValueDraftMap = { ...prev }
      let mutated = false
      for (const attr of detail.attributes) {
        for (const val of attr.values) {
          const rep = representativeSku(detail.skus, val.id)
          const saved = rep?.squareVariationId ?? null
          if (saved !== null) continue
          const currentDraft = next[val.id] ?? null
          const stillValid = currentDraft !== null && scoped.some((c) => c.squareVariationId === currentDraft)
          if (!stillValid) {
            const match = autoMatchValue(val.value, scoped)
            if (match !== currentDraft) {
              next[val.id] = match
              mutated = true
            }
          }
        }
      }
      return mutated ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [squareItemDraft, detail?.itemGroupId])

  useEffect(() => {
    void loadDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemGroupId])

  const declaredAxisNames = useMemo(() => new Set(detail?.attributes.map((a) => a.name) ?? []), [detail])

  // Base candidate list: Square variations under the selected Square item
  // that aren't already bound elsewhere (in another product's WV or a
  // family-level Variation binding). If no Square item is picked, empty.
  const filteredCandidates = useMemo(() => {
    if (!detail || !squareItemDraft) return []
    return detail.squareVariationCandidates.filter(
      (c) => c.squareItemId === squareItemDraft && !c.isBoundElsewhere,
    )
  }, [detail, squareItemDraft])

  // Per-row filtering: also drop IDs drafted by OTHER axis values in this
  // modal so the operator can never accidentally point two values at the
  // same Square variation. The row's own current draft is kept in.
  function candidatesForRow(currentValueId: string): typeof filteredCandidates {
    const drafted = new Set<string>()
    for (const [valueId, id] of Object.entries(valueDrafts)) {
      if (valueId === currentValueId) continue
      if (id) drafted.add(id)
    }
    return filteredCandidates.filter((c) => !drafted.has(c.squareVariationId))
  }

  const selectedAxis = useMemo(() => detail?.attributes.find((a) => a.id === selectedAxisId) ?? null, [detail, selectedAxisId])

  // SKU count per axis value — informational only, shown as "X SKUs" beside
  // each value name so the operator can see the fan-out even though we only
  // render one dropdown per value.
  const skuCountByValueId = useMemo(() => {
    const counts = new Map<string, number>()
    if (!detail || !selectedAxis) return counts
    for (const value of selectedAxis.values) counts.set(value.id, 0)
    for (const sku of detail.skus) {
      for (const valueId of sku.attributeValueIds) {
        if (counts.has(valueId)) counts.set(valueId, (counts.get(valueId) ?? 0) + 1)
      }
    }
    return counts
  }, [detail, selectedAxis])

  async function onAddValue(axisId: string, value: string) {
    if (!detail) return
    setAddValueBusy(true)
    try {
      await createProductAttributeValue(axisId, { value })
      await loadDetail()
      setPendingValue(null)
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not add value.')
    } finally {
      setAddValueBusy(false)
    }
  }

  async function onAddAxis(name: string) {
    if (!detail) return
    setAddAxisBusy(true)
    try {
      const created = await createProductAttribute(itemGroupId, { name })
      await loadDetail()
      setSelectedAxisId(created.id)
      setPendingAxis(null)
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not add axis.')
    } finally {
      setAddAxisBusy(false)
    }
  }

  async function onSave() {
    if (!detail) return
    setSaving(true)
    setSaveError(null)
    try {
      // Translate value-level drafts into per-SKU patches by targeting each
      // axis value's representative WarehouseVariant. Only diffs go to the
      // backend so unchanged values don't produce noise.
      const skuChanges: Array<{ warehouseVariantId: string; squareVariationId: string | null }> = []
      for (const [valueId, drafted] of Object.entries(valueDrafts)) {
        const rep = representativeSku(detail.skus, valueId)
        if (!rep) continue
        if (drafted !== (rep.squareVariationId ?? null)) {
          skuChanges.push({ warehouseVariantId: rep.warehouseVariantId, squareVariationId: drafted })
        }
      }
      const squareItemChanged = squareItemDraft !== detail.squareItemId
      await updateItemGroupMapping(itemGroupId, {
        squareItemId: squareItemChanged ? squareItemDraft : undefined,
        skus: skuChanges.length > 0 ? skuChanges : undefined,
      })
      onSaved()
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Product mapping"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '5vh 20px', zIndex: 1000, overflowY: 'auto' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(820px, 100%)', background: 'var(--surface)', borderRadius: 'var(--radius-lg)', boxShadow: '0 8px 32px rgba(0,0,0,0.2)', padding: 20, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        {loading ? (
          <div className="screen-loading"><div className="spinner" aria-hidden="true" /></div>
        ) : error ? (
          <div>
            <p className="error-banner">{error}</p>
            <button type="button" className="btn" onClick={onClose}>Close</button>
          </div>
        ) : detail && (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <div className="eyebrow" style={{ color: 'var(--text-dim)' }}>{detail.categoryName}</div>
                <h2 style={{ margin: '4px 0 0', fontSize: '1.2rem' }}>{detail.itemGroupName}</h2>
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost" style={{ minHeight: 32, padding: '4px 10px' }}>✕</button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 700, display: 'block', marginBottom: 4 }}>Square item</label>
              <SearchableSelect
                value={squareItemDraft}
                // Filter out Square items already linked to a different Winterborn
                // ItemGroup so operators can't collide on ItemGroup.squareItemId.
                // The currently-linked item is exempt (isBoundElsewhere is only
                // set for OTHER product links, not this one).
                options={detail.squareItemCandidates
                  .filter((c) => !c.isBoundElsewhere)
                  .map((c) => ({ id: c.squareItemId, label: c.name }))}
                placeholder="— not linked —"
                onChange={setSquareItemDraft}
                emptyMessage="No cached items available."
              />
              {detail.squareItemCandidates.length === 0 && (
                <p style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginTop: 4 }}>
                  No Square items in the cache yet. Run a sync from the Square sync page.
                </p>
              )}
            </div>

            {squareItemDraft ? (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, display: 'block', marginBottom: 4 }}>
                  Which variant axis?
                </label>
                <SearchableSelect
                  value={selectedAxisId}
                  showId={false}
                  options={[
                    ...detail.attributes.map((a) => ({
                      id: a.id,
                      label: `${a.name} (${a.values.length} value${a.values.length === 1 ? '' : 's'})`,
                    })),
                    ...CANONICAL_AXES.filter((n) => !declaredAxisNames.has(n)).map((n) => ({
                      id: `__add:${n}`,
                      label: `+ Add ${n}`,
                      variant: 'action' as const,
                    })),
                    { id: '__custom__', label: '+ Custom axis…', variant: 'action' as const },
                  ]}
                  placeholder="— pick an axis to edit —"
                  onChange={(id) => {
                    if (id === null) {
                      setSelectedAxisId(null)
                    } else if (id.startsWith('__add:')) {
                      const canonical = id.slice('__add:'.length)
                      setPendingAxis({ kind: 'canonical', name: canonical })
                    } else if (id === '__custom__') {
                      setPendingAxis({ kind: 'custom', name: '' })
                    } else {
                      setSelectedAxisId(id)
                    }
                  }}
                />
                {pendingAxis && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: 12,
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--line-strong)',
                      background: 'var(--surface-sunken)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                      <div>
                        <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', fontWeight: 700 }}>
                          Adding {pendingAxis.kind === 'custom' ? 'custom axis' : `${pendingAxis.name.toLowerCase()} axis`}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                          {pendingAxis.kind === 'custom'
                            ? 'Name the axis (e.g. Yarn count, Weight, Fit).'
                            : 'Confirm the axis name or edit it before saving.'}
                        </div>
                      </div>
                    </div>
                    <input
                      autoFocus
                      type="text"
                      placeholder={pendingAxis.kind === 'custom' ? 'Axis name' : pendingAxis.name}
                      value={pendingAxis.name}
                      onChange={(e) => setPendingAxis({ ...pendingAxis, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && pendingAxis.name.trim() && !addAxisBusy) {
                          void onAddAxis(pendingAxis.name.trim())
                        } else if (e.key === 'Escape') {
                          setPendingAxis(null)
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--line)',
                        fontSize: '0.9rem',
                        background: 'var(--surface)',
                        boxSizing: 'border-box',
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                      <button
                        type="button"
                        onClick={() => setPendingAxis(null)}
                        disabled={addAxisBusy}
                        style={{
                          all: 'unset',
                          padding: '6px 14px',
                          fontSize: '0.82rem',
                          borderRadius: 'var(--radius-sm)',
                          cursor: 'pointer',
                          color: 'var(--text-dim)',
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={addAxisBusy || !pendingAxis.name.trim()}
                        onClick={() => onAddAxis(pendingAxis.name.trim())}
                        style={{
                          all: 'unset',
                          padding: '6px 16px',
                          fontSize: '0.82rem',
                          fontWeight: 700,
                          letterSpacing: '0.03em',
                          borderRadius: 'var(--radius-sm)',
                          cursor: addAxisBusy || !pendingAxis.name.trim() ? 'not-allowed' : 'pointer',
                          background: addAxisBusy || !pendingAxis.name.trim() ? 'var(--line)' : 'var(--signal, #b58a2c)',
                          color: addAxisBusy || !pendingAxis.name.trim() ? 'var(--text-dim)' : 'var(--surface)',
                          transition: 'background 0.12s',
                        }}
                      >
                        {addAxisBusy ? 'Adding…' : 'Add axis'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.9rem', border: '1px dashed var(--line)', borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)' }}>
                Pick a Square item above to start mapping.
              </div>
            )}

            {squareItemDraft && selectedAxis && (
              <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
                <div>
                  <div style={{ padding: '10px 12px', background: 'var(--surface-sunken)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>{selectedAxis.name}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>{selectedAxis.values.length} value{selectedAxis.values.length === 1 ? '' : 's'} declared</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingValue({ axisId: selectedAxis.id, axisName: selectedAxis.name, value: '' })}
                      disabled={pendingValue?.axisId === selectedAxis.id}
                      style={{
                        all: 'unset',
                        padding: '5px 12px',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        letterSpacing: '0.02em',
                        borderRadius: 'var(--radius-sm)',
                        cursor: pendingValue?.axisId === selectedAxis.id ? 'not-allowed' : 'pointer',
                        border: '1px solid var(--signal, #b58a2c)',
                        color: 'var(--signal, #b58a2c)',
                        background: 'transparent',
                        opacity: pendingValue?.axisId === selectedAxis.id ? 0.5 : 1,
                      }}
                    >
                      + Add value
                    </button>
                  </div>

                  {pendingValue && pendingValue.axisId === selectedAxis.id && (
                    <div
                      style={{
                        padding: 12,
                        borderBottom: '1px solid var(--line)',
                        background: 'var(--surface)',
                      }}
                    >
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', fontWeight: 700 }}>
                          Adding value to {pendingValue.axisName.toLowerCase()}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                          The value will appear immediately. Any warehouse variants using it can be created separately.
                        </div>
                      </div>
                      <input
                        autoFocus
                        type="text"
                        placeholder={`New ${pendingValue.axisName.toLowerCase()} value`}
                        value={pendingValue.value}
                        onChange={(e) => setPendingValue({ ...pendingValue, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && pendingValue.value.trim() && !addValueBusy) {
                            void onAddValue(pendingValue.axisId, pendingValue.value.trim())
                          } else if (e.key === 'Escape') {
                            setPendingValue(null)
                          }
                        }}
                        style={{
                          width: '100%',
                          padding: '8px 10px',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--line)',
                          fontSize: '0.9rem',
                          background: 'var(--surface)',
                          boxSizing: 'border-box',
                        }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                        <button
                          type="button"
                          onClick={() => setPendingValue(null)}
                          disabled={addValueBusy}
                          style={{
                            all: 'unset',
                            padding: '6px 14px',
                            fontSize: '0.82rem',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            color: 'var(--text-dim)',
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={addValueBusy || !pendingValue.value.trim()}
                          onClick={() => onAddValue(pendingValue.axisId, pendingValue.value.trim())}
                          style={{
                            all: 'unset',
                            padding: '6px 16px',
                            fontSize: '0.82rem',
                            fontWeight: 700,
                            letterSpacing: '0.03em',
                            borderRadius: 'var(--radius-sm)',
                            cursor: addValueBusy || !pendingValue.value.trim() ? 'not-allowed' : 'pointer',
                            background: addValueBusy || !pendingValue.value.trim() ? 'var(--line)' : 'var(--signal, #b58a2c)',
                            color: addValueBusy || !pendingValue.value.trim() ? 'var(--text-dim)' : 'var(--surface)',
                            transition: 'background 0.12s',
                          }}
                        >
                          {addValueBusy ? 'Adding…' : 'Add value'}
                        </button>
                      </div>
                    </div>
                  )}

                  {selectedAxis.values.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                      No values on this axis yet.
                    </div>
                  ) : (
                    <div>
                      {selectedAxis.values.map((value) => {
                        const rep = detail.skus.find((s) => s.attributeValueIds.includes(value.id))
                        const rawCurrentId = valueDrafts[value.id] ?? null
                        const rowCandidates = candidatesForRow(value.id)
                        // Only treat currentId as "set" if it's actually in the row's
                        // candidate list — otherwise the trigger would render the
                        // placeholder while isAutoMatched still lit up, showing the
                        // yellow "auto-matched" hint above an "unmapped" dropdown.
                        const currentId = rawCurrentId && rowCandidates.some((c) => c.squareVariationId === rawCurrentId) ? rawCurrentId : null
                        const isAutoMatched = currentId !== null && currentId !== (rep?.squareVariationId ?? null)
                        const skuCount = skuCountByValueId.get(value.id) ?? 0
                        return (
                          <div key={value.id} style={{ borderBottom: '1px solid var(--line-soft)', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ flex: '0 0 40%', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{value.value}</div>
                              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                                {skuCount} SKU{skuCount === 1 ? '' : 's'}
                              </div>
                            </div>
                            <div style={{ flex: 1 }}>
                              <SearchableSelect
                                size="sm"
                                value={currentId}
                                options={rowCandidates.map((c) => ({ id: c.squareVariationId, label: c.name }))}
                                placeholder="— unmapped —"
                                emptyMessage={squareItemDraft ? 'No matching variations available.' : 'Pick a Square item first.'}
                                highlight={isAutoMatched}
                                hint={isAutoMatched ? 'auto-matched — confirm before saving' : undefined}
                                onChange={(id) => setValueDrafts((prev) => ({ ...prev, [value.id]: id }))}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {saveError && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 10 }}>{saveError}</p>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save all'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SquareMappingBody() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <div>
      <PageHeader
        eyebrow="Owner + Warehouse Manager"
        title="Square mapping"
        description="One row per product. Click to open the mapping modal — pick the Square item, choose an axis (Color / Size / Style / or a custom one), and bind each SKU's Square variation. Sales fired by Square decrement the specific SKU you bind here."
      />
      <ProductList onSelect={setOpenId} refreshKey={refreshKey} />
      {openId && (
        <MappingModal
          itemGroupId={openId}
          onClose={() => setOpenId(null)}
          onSaved={() => { setOpenId(null); setRefreshKey((k) => k + 1) }}
        />
      )}
    </div>
  )
}

export default function SquareMappingPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER']}>
      <SquareMappingBody />
    </RequireAuth>
  )
}
