'use client'

import { useParams } from 'next/navigation'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { CatalogItemDetail, ColourFamilyDto } from '@winterborn/shared'
import { PageHeader } from '../../../../../components/PageHeader'
import { RequireAuth } from '../../../../../components/RequireAuth'
import { Swatch } from '../../../../../components/Swatch'
import { useAuth } from '../../../../../lib/auth-context'
import {
  ApiError,
  availableAtWarehouse,
  correctStock,
  getCatalogItemDetail,
  listColourFamilies,
  updateItemGroup,
  updateWarehouseVariant,
} from '../../../../../lib/api'
import { MAX_PHOTOS_PER_SKU, prepareProductPhoto, uploadProductPhotos } from '../../../../../lib/photo-upload'
import { useToast } from '../../../../../lib/toast'
import { Breadcrumbs, formatMoney } from '../../_shared'

const EDIT_ROLES = ['OWNER', 'WAREHOUSE_MANAGER'] as const

function ItemDetail() {
  const params = useParams<{ variantId: string }>()
  const { variantId } = params
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = user ? EDIT_ROLES.includes(user.role as (typeof EDIT_ROLES)[number]) : false
  const [detail, setDetail] = useState<CatalogItemDetail | null>(null)
  /// Net warehouse-side availability for this specific SKU: total on-hand
  /// minus units committed to open PACKING boxes. Only used to derive
  /// the "in packing" / "available" reconciliation lines beneath the
  /// existing "Total on hand" row — so an owner reading `4 on hand` on
  /// the catalog card and `1 available` on the pack screen never has to
  /// wonder where the missing 3 went.
  const [warehouseAvailable, setWarehouseAvailable] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activePhoto, setActivePhoto] = useState(0)
  const [editing, setEditing] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const d = await getCatalogItemDetail(variantId)
      setDetail(d)
      setActivePhoto(0)
      setError(null)
      // Fetch net-available in parallel with rendering. If the call fails
      // (permissions, network) we quietly leave the row hidden — the rest
      // of the detail card still works.
      try {
        const { available } = await availableAtWarehouse([variantId])
        setWarehouseAvailable(available[variantId] ?? null)
      } catch {
        setWarehouseAvailable(null)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this item.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantId])

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div>
        <Breadcrumbs
          crumbs={[
            { href: '/admin/catalog', label: 'Catalog' },
            { label: '…' },
          ]}
        />
        <p className="error-banner">{error ?? 'Item not found.'}</p>
      </div>
    )
  }

  const totalValueCents = detail.totalOnHand * (detail.unitCostCents ?? 0)

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { href: '/admin/catalog', label: 'Catalog' },
          ...detail.breadcrumb.map((c) => ({
            href: `/admin/catalog/f/${encodeURIComponent(c.id)}`,
            label: c.name,
          })),
          {
            href: `/admin/catalog/g/${encodeURIComponent(detail.itemGroupId)}`,
            label: detail.itemGroupName,
          },
          { label: detail.colourVariantName },
        ]}
      />
      <PageHeader
        eyebrow={detail.itemGroupName}
        title={`${detail.colourVariantName} · ${detail.sizeOptionName}`}
        description={`SKU ${detail.warehouseSku}`}
      />

      <div
        style={{
          display: 'grid',
          // `auto-fit` + a min column width lets the two panels stack on
          // narrow screens (phones) and sit side by side on desktop
          // without a media query. Was hard-coded to two columns before,
          // which clipped the Details card on mobile.
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 20,
          marginBottom: 24,
        }}
      >
        <section>
          <PhotoGallery photoUrls={detail.photoUrls} activeIdx={activePhoto} onSelect={setActivePhoto} familyName={detail.colourFamilyName} />
        </section>
        <section className="stack" style={{ gap: 14 }}>
          <div className="card" style={{ padding: 14 }}>
            <div className="section-heading" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0, fontSize: '1rem' }}>Details</h2>
              {canEdit && !editing && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ minHeight: 28, padding: '4px 10px', fontSize: '0.82rem' }}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <DetailsEditor
                detail={detail}
                onCancel={() => setEditing(false)}
                onSaved={(msg) => {
                  toast.success(msg)
                  setEditing(false)
                  void load()
                }}
                onError={(msg) => toast.error(msg)}
              />
            ) : (
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', margin: 0, fontSize: '0.88rem' }}>
                <dt style={{ color: 'var(--text-dim)' }}>Item group</dt>
                <dd style={{ margin: 0 }}>{detail.itemGroupName}</dd>
                <dt style={{ color: 'var(--text-dim)' }}>Colour family</dt>
                <dd style={{ margin: 0 }}>{detail.colourFamilyName}</dd>
                <dt style={{ color: 'var(--text-dim)' }}>Colour variant</dt>
                <dd style={{ margin: 0 }}>
                  {/* When axes exist (Pattern / Style / custom), strip the
                      parenthetical suffix ProductCreation appended to
                      keep list-view names disambiguated — the axes are
                      surfaced as their own rows below, so showing
                      "Blue (Cross)" here would double-count Pattern. */}
                  {detail.attributes.length > 0
                    ? detail.colourVariantName.replace(/\s*\([^)]*\)\s*$/, '').trim() ||
                    detail.colourVariantName
                    : detail.colourVariantName}
                </dd>
                {detail.attributes.map((a) => (
                  <Fragment key={a.name}>
                    <dt style={{ color: 'var(--text-dim)' }}>{a.name}</dt>
                    <dd style={{ margin: 0 }}>{a.value}</dd>
                  </Fragment>
                ))}
                <dt style={{ color: 'var(--text-dim)' }}>Size</dt>
                <dd style={{ margin: 0 }}>{detail.sizeOptionName}</dd>
                <dt style={{ color: 'var(--text-dim)' }}>SKU</dt>
                <dd className="mono" style={{ margin: 0 }}>{detail.warehouseSku}</dd>
                <dt style={{ color: 'var(--text-dim)' }}>Unit cost</dt>
                <dd style={{ margin: 0 }}>
                  {detail.unitCostCents !== null ? formatMoney(detail.unitCostCents) : '—'}
                </dd>
                <dt style={{ color: 'var(--text-dim)' }}>Total on hand</dt>
                <dd className="mono" style={{ margin: 0, fontWeight: 700 }}>{detail.totalOnHand.toLocaleString()}</dd>
                {warehouseAvailable !== null && detail.totalOnHand - warehouseAvailable > 0 && (
                  <>
                    <dt style={{ color: 'var(--text-dim)' }} title="Units committed to open packing boxes but not yet dispatched">
                      In packing
                    </dt>
                    <dd
                      className="mono"
                      style={{ margin: 0, color: 'var(--signal, #d2892a)' }}
                    >
                      {(detail.totalOnHand - warehouseAvailable).toLocaleString()}
                    </dd>
                  </>
                )}
                {warehouseAvailable !== null && (
                  <>
                    <dt
                      style={{ color: 'var(--text-dim)' }}
                      title="On hand minus what's already reserved in open packing boxes — the number the pack screen enforces"
                    >
                      Available
                    </dt>
                    <dd className="mono" style={{ margin: 0 }}>
                      {warehouseAvailable.toLocaleString()}
                    </dd>
                  </>
                )}
                <dt style={{ color: 'var(--text-dim)' }}>Total value</dt>
                <dd style={{ margin: 0 }}>{formatMoney(totalValueCents)}</dd>
              </dl>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

