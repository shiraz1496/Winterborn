'use client'

import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import type { CatalogBrowseResponse, CatalogSearchHit, LocationDto } from '@winterborn/shared'
import { CopyButton } from '../../../../../components/CopyButton'
import { LocationPicker } from '../../../../../components/LocationPicker'
import { PageHeader } from '../../../../../components/PageHeader'
import { RequireAuth } from '../../../../../components/RequireAuth'
import { useAuth } from '../../../../../lib/auth-context'
import { ApiError, browseFolder, listLocations, searchCatalog } from '../../../../../lib/api'
import { Breadcrumbs, CatalogStats, SearchResults, TileGrid, catalogSearchClass, formatMoney, withLoc } from '../../_shared'

function FolderView() {
  const params = useParams<{ folderId: string }>()
  const folderId = params.folderId
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
      browseFolder(folderId, requestedLoc ?? undefined),
      listLocations(),
    ])
      .then(([res, locs]) => {
        setData(res)
        setLocations(locs)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this folder.'))
      .finally(() => setLoading(false))
  }, [folderId, requestedLoc])

  /// Deep search from any folder level: same endpoint as the root page.
  /// Debounced 700ms so we don't hammer the endpoint mid-typing. Search
  /// is always tree-wide (not scoped to the current folder) so an operator
  /// who's drilled into Apparel can still type "Beanie" and find it
  /// wherever it lives, even outside Apparel.
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
    router.replace(
      `/admin/catalog/f/${encodeURIComponent(folderId)}?loc=${encodeURIComponent(nextId)}`,
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
          { label: data?.folder?.name ?? '…' },
        ]}
      />
      <PageHeader
        eyebrow="Folder"
        title={data?.folder?.name ?? 'Folder'}
        description="Sub-folders and item groups inside this folder. Aggregates roll up across the whole subtree at the selected location."
        titleAdornment={
          data?.folder?.name ? (
            <CopyButton text={data.folder.name} label="Copy folder name" size="sm" />
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

export default function FolderPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER']}>
      <FolderView />
    </RequireAuth>
  )
}
