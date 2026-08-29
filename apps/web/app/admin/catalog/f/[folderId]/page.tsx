'use client'

import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import type { CatalogBrowseResponse } from '@winterborn/shared'
import { PageHeader } from '../../../../../components/PageHeader'
import { RequireAuth } from '../../../../../components/RequireAuth'
import { ApiError, browseFolder } from '../../../../../lib/api'
import { Breadcrumbs, CatalogStats, TileGrid, catalogSearchClass, formatMoney } from '../../_shared'

function FolderView() {
  const params = useParams<{ folderId: string }>()
  const folderId = params.folderId
  const [data, setData] = useState<CatalogBrowseResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setLoading(true)
    browseFolder(folderId)
      .then((res) => {
        setData(res)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this folder.'))
      .finally(() => setLoading(false))
  }, [folderId])

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

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div>
      <Breadcrumbs
        crumbs={[
          { href: '/admin/catalog', label: 'Catalog' },
          ...(data?.breadcrumb.map((c) => ({
            href: `/admin/catalog/f/${encodeURIComponent(c.id)}`,
            label: c.name,
          })) ?? []),
          { label: data?.folder?.name ?? '…' },
        ]}
      />
      <PageHeader
        eyebrow="Folder"
        title={data?.folder?.name ?? 'Folder'}
        description="Sub-folders and item groups inside this folder. Aggregates roll up across the whole subtree."
      />

      {error && <p className="error-banner">{error}</p>}

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

      <TileGrid subfolders={filtered.subfolders} itemGroups={filtered.itemGroups} />
    </div>
  )
}

export default function FolderPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']}>
      <FolderView />
    </RequireAuth>
  )
}