/// Inline editor for the DETAILS card. Each save call diffs against the
/// current detail — only genuinely-changed fields go in the PATCH body so
/// AuditLog captures the real per-field trail (untouched fields don't get
/// spurious "changed from X to X" rows).
///
/// Warnings live under the fields whose semantics ripple beyond a rename:
/// unit cost (re-values history), SKU (external labels), colour family &
/// folder (rebinds Variation, historical ledger stays on the old row).
function DetailsEditor({
  detail,
  onSaved,
  onCancel,
  onError,
}: {
  detail: CatalogItemDetail
  onSaved: (msg: string) => void
  onCancel: () => void
  onError: (msg: string) => void
}) {
  const [itemGroupName, setItemGroupName] = useState(detail.itemGroupName)
  const [colourVariantName, setColourVariantName] = useState(detail.colourVariantName)
  const [sizeOptionName, setSizeOptionName] = useState(detail.sizeOptionName)
  /// Custom-axis (Style / Pattern / Fit / …) drafts, keyed by axis
  /// name. Seeded from the read-side attributes so an unchanged save
  /// is a no-op; on submit the diff against `detail.attributes` decides
  /// which entries land in the update patch.
  const [axisDrafts, setAxisDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(detail.attributes.map((a) => [a.name, a.value])),
  )
  const [unitCostDollars, setUnitCostDollars] = useState(
    detail.unitCostCents !== null ? (detail.unitCostCents / 100).toFixed(2) : '',
  )
  const [colourFamilyId, setColourFamilyId] = useState<string>('')
  const [colourFamilies, setColourFamilies] = useState<ColourFamilyDto[]>([])
  const [existingPhotos, setExistingPhotos] = useState<string[]>(detail.photoUrls)
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [photoError, setPhotoError] = useState<string | null>(null)
  /// Per-location target on-hand as raw string (preserves empty / mid-typing
  /// state). Original values are read from `detail.stockByLocation`; a diff
  /// against those decides which locations get a CORRECTION on save.
  const [countByLocation, setCountByLocation] = useState<Record<string, string>>(() =>
    Object.fromEntries(detail.stockByLocation.map((r) => [r.locationId, String(r.onHand)])),
  )
  const [countNote, setCountNote] = useState('')
  const [busy, setBusy] = useState(false)

  const totalPhotoCount = existingPhotos.length + newFiles.length
  const photoRoom = Math.max(0, MAX_PHOTOS_PER_SKU - totalPhotoCount)
  const photosChanged =
    newFiles.length > 0 ||
    existingPhotos.length !== detail.photoUrls.length ||
    existingPhotos.some((u, i) => u !== detail.photoUrls[i])

  async function addPhotos(list: FileList | null) {
    if (!list || list.length === 0) return
    // Snapshot into a plain array before the first await -- FileList is
    // tied to the <input> and can be reset out from under us mid-loop.
    const files = Array.from(list)
    setPhotoError(null)
    if (files.length > photoRoom) {
      setPhotoError(`Only ${MAX_PHOTOS_PER_SKU} photos per SKU — some were not added.`)
    }
    for (const file of files.slice(0, photoRoom)) {
      try {
        const prepared = await prepareProductPhoto(file)
        setNewFiles((prev) => [...prev, prepared])
      } catch (err) {
        setPhotoError(err instanceof Error ? err.message : 'Could not use that photo.')
      }
    }
  }

  /// Colour-family dropdown must be scoped to the CURRENT category. If the
  /// operator moves the folder mid-edit, the family list becomes stale; we
  /// keep the picker showing the original category's families since the
  /// PATCH for family is scoped to the variant's current category anyway.
  useEffect(() => {
    let cancelled = false
    listColourFamilies(detail.categoryId)
      .then((families) => {
        if (cancelled) return
        setColourFamilies(families)
        const match = families.find((f) => f.name === detail.colourFamilyName)
        if (match) setColourFamilyId(match.id)
      })
      .catch(() => {
        if (!cancelled) setColourFamilies([])
      })
    return () => {
      cancelled = true
    }
  }, [detail.categoryId, detail.colourFamilyName])

  const originalColourFamilyId = useMemo(
    () => colourFamilies.find((f) => f.name === detail.colourFamilyName)?.id ?? '',
    [colourFamilies, detail.colourFamilyName],
  )

  async function save() {
    setBusy(true)
    try {
      // Build the two PATCH bodies as diffs against `detail`.
      const igPatch: { name?: string } = {}
      if (itemGroupName.trim() && itemGroupName.trim() !== detail.itemGroupName) {
        igPatch.name = itemGroupName.trim()
      }

      const wvPatch: {
        unitCostCents?: number | null
        colourVariantName?: string
        sizeOptionName?: string
        colourFamilyId?: string
        photoUrls?: string[]
        axisValues?: Array<{ name: string; value: string }>
      } = {}
      if (colourVariantName.trim() && colourVariantName.trim() !== detail.colourVariantName) {
        wvPatch.colourVariantName = colourVariantName.trim()
      }
      if (sizeOptionName.trim() && sizeOptionName.trim() !== detail.sizeOptionName) {
        wvPatch.sizeOptionName = sizeOptionName.trim()
      }
      if (colourFamilyId && originalColourFamilyId && colourFamilyId !== originalColourFamilyId) {
        wvPatch.colourFamilyId = colourFamilyId
      }
      // Diff custom-axis drafts against the original attributes. Only
      // send entries where the operator actually typed a new value —
      // blank inputs and unchanged values are skipped so the backend
      // no-ops on identity submits.
      const originalByAxis = new Map(detail.attributes.map((a) => [a.name, a.value]))
      const changedAxes: Array<{ name: string; value: string }> = []
      for (const [name, draft] of Object.entries(axisDrafts)) {
        const trimmed = draft.trim()
        if (!trimmed) continue
        const original = originalByAxis.get(name) ?? ''
        if (trimmed !== original) changedAxes.push({ name, value: trimmed })
      }
      if (changedAxes.length > 0) wvPatch.axisValues = changedAxes
      const trimmedCost = unitCostDollars.trim()
      if (trimmedCost === '') {
        if (detail.unitCostCents !== null) wvPatch.unitCostCents = null
      } else {
        const parsed = Number.parseFloat(trimmedCost)
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error('Unit cost must be a number ≥ 0 (or blank to clear).')
        }
        const newCents = Math.round(parsed * 100)
        if (newCents !== detail.unitCostCents) wvPatch.unitCostCents = newCents
      }

      // Photos: upload any newly-picked files, then patch with the combined
      // list. Ordering is existing photos first (preserving operator's remove
      // decisions), then newly-uploaded in the order they were picked.
      if (photosChanged) {
        let uploadedNewUrls: string[] = []
        if (newFiles.length > 0) {
          const uploaded = await uploadProductPhotos({ variant: newFiles })
          uploadedNewUrls = uploaded.variant ?? []
        }
        wvPatch.photoUrls = [...existingPhotos, ...uploadedNewUrls]
      }

      // Diff per-location counts. A missing key means "not touched"; a
      // parsed value that differs from the original triggers one CORRECTION
      // ledger row via /stock/correction. Locations where the count is
      // unchanged are skipped so the ledger doesn't get spurious rows.
      const countChanges: Array<{ locationId: string; locationName: string; newOnHand: number }> = []
      for (const row of detail.stockByLocation) {
        const raw = countByLocation[row.locationId]
        if (raw === undefined) continue
        const trimmed = raw.trim()
        if (trimmed === '') continue
        const parsed = Number.parseInt(trimmed, 10)
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Count for ${row.locationName} must be a whole number ≥ 0.`)
        }
        if (parsed !== row.onHand) {
          countChanges.push({ locationId: row.locationId, locationName: row.locationName, newOnHand: parsed })
        }
      }

      const igChanges = Object.keys(igPatch).length
      const wvChanges = Object.keys(wvPatch).length
      if (igChanges === 0 && wvChanges === 0 && countChanges.length === 0) {
        onSaved('No changes to save.')
        return
      }

      if (igChanges > 0) await updateItemGroup(detail.itemGroupId, igPatch)
      if (wvChanges > 0) await updateWarehouseVariant(detail.warehouseVariantId, wvPatch)
      for (const change of countChanges) {
        await correctStock({
          warehouseVariantId: detail.warehouseVariantId,
          locationId: change.locationId,
          newOnHand: change.newOnHand,
          note: countNote.trim() || undefined,
        })
      }

      const total = igChanges + wvChanges + countChanges.length
      onSaved(`Saved ${total} change${total === 1 ? '' : 's'}.`)
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not save changes.'
      onError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack" style={{ gap: 12, fontSize: '0.88rem' }}>
      {detail.stockByLocation.length > 0 && (
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Warehouse counts</label>
          <div className="stack" style={{ gap: 8 }}>
            {detail.stockByLocation.map((row) => (
              <div key={row.locationId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{row.locationName}</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={countByLocation[row.locationId] ?? ''}
                  onChange={(e) =>
                    setCountByLocation((prev) => ({ ...prev, [row.locationId]: e.target.value }))
                  }
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label={`On-hand at ${row.locationName}`}
                  style={{ width: 120, textAlign: 'right' }}
                />
              </div>
            ))}
          </div>
          <input
            type="text"
            placeholder="Reconciliation note (optional) — e.g. Q4 physical count"
            value={countNote}
            onChange={(e) => setCountNote(e.target.value)}
            maxLength={500}
            style={{ marginTop: 8, width: '100%' }}
          />
          <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            Each changed count writes one CORRECTION ledger row. Unchanged locations are left alone.
          </p>
        </div>
      )}

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="edit-item-group">Item group</label>
        <input
          id="edit-item-group"
          value={itemGroupName}
          onChange={(e) => setItemGroupName(e.target.value)}
          maxLength={120}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="edit-colour-family">Colour family</label>
        <select
          id="edit-colour-family"
          value={colourFamilyId}
          onChange={(e) => setColourFamilyId(e.target.value)}
          disabled={colourFamilies.length === 0}
        >
          {colourFamilies.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {colourFamilyId && originalColourFamilyId && colourFamilyId !== originalColourFamilyId && (
          <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            This SKU moves to the new family; historical events remain attributed to the previous family.
          </p>
        )}
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="edit-colour-variant">Colour variant</label>
        <input
          id="edit-colour-variant"
          value={colourVariantName}
          onChange={(e) => setColourVariantName(e.target.value)}
          maxLength={120}
        />
      </div>

      {/* Custom axes (Style / Pattern / Fit / …). Rendered as first-
          class fields — one `.field` block per axis, same shape as Size
          and Colour variant above. On save, each changed value rebinds
          THIS SKU's attribute link to either the existing value row,
          an in-place rename (if this SKU is the sole user), or a
          freshly-forked value; siblings sharing the old value stay put. */}
      {detail.attributes.map((a) => (
        <div key={a.name} className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`edit-axis-${a.name}`}>{a.name}</label>
          <input
            id={`edit-axis-${a.name}`}
            value={axisDrafts[a.name] ?? ''}
            onChange={(e) => setAxisDrafts((prev) => ({ ...prev, [a.name]: e.target.value }))}
            maxLength={100}
          />
        </div>
      ))}

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="edit-size">Size</label>
        <input
          id="edit-size"
          value={sizeOptionName}
          onChange={(e) => setSizeOptionName(e.target.value)}
          maxLength={60}
        />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="edit-cost">Unit cost (USD)</label>
        <input
          id="edit-cost"
          type="text"
          inputMode="decimal"
          placeholder="Leave blank to clear"
          value={unitCostDollars}
          onChange={(e) => setUnitCostDollars(e.target.value)}
        />
        {unitCostDollars.trim() !== (detail.unitCostCents !== null ? (detail.unitCostCents / 100).toFixed(2) : '') && (
          <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            Total value on historical stock recalculates using the new cost — this figure isn&apos;t snapshotted.
          </p>
        )}
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label>Photos</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {existingPhotos.map((url, i) => (
            <div key={url} style={{ position: 'relative', width: 64, height: 64 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt=""
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)' }}
              />
              <button
                type="button"
                onClick={() => setExistingPhotos((prev) => prev.filter((_, idx) => idx !== i))}
                aria-label="Remove photo"
                style={photoRemoveBtnStyle}
              >
                ×
              </button>
            </div>
          ))}
          {newFiles.map((file, i) => (
            <NewPhotoThumb
              key={`new-${i}`}
              file={file}
              onRemove={() => setNewFiles((prev) => prev.filter((_, idx) => idx !== i))}
            />
          ))}
          {totalPhotoCount === 0 && (
            <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>No photos yet.</span>
          )}
        </div>
        <label
          className="btn btn-ghost"
          style={{ minHeight: 30, padding: '0 10px', fontSize: '0.78rem', cursor: photoRoom === 0 ? 'not-allowed' : 'pointer' }}
        >
          + Add photo
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={photoRoom === 0}
            onChange={(e) => {
              void addPhotos(e.target.files)
              e.target.value = ''
            }}
            style={{ display: 'none' }}
          />
        </label>
        {photoError && (
          <p style={{ margin: '6px 0 0', color: 'var(--danger, #c0392b)', fontSize: '0.75rem' }}>{photoError}</p>
        )}
        <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          Up to {MAX_PHOTOS_PER_SKU} per SKU. New photos upload when you save.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

const photoRemoveBtnStyle = {
  position: 'absolute' as const,
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
}

function NewPhotoThumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div style={{ position: 'relative', width: 64, height: 64 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)' }}
      />
      <button type="button" onClick={onRemove} aria-label="Remove photo" style={photoRemoveBtnStyle}>
        ×
      </button>
    </div>
  )
}

function PhotoGallery({
  photoUrls,
  activeIdx,
  onSelect,
  familyName,
}: {
  photoUrls: string[]
  activeIdx: number
  onSelect: (idx: number) => void
  familyName: string
}) {
  const active = photoUrls[activeIdx] ?? photoUrls[0] ?? null
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div
        style={{
          width: '100%',
          aspectRatio: '1 / 1',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-sunken)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {active ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={active}
            alt="Item photo"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <Swatch familyName={familyName} size="lg" />
            <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>no photo</span>
          </div>
        )}
      </div>
      {photoUrls.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {photoUrls.map((url, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                width: 64,
                height: 64,
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                border: `2px solid ${i === activeIdx ? 'var(--signal)' : 'transparent'}`,
                background: 'var(--surface-sunken)',
              }}
              aria-label={`Photo ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ItemDetailPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER']}>
      <ItemDetail />
    </RequireAuth>
  )
}
