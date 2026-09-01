'use client'

import { useEffect, useState } from 'react'
import type { SquareCatalogItemDto, SquareCatalogSyncResult, SquareMappingOrphans } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { SectionHeading } from '../../../components/SectionHeading'
import { RequireAuth } from '../../../components/RequireAuth'
import {
  ApiError,
  listSquareCatalogItems,
  listSquareMappingOrphans,
  syncSquareCatalog,
} from '../../../lib/api'

function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function SquareSyncBody() {
  const [items, setItems] = useState<SquareCatalogItemDto[]>([])
  const [orphans, setOrphans] = useState<SquareMappingOrphans>({ squareOnly: [], winterbornOnly: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<SquareCatalogSyncResult | null>(null)

  async function refresh() {
    setLoadError(null)
    try {
      const [i, o] = await Promise.all([listSquareCatalogItems(), listSquareMappingOrphans()])
      setItems(i)
      setOrphans(o)
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load the cache.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function onSync() {
    setSyncing(true)
    setSyncError(null)
    try {
      const result = await syncSquareCatalog()
      setLastResult(result)
      await refresh()
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : 'Sync failed.')
    } finally {
      setSyncing(false)
    }
  }

  const oldestSync = items.length > 0 ? items.reduce((min, i) => (i.lastSyncedAt < min ? i.lastSyncedAt : min), items[0].lastSyncedAt) : null
  const isStale = oldestSync ? Date.now() - new Date(oldestSync).getTime() > 24 * 60 * 60 * 1000 : false

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
        title="Square sync"
        description="Pull every item and variation from Square into the local cache. The mapping modal reads from this cache — resync whenever you add or rename catalog rows in Square."
      />

      {loadError && <p className="error-banner">{loadError}</p>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSync}
            disabled={syncing}
            style={{ minHeight: 40 }}
          >
            {syncing ? 'Syncing…' : 'Sync Square catalog'}
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="eyebrow" style={{ fontSize: '0.72rem' }}>
              {items.length} item{items.length === 1 ? '' : 's'} cached · {items.reduce((sum, i) => sum + i.variationCount, 0)} variations
            </div>
            {oldestSync && (
              <div style={{ fontSize: '0.75rem', color: isStale ? 'var(--danger)' : 'var(--text-dim)' }}>
                Oldest sync: {relativeTime(oldestSync)} {isStale && '· stale, resync recommended'}
              </div>
            )}
          </div>
        </div>
        {syncError && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 10 }}>{syncError}</p>}
        {lastResult && !syncError && (
          <p style={{ color: 'var(--pine)', fontSize: '0.85rem', marginTop: 10 }}>
            Sync complete: {lastResult.itemsSynced} items, {lastResult.variationsSynced} variations synced.
            {lastResult.itemsRemoved + lastResult.variationsRemoved > 0 &&
              ` ${lastResult.itemsRemoved} items and ${lastResult.variationsRemoved} variations removed.`}
          </p>
        )}
      </div>

      <div className="dash-columns">
        <div>
          <SectionHeading
            title="In Square but not linked to a Winterborn product"
            description="Cached Square items whose ID isn't set on any Winterborn ItemGroup. Either wire them up on the Square mapping page or ignore (they may be gift cards / tips / test items)."
            right={<span className="eyebrow">{orphans.squareOnly.length}</span>}
          />
          {orphans.squareOnly.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>Nothing orphaned on the Square side.</p>
            </div>
          ) : (
            <div className="stack" style={{ gap: 4 }}>
              {orphans.squareOnly.map((o) => (
                <div key={o.squareItemId} className="list-row">
                  <div className="list-row-body">
                    <div className="list-row-title">{o.name}</div>
                    <div className="list-row-meta mono" style={{ fontSize: '0.72rem' }}>{o.squareItemId}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionHeading
            title="Winterborn products with no Square link yet"
            description="Winterborn ItemGroups that don't have a Square item ID set. These won't decrement stock from Square sales until they're mapped."
            right={<span className="eyebrow">{orphans.winterbornOnly.length}</span>}
          />
          {orphans.winterbornOnly.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>Every Winterborn product is linked to a Square item.</p>
            </div>
          ) : (
            <div className="stack" style={{ gap: 4 }}>
              {orphans.winterbornOnly.slice(0, 30).map((o) => (
                <div key={o.itemGroupId} className="list-row">
                  <div className="list-row-body">
                    <div className="list-row-title">{o.name}</div>
                    <div className="list-row-meta">{o.categoryName}</div>
                  </div>
                </div>
              ))}
              {orphans.winterbornOnly.length > 30 && (
                <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginTop: 4 }}>
                  + {orphans.winterbornOnly.length - 30} more
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionHeading
          title="All cached Square items"
          description="Straight dump of every ITEM row Square returned on the last sync."
          right={<span className="eyebrow">{items.length}</span>}
        />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
            <th style={{ padding: '6px 8px' }}>Item name</th>
            <th style={{ padding: '6px 8px' }}>Variations</th>
            <th style={{ padding: '6px 8px' }}>Square item ID</th>
            <th style={{ padding: '6px 8px' }}>Last synced</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.squareItemId} style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <td style={{ padding: '6px 8px' }}>{i.name}</td>
              <td style={{ padding: '6px 8px' }}>{i.variationCount}</td>
              <td style={{ padding: '6px 8px' }} className="mono">{i.squareItemId}</td>
              <td style={{ padding: '6px 8px', color: 'var(--text-dim)' }}>{relativeTime(i.lastSyncedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function SquareSyncPage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE_MANAGER']}>
      <SquareSyncBody />
    </RequireAuth>
  )
}
