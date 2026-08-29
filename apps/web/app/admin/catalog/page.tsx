'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import type { CatalogBrowseResponse, LocationDto } from '@winterborn/shared'
import { LocationPicker } from '../../../components/LocationPicker'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { useAuth } from '../../../lib/auth-context'
import { ApiError, browseFolder, listLocations } from '../../../lib/api'
import { CatalogStats, TileGrid, catalogSearchClass, formatMoney } from './_shared'

function CatalogRoot() {
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedLoc = searchParams.get('loc')

  const canSwitchLocation = user?.role !== 'MARKET_MANAGER'

  const [data, setData] = useState<CatalogBrowseResponse | null>(null)
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setLoading(true)
    Promise.all([
      browseFolder(undefined, requestedLoc ?? undefined),
      listLocations(),
    ])
      .then(([res, locs]) => {
        setData(res)
        setLocations(locs)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the catalog.'))
      .finally(() => setLoading(false))
  }, [requestedLoc])

  const filtered = useMemo(() => {
    if (!data) return { subfolders: [], itemGroups: [] }
    const q = query.trim().toLowerCase()
    if (q.length === 0) return { subfolders: data.subfolders, itemGroups: data.itemGroups }
    return {
      subfolders: data.subfolders.filter((f) => f.name.toLowerCase().includes(q)),
      itemGroups: data.itemGroups.filter((f) => f.name.toLowerCase().includes(q)),
    }
  }, [data, query])

  const totals = useMemo(() => {
    if (!data) return { folderCount: 0, itemCount: 0, totalQty: 0, totalValueCents: 0 }
    const all = [...data.subfolders, ...data.itemGroups]
    let itemCount = 0
    let totalQty = 0
    let totalValueCents = 0
    for (const f of all) {
      itemCount += f.itemCount
      totalQty += f.totalQty
      totalValueCents += f.totalValueCents
    }
    return { folderCount: all.length, itemCount, totalQty, totalValueCents }
  }, [data])

  function pickLocation(nextId: string) {
    router.replace(`/admin/catalog?loc=${encodeURIComponent(nextId)}`)
  }

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  const currentLocationId = data?.location?.id ?? null
  const locationName = data?.location?.name ?? 'BärHaus (IN STOCK)'

  return (
    <div>
      <PageHeader
        eyebrow="Catalog"
        title={locationName}
        description="The full Sortly-style folder tree. On-hand aggregates reflect the selected location. Drill in for photos and per-SKU counts."
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
          { label: 'Folders', value: totals.folderCount.toString() },
          { label: 'Items', value: totals.itemCount.toString() },
          { label: 'Total Quantity', value: `${totals.totalQty.toLocaleString()} units` },
          { label: 'Total Value', value: formatMoney(totals.totalValueCents) },
        ]}
      />

      <div style={{ marginTop: 18, marginBottom: 14 }}>
        <input
          type="search"
          placeholder="Search folders…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={catalogSearchClass}
        />
      </div>

      <TileGrid
        subfolders={filtered.subfolders}
        itemGroups={filtered.itemGroups}
        locationId={currentLocationId}
      />
    </div>
  )
}

export default function CatalogPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER']}>
      <CatalogRoot />
    </RequireAuth>
  )
}
