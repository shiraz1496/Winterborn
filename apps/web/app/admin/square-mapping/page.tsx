'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import type { SquareMappingRow } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import {
  ApiError,
  listSquareMapping,
  setItemGroupSquareId,
  setVariationSquareId,
  setWarehouseVariantSquareId,
} from '../../../lib/api'

type FieldKey = `item:${string}` | `variation:${string}` | `warehouse:${string}`

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function SquareMappingBody() {
  const [rows, setRows] = useState<SquareMappingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<FieldKey, string>>({})
  const [saveStates, setSaveStates] = useState<Record<FieldKey, SaveState>>({})
  const [saveErrors, setSaveErrors] = useState<Record<FieldKey, string>>({})
  const [filter, setFilter] = useState('')

  useEffect(() => {
    listSquareMapping()
      .then(setRows)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load the mapping.'))
      .finally(() => setLoading(false))
  }, [])

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const filtered = q
      ? rows.filter(
          (r) =>
            r.itemGroupName.toLowerCase().includes(q) ||
            r.categoryName.toLowerCase().includes(q) ||
            r.colourFamilyName.toLowerCase().includes(q) ||
            r.sizeOptionName.toLowerCase().includes(q),
        )
      : rows
    // One heading per ItemGroup so pasting the item ID once per item is
    // obvious. Variations rendered under it as sub-rows.
    const byGroup = new Map<string, { itemGroupId: string; itemGroupName: string; categoryName: string; squareItemId: string | null; variations: SquareMappingRow[] }>()
    for (const r of filtered) {
      const existing = byGroup.get(r.itemGroupId)
      if (existing) {
        existing.variations.push(r)
      } else {
        byGroup.set(r.itemGroupId, {
          itemGroupId: r.itemGroupId,
          itemGroupName: r.itemGroupName,
          categoryName: r.categoryName,
          squareItemId: r.squareItemId,
          variations: [r],
        })
      }
    }
    return [...byGroup.values()]
  }, [rows, filter])

  function updateRowsFromItemGroup(itemGroupId: string, squareItemId: string | null) {
    setRows((prev) => prev.map((r) => (r.itemGroupId === itemGroupId ? { ...r, squareItemId } : r)))
  }

  function updateRowFromVariation(variationId: string, squareVariationId: string | null) {
    setRows((prev) => prev.map((r) => (r.variationId === variationId ? { ...r, squareVariationId } : r)))
  }

  function updateRowFromWarehouseVariant(warehouseVariantId: string, squareVariationId: string | null) {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        warehouseVariants: r.warehouseVariants.map((wv) =>
          wv.warehouseVariantId === warehouseVariantId ? { ...wv, squareVariationId } : wv,
        ),
      })),
    )
  }

  async function saveItem(itemGroupId: string, key: FieldKey, currentServerValue: string | null) {
    const draft = (drafts[key] ?? '').trim()
    const nextValue = draft === '' ? null : draft
    if (nextValue === currentServerValue) return
    setSaveStates((s) => ({ ...s, [key]: 'saving' }))
    setSaveErrors((e) => {
      const rest = { ...e }
      delete rest[key]
      return rest
    })
    try {
      await setItemGroupSquareId(itemGroupId, nextValue)
      updateRowsFromItemGroup(itemGroupId, nextValue)
      setSaveStates((s) => ({ ...s, [key]: 'saved' }))
      setTimeout(() => setSaveStates((s) => (s[key] === 'saved' ? { ...s, [key]: 'idle' } : s)), 1600)
    } catch (err) {
      setSaveStates((s) => ({ ...s, [key]: 'error' }))
      setSaveErrors((e) => ({ ...e, [key]: err instanceof ApiError ? err.message : 'Save failed.' }))
    }
  }

  async function saveVariation(variationId: string, key: FieldKey, currentServerValue: string | null) {
    const draft = (drafts[key] ?? '').trim()
    const nextValue = draft === '' ? null : draft
    if (nextValue === currentServerValue) return
    setSaveStates((s) => ({ ...s, [key]: 'saving' }))
    setSaveErrors((e) => {
      const rest = { ...e }
      delete rest[key]
      return rest
    })
    try {
      await setVariationSquareId(variationId, nextValue)
      updateRowFromVariation(variationId, nextValue)
      setSaveStates((s) => ({ ...s, [key]: 'saved' }))
      setTimeout(() => setSaveStates((s) => (s[key] === 'saved' ? { ...s, [key]: 'idle' } : s)), 1600)
    } catch (err) {
      setSaveStates((s) => ({ ...s, [key]: 'error' }))
      setSaveErrors((e) => ({ ...e, [key]: err instanceof ApiError ? err.message : 'Save failed.' }))
    }
  }

  async function saveWarehouseVariant(
    warehouseVariantId: string,
    key: FieldKey,
    currentServerValue: string | null,
  ) {
    const draft = (drafts[key] ?? '').trim()
    const nextValue = draft === '' ? null : draft
    if (nextValue === currentServerValue) return
    setSaveStates((s) => ({ ...s, [key]: 'saving' }))
    setSaveErrors((e) => {
      const rest = { ...e }
      delete rest[key]
      return rest
    })
    try {
      await setWarehouseVariantSquareId(warehouseVariantId, nextValue)
      updateRowFromWarehouseVariant(warehouseVariantId, nextValue)
      setSaveStates((s) => ({ ...s, [key]: 'saved' }))
      setTimeout(() => setSaveStates((s) => (s[key] === 'saved' ? { ...s, [key]: 'idle' } : s)), 1600)
    } catch (err) {
      setSaveStates((s) => ({ ...s, [key]: 'error' }))
      setSaveErrors((e) => ({ ...e, [key]: err instanceof ApiError ? err.message : 'Save failed.' }))
    }
  }

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        eyebrow="Owner + Warehouse Manager"
        title="Square mapping"
        description="Link each local product to its Square catalog IDs. Three levels: paste the item ID at the top, the family variation ID next to each colour family/size row, and the per-SKU variation ID on each warehouse variant beneath. The mapper checks the warehouse-variant ID first (so Earmuffs / Black decrements the Black SKU) and falls back to the family ID for single-variant products. A blank field clears the link."
      />

      {loadError && <p className="error-banner">{loadError}</p>}

      <div className="row" style={{ marginBottom: 18, gap: 12, alignItems: 'center' }}>
        <input
          type="search"
          placeholder="Filter by item name, category, till SKU..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--line)',
            fontSize: '0.9rem',
          }}
        />
        <span className="eyebrow">
          {grouped.length} item{grouped.length === 1 ? '' : 's'} / {rows.filter((r) => filter === '' || true).length} variations
        </span>
      </div>

      {grouped.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No matches</p>
          <p className="empty-state-body">Try a different search, or clear the filter.</p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {grouped.map((group) => {
            const itemKey: FieldKey = `item:${group.itemGroupId}`
            const itemDraft = drafts[itemKey] ?? group.squareItemId ?? ''
            const itemState = saveStates[itemKey] ?? 'idle'
            const itemError = saveErrors[itemKey]
            return (
              <div key={group.itemGroupId} className="card">
                <div style={{ marginBottom: 12 }}>
                  <div className="list-row-title">{group.itemGroupName}</div>
                  <div className="list-row-meta">{group.categoryName}</div>
                </div>

                <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 14 }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 700, minWidth: 110 }}>Square item ID</label>
                  <input
                    type="text"
                    placeholder="paste from Square dashboard"
                    value={itemDraft}
                    onChange={(e) => setDrafts((d) => ({ ...d, [itemKey]: e.target.value }))}
                    onBlur={() => saveItem(group.itemGroupId, itemKey, group.squareItemId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--line)',
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                    }}
                  />
                  <SaveBadge state={itemState} error={itemError} />
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                      <th style={{ padding: '6px 8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Colour</th>
                      <th style={{ padding: '6px 8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Size</th>
                      <th style={{ padding: '6px 8px', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Square variation ID</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {group.variations.map((v) => {
                      const varKey: FieldKey = `variation:${v.variationId}`
                      const varDraft = drafts[varKey] ?? v.squareVariationId ?? ''
                      const varState = saveStates[varKey] ?? 'idle'
                      const varError = saveErrors[varKey]
                      return (
                        <Fragment key={v.variationId}>
                          <tr style={{ borderBottom: '1px solid var(--line-soft)', background: 'var(--surface-sunken)' }}>
                            <td style={{ padding: '8px', fontWeight: 600 }}>{v.colourFamilyName}</td>
                            <td style={{ padding: '8px', fontWeight: 600 }}>{v.sizeOptionName}</td>
                            <td style={{ padding: '8px' }}>
                              <input
                                type="text"
                                placeholder="family-level fallback (optional if all warehouse variants are mapped)"
                                value={varDraft}
                                onChange={(e) => setDrafts((d) => ({ ...d, [varKey]: e.target.value }))}
                                onBlur={() => saveVariation(v.variationId, varKey, v.squareVariationId)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                }}
                                style={{
                                  width: '100%',
                                  padding: '5px 8px',
                                  borderRadius: 'var(--radius-sm)',
                                  border: '1px solid var(--line)',
                                  fontFamily: 'monospace',
                                  fontSize: '0.78rem',
                                }}
                              />
                              {varError && (
                                <div style={{ color: 'var(--danger, #c0392b)', fontSize: '0.7rem', marginTop: 4 }}>{varError}</div>
                              )}
                            </td>
                            <td style={{ padding: '8px', width: 60 }}>
                              <SaveBadge state={varState} error={varError} />
                            </td>
                          </tr>
                          {v.warehouseVariants.map((wv) => {
                            const wvKey: FieldKey = `warehouse:${wv.warehouseVariantId}`
                            const wvDraft = drafts[wvKey] ?? wv.squareVariationId ?? ''
                            const wvState = saveStates[wvKey] ?? 'idle'
                            const wvError = saveErrors[wvKey]
                            return (
                              <tr key={wv.warehouseVariantId} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                                <td style={{ padding: '6px 8px 6px 24px', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
                                  ↳ {wv.colourVariantName}
                                </td>
                                <td style={{ padding: '6px 8px', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
                                  {wv.sizeOptionName}
                                  <div className="mono" style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>{wv.warehouseSku}</div>
                                </td>
                                <td style={{ padding: '6px 8px' }}>
                                  <input
                                    type="text"
                                    placeholder="per-SKU Square variation ID (recommended)"
                                    value={wvDraft}
                                    onChange={(e) => setDrafts((d) => ({ ...d, [wvKey]: e.target.value }))}
                                    onBlur={() => saveWarehouseVariant(wv.warehouseVariantId, wvKey, wv.squareVariationId)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                    }}
                                    style={{
                                      width: '100%',
                                      padding: '5px 8px',
                                      borderRadius: 'var(--radius-sm)',
                                      border: '1px solid var(--line)',
                                      fontFamily: 'monospace',
                                      fontSize: '0.78rem',
                                    }}
                                  />
                                  {wvError && (
                                    <div style={{ color: 'var(--danger, #c0392b)', fontSize: '0.7rem', marginTop: 4 }}>{wvError}</div>
                                  )}
                                </td>
                                <td style={{ padding: '6px 8px', width: 60 }}>
                                  <SaveBadge state={wvState} error={wvError} />
                                </td>
                              </tr>
                            )
                          })}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
                {itemError && <p style={{ color: 'var(--danger, #c0392b)', fontSize: '0.75rem', marginTop: 8 }}>{itemError}</p>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SaveBadge({ state, error }: { state: SaveState; error?: string }) {
  if (state === 'saving')
    return (
      <span className="eyebrow" style={{ fontSize: '0.7rem' }}>
        saving…
      </span>
    )
  if (state === 'saved')
    return (
      <span style={{ color: 'var(--pine)', fontSize: '0.7rem', fontWeight: 700 }}>saved</span>
    )
  if (state === 'error')
    return (
      <span
        title={error ?? 'save failed'}
        style={{ color: 'var(--danger, #c0392b)', fontSize: '0.7rem', fontWeight: 700 }}
      >
        error
      </span>
    )
  return <span style={{ width: 40, display: 'inline-block' }} />
}

export default function SquareMappingPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER']}>
      <SquareMappingBody />
    </RequireAuth>
  )
}
