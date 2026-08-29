'use client'

import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { CatalogItemDetail } from '@winterborn/shared'
import { PageHeader } from '../../../../../components/PageHeader'
import { RequireAuth } from '../../../../../components/RequireAuth'
import { Swatch } from '../../../../../components/Swatch'
import { ApiError, correctStock, getCatalogItemDetail } from '../../../../../lib/api'
import { useToast } from '../../../../../lib/toast'
import { Breadcrumbs, formatMoney } from '../../_shared'

function ItemDetail() {
  const params = useParams<{ variantId: string }>()
  const { variantId } = params
  const toast = useToast()
  const [detail, setDetail] = useState<CatalogItemDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activePhoto, setActivePhoto] = useState(0)

  async function load() {
    setLoading(true)
    try {
      const d = await getCatalogItemDetail(variantId)
      setDetail(d)
      setActivePhoto(0)
      setError(null)
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
          gridTemplateColumns: 'minmax(260px, 1fr) minmax(300px, 1fr)',
          gap: 24,
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
            </div>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', margin: 0, fontSize: '0.88rem' }}>
              <dt style={{ color: 'var(--text-dim)' }}>Category</dt>
              <dd style={{ margin: 0 }}>{detail.categoryName}</dd>
              <dt style={{ color: 'var(--text-dim)' }}>Item group</dt>
              <dd style={{ margin: 0 }}>{detail.itemGroupName}</dd>
              <dt style={{ color: 'var(--text-dim)' }}>Colour family</dt>
              <dd style={{ margin: 0 }}>{detail.colourFamilyName}</dd>
              <dt style={{ color: 'var(--text-dim)' }}>Colour variant</dt>
              <dd style={{ margin: 0 }}>{detail.colourVariantName}</dd>
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
              <dt style={{ color: 'var(--text-dim)' }}>Total value</dt>
              <dd style={{ margin: 0 }}>{formatMoney(totalValueCents)}</dd>
            </dl>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="section-heading" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0, fontSize: '1rem' }}>Warehouse counts</h2>
              <span className="eyebrow" style={{ color: 'var(--text-faint)' }}>
                {detail.stockByLocation.length} location{detail.stockByLocation.length === 1 ? '' : 's'}
              </span>
            </div>
            {detail.stockByLocation.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.85rem' }}>
                No active warehouse locations configured.
              </p>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {detail.stockByLocation.map((row) => (
                  <StockRowEditor
                    key={row.locationId}
                    variantId={detail.warehouseVariantId}
                    locationId={row.locationId}
                    locationName={row.locationName}
                    onHand={row.onHand}
                    onSaved={(msg) => {
                      toast.success(msg)
                      void load()
                    }}
                    onError={(msg) => toast.error(msg)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function StockRowEditor({
  variantId,
  locationId,
  locationName,
  onHand,
  onSaved,
  onError,
}: {
  variantId: string
  locationId: string
  locationName: string
  onHand: number
  onSaved: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [target, setTarget] = useState<string>(String(onHand))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  function beginEdit() {
    setTarget(String(onHand))
    setNote('')
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setTarget(String(onHand))
    setNote('')
  }

  async function save() {
    const n = Number.parseInt(target, 10)
    if (!Number.isFinite(n) || n < 0) {
      onError('Enter a whole number ≥ 0.')
      return
    }
    setBusy(true)
    try {
      const res = await correctStock({
        warehouseVariantId: variantId,
        locationId,
        newOnHand: n,
        note: note.trim() || undefined,
      })
      if (res.delta === 0) {
        onSaved(`${locationName}: no change`)
      } else {
        const sign = res.delta > 0 ? '+' : ''
        onSaved(`${locationName}: ${sign}${res.delta} → ${res.onHand}`)
      }
      setEditing(false)
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not update the count.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', padding: 10 }}>
      <div className="row-between" style={{ alignItems: 'baseline' }}>
        <div>
          <div className="list-row-title">{locationName}</div>
          <div className="mono" style={{ fontSize: '1.15rem', fontWeight: 700 }}>{onHand.toLocaleString()}</div>
        </div>
        {!editing && (
          <button type="button" className="btn" onClick={beginEdit}>
            Update count
          </button>
        )}
      </div>
      {editing && (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`target-${locationId}`}>New on-hand</label>
            <input
              id={`target-${locationId}`}
              type="number"
              min={0}
              step={1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              autoFocus
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`note-${locationId}`}>Note (optional)</label>
            <input
              id={`note-${locationId}`}
              placeholder="Q4 physical count, damaged during move…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save correction'}
            </button>
          </div>
        </div>
      )}
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
