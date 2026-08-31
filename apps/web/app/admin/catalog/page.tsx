'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import type { CatalogBrowseResponse, CatalogSearchHit, LocationDto } from '@winterborn/shared'
import { LocationPicker } from '../../../components/LocationPicker'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { useAuth } from '../../../lib/auth-context'
import { ApiError, browseFolder, listLocations, searchCatalog } from '../../../lib/api'
import { CatalogStats, SearchResults, TileGrid, catalogSearchClass, formatMoney } from './_shared'

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
  const [searchHits, setSearchHits] = useState<CatalogSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)

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

  /// Deep search: server call, debounced 700ms so the endpoint isn't hit
  /// on every keystroke while the operator is still typing. Empty query
  /// clears results and reverts to the browse grid. Guarded against race
  /// conditions by checking the query still matches when the response
  /// comes back.
  useEffect(() => {
    const q = query.trim()
    if (q.length === 0) {
      setSearchHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const handle = setTimeout(() => {
      searchCatalog(q, requestedLoc ?? undefined)
        .then((res) => {
          if (res.query === q) setSearchHits(res.hits)
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Search failed.'))
        .finally(() => setSearching(false))
    }, 700)
    return () => clearTimeout(handle)
  }, [query, requestedLoc])

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
          placeholder="Search folder, item, colour, size, or SKU"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={catalogSearchClass}
        />
      </div>

      {searchHits !== null ? (
        <SearchResults hits={searchHits} loading={searching} locationId={currentLocationId} />
      ) : (
        <TileGrid
          subfolders={data?.subfolders ?? []}
          itemGroups={data?.itemGroups ?? []}
          locationId={currentLocationId}
        />
      )}
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
