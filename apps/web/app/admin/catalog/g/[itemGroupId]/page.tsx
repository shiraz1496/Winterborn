'use client'

import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import type { CatalogItemGroupPage as ItemGroupPageDto, CatalogItemRow, LocationDto } from '@winterborn/shared'
import { CopyButton } from '../../../../../components/CopyButton'
import { LocationPicker } from '../../../../../components/LocationPicker'
import { PageHeader } from '../../../../../components/PageHeader'
import { RequireAuth } from '../../../../../components/RequireAuth'
import { Swatch } from '../../../../../components/Swatch'
import { useAuth } from '../../../../../lib/auth-context'
import { ApiError, browseCatalogItems, listLocations } from '../../../../../lib/api'
import { Breadcrumbs, CatalogStats, catalogSearchClass, formatMoney, withLoc } from '../../_shared'

function ItemGroupView() {
  const params = useParams<{ itemGroupId: string }>()
  const itemGroupId = params.itemGroupId
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedLoc = searchParams.get('loc')

  const canSwitchLocation = user?.role !== 'MARKET_MANAGER'

  const [data, setData] = useState<ItemGroupPageDto | null>(null)
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setLoading(true)
    Promise.all([
      browseCatalogItems(itemGroupId, requestedLoc ?? undefined),
      listLocations(),
    ])
      .then(([res, locs]) => {
        setData(res)
        setLocations(locs)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this item group.'))
      .finally(() => setLoading(false))
  }, [itemGroupId, requestedLoc])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    if (q.length === 0) return data.items
    return data.items.filter(
      (i) =>
        i.colourVariantName.toLowerCase().includes(q) ||
        i.colourFamilyName.toLowerCase().includes(q) ||
        i.sizeOptionName.toLowerCase().includes(q) ||
        i.warehouseSku.toLowerCase().includes(q),
    )
  }, [data, query])

  const totals = useMemo(() => {
    if (!data) return { totalQty: 0, totalValueCents: 0 }
    let totalQty = 0
    let totalValueCents = 0
    for (const i of data.items) {
      totalQty += i.onHand
      totalValueCents += i.onHand * (i.unitCostCents ?? 0)
    }
    return { totalQty, totalValueCents }
  }, [data])

  function pickLocation(nextId: string) {
    router.replace(
      `/admin/catalog/g/${encodeURIComponent(itemGroupId)}?loc=${encodeURIComponent(nextId)}`,
    )
  }

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  const currentLocationId = data?.location?.id ?? null

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { href: withLoc('/admin/catalog', currentLocationId), label: 'Catalog' },
          ...(data?.breadcrumb.map((c) => ({
            href: withLoc(`/admin/catalog/f/${encodeURIComponent(c.id)}`, currentLocationId),
            label: c.name,
          })) ?? []),
          { label: data?.itemGroup.name ?? '…' },
        ]}
      />
      <PageHeader
        eyebrow="Item group"
        title={data?.itemGroup.name ?? 'Item group'}
        description="Every SKU in this group with its on-hand at the selected location. Click a card to see photos, per-warehouse counts, and edit."
        titleAdornment={
          data?.itemGroup.name ? (
            <CopyButton text={data.itemGroup.name} label="Copy product name" size="sm" />
          ) : undefined
        }
      />

      {error && <p className="error-banner">{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <LocationPicker
          value={currentLocationId}
          onChange={pickLocation}
          locations={locations}
          canSwitch={canSwitchLocation}
        />
      </div>

      <CatalogStats
        left={[
          { label: 'Items', value: (data?.items.length ?? 0).toString() },
          { label: 'Total Quantity', value: `${totals.totalQty.toLocaleString()} units` },
          { label: 'Total Value', value: formatMoney(totals.totalValueCents) },
        ]}
      />

      <div style={{ marginTop: 18, marginBottom: 14 }}>
        <input
          type="search"
          placeholder="Search colour, size, or SKU…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={catalogSearchClass}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing matches</p>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
            Try a different search.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 14,
          }}
        >
          {filtered.map((it) => (
            <Link
              key={it.warehouseVariantId}
              href={withLoc(`/admin/catalog/i/${encodeURIComponent(it.warehouseVariantId)}`, currentLocationId)}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <ItemTile item={it} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function ItemTile({ item }: { item: CatalogItemRow }) {
  return (
    <div className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '1 / 1',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-sunken)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {item.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.photoUrl}
            alt={`${item.itemGroupName} · ${item.colourVariantName}`}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <Swatch familyName={item.colourFamilyName} size="lg" />
            <span className="eyebrow" style={{ color: 'var(--text-faint)', fontSize: '0.65rem' }}>
              no photo
            </span>
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            padding: '3px 8px',
            borderRadius: 999,
            background: 'rgba(0,0,0,0.72)',
            color: '#fff',
            fontSize: '0.72rem',
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}
        >
          {item.onHand.toLocaleString()}
        </div>
        {item.inTransitQty > 0 && (
          // In-transit chip sits under the on-hand pill on the same corner.
          // Signal (amber) so it reads as "attention / incoming", not stock
          // that already counts. Only rendered at markets with pending
          // arrivals — warehouses and empty markets get zero and skip it.
          <div
            style={{
              position: 'absolute',
              top: 32,
              right: 6,
              padding: '3px 8px',
              borderRadius: 999,
              background: 'var(--signal, #d2892a)',
              color: '#fff',
              fontSize: '0.68rem',
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}
            title="Currently in transit — not yet received"
          >
            +{item.inTransitQty} in transit
          </div>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          className="list-row-title"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={item.colourVariantName}
        >
          {item.colourVariantName}
        </div>
        <div
          className="list-row-meta"
          style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
        >
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
            title={`${item.sizeOptionName} · ${item.warehouseSku}`}
          >
            {item.sizeOptionName} · {item.warehouseSku}
          </span>
          <CopyButton text={item.warehouseSku} label="Copy SKU" size="sm" />
        </div>
      </div>
    </div>
  )
}

export default function ItemGroupPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER']}>
      <ItemGroupView />
    </RequireAuth>
  )
}
