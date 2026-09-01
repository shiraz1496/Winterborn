'use client'

import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import type { CatalogFolderRow, CatalogSearchHit } from '@winterborn/shared'
import { CopyButton } from '../../../components/CopyButton'
import { Swatch } from '../../../components/Swatch'

/// Utility-class fallback for the search input across catalog screens. Kept
/// as a string so the same styling lives in one place without dropping down
/// to global CSS or picking up a component-lib dependency.
export const catalogSearchClass = 'catalog-search'

export function formatMoney(cents: number): string {
  const dollars = cents / 100
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

interface Stat {
  label: string
  value: string
}

/// The stats strip at the top of every folder screen. Mirrors Sortly's
/// "Folders: 8  Items: 0  Total Quantity: 50718 units  Total Value:
/// $18,965.00" bar.
export function CatalogStats({ left }: { left: Stat[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '18px 32px',
        alignItems: 'baseline',
        padding: '12px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      {left.map((s) => (
        <div key={s.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>{s.label}:</span>
          <strong style={{ fontSize: '1rem' }}>{s.value}</strong>
        </div>
      ))}
    </div>
  )
}

/// One folder card. Photo (or Swatch fallback), name, and the three counts
/// Sortly shows on each tile: sub-folders (📁), items (📦), value ($).
export function FolderTile({ folder }: { folder: CatalogFolderRow }) {
  return (
    <div
      className="card"
      style={{
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 0.12s, transform 0.12s',
      }}
    >
      <FolderThumb photoUrl={folder.previewPhotoUrl} name={folder.name} />
      <div style={{ minWidth: 0 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}
        >
          <div
            className="list-row-title"
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
            title={folder.name}
          >
            {folder.name}
          </div>
          <CopyButton text={folder.name} label="Copy name" size="sm" />
        </div>
        <div
          className="list-row-meta"
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: 4,
          }}
        >
          {folder.subfolderCount > 0 && (
            <IconStat glyph="folder" value={folder.subfolderCount} />
          )}
          <IconStat glyph="stack" value={folder.itemCount} />
          <IconStat glyph="money" value={formatMoney(folder.totalValueCents)} />
          {folder.inTransitQty > 0 && (
            // Amber pill hints at "N units incoming" — matches the
            // colour we use elsewhere for pending/inbound status so the
            // market manager can spot arrivals at a glance.
            <span
              title="Units currently in transit to this market"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: 999,
                background: 'rgba(210, 137, 42, 0.14)',
                color: 'var(--signal, #d2892a)',
                fontSize: '0.7rem',
                fontWeight: 700,
                letterSpacing: '0.03em',
              }}
            >
              +{folder.inTransitQty} in transit
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function FolderThumb({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '4 / 3',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-sunken)',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl}
          alt={name}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        <Swatch familyName={null} size="lg" />
      )}
    </div>
  )
}

function IconStat({ glyph, value }: { glyph: 'folder' | 'stack' | 'money'; value: number | string }) {
  const iconStyle: CSSProperties = { width: 14, height: 14, verticalAlign: '-2px', color: 'var(--text-faint)' }
  const svg =
    glyph === 'folder' ? (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={iconStyle} aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ) : glyph === 'stack' ? (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={iconStyle} aria-hidden="true">
        <path d="M12 3l9 5-9 5-9-5z" />
        <path d="M3 13l9 5 9-5" />
        <path d="M3 18l9 5 9-5" />
      </svg>
    ) : (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={iconStyle} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9c0-1.1.9-2 2-2h2c1.1 0 2 .9 2 2s-.9 2-2 2h-2c-1.1 0-2 .9-2 2s.9 2 2 2h2c1.1 0 2-.9 2-2M12 5v14" />
      </svg>
    )
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.78rem' }}>
      {svg}
      <span>{typeof value === 'number' ? value.toLocaleString() : value}</span>
    </span>
  )
}

/// Sortly-style crumb trail at the top of every drill-in screen.
export function Breadcrumbs({ crumbs }: { crumbs: Array<{ href?: string; label: string }> }) {
  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        fontSize: '0.82rem',
        marginBottom: 14,
        padding: '8px 12px',
        // On narrow screens the pill shape looks awkward when it wraps
        // to multiple lines, so drop to a normal rounded-rect border
        // instead of the fully-rounded 999px pill. Still visually
        // distinct from surrounding chrome but doesn't awkwardly shape
        // a two-line breadcrumb into a stadium.
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--line)',
        rowGap: 6,
        columnGap: 2,
        // No fit-content cap — let the pill grow to fill the row width
        // so long breadcrumbs wrap cleanly instead of being clipped by
        // an "intrinsic" width the browser guessed too small.
      }}
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1
        return (
          <span key={`${i}:${c.label}`} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {c.href && !isLast ? (
              <Link
                href={c.href}
                style={{
                  color: 'var(--text-dim)',
                  textDecoration: 'none',
                  padding: '2px 8px',
                  borderRadius: 999,
                  transition: 'background 0.1s, color 0.1s',
                }}
                // Hover state via inline handlers — the app's globals.css
                // doesn't ship a scoped Breadcrumb rule and we want the
                // trail to visibly respond to pointer without touching
                // shared styling elsewhere.
                // Hover uses the same amber the sidebar's active nav
                // item uses (`.app-sidebar-item.active` in globals.css) so
                // the breadcrumb feels part of the same navigation system.
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(210, 137, 42, 0.1)'
                  e.currentTarget.style.color = 'var(--signal, #d2892a)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--text-dim)'
                }}
              >
                {c.label}
              </Link>
            ) : (
              <span
                aria-current={isLast ? 'page' : undefined}
                style={{
                  color: isLast ? 'var(--text)' : 'var(--text-dim)',
                  fontWeight: isLast ? 600 : 400,
                  padding: '2px 8px',
                }}
              >
                {c.label}
              </span>
            )}
            {!isLast && (
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                aria-hidden="true"
                style={{ color: 'var(--text-faint)', flexShrink: 0 }}
              >
                <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
        )
      })}
    </nav>
  )
}

export function CatalogWrap({ children }: { children: ReactNode }) {
  return <div>{children}</div>
}

/// Append the location filter to a drill-in href so navigation preserves
/// whichever location the operator was viewing. Passing null omits the
/// query — server-side default (first warehouse) applies.
export function withLoc(href: string, locationId: string | null): string {
  if (!locationId) return href
  const sep = href.includes('?') ? '&' : '?'
  return `${href}${sep}loc=${encodeURIComponent(locationId)}`
}

/// A subfolder tile wraps `FolderTile` with a link to `/admin/catalog/f/[id]`.
/// An item-group tile links to `/admin/catalog/g/[id]`. Both share the same
/// visual because they read the same at the parent level (Sortly parity).
/// `locationId` (when set) is appended so the drill-in stays scoped to
/// the same location.
export function TileGrid({
  subfolders,
  itemGroups,
  locationId,
}: {
  subfolders: CatalogFolderRow[]
  itemGroups: CatalogFolderRow[]
  locationId: string | null
}) {
  if (subfolders.length === 0 && itemGroups.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">Empty folder</p>
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
          No sub-folders or items here yet.
        </p>
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 14,
      }}
    >
      {subfolders.map((f) => (
        <Link
          key={`f:${f.id}`}
          href={withLoc(`/admin/catalog/f/${encodeURIComponent(f.id)}`, locationId)}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <FolderTile folder={f} />
        </Link>
      ))}
      {itemGroups.map((ig) => (
        <Link
          key={`g:${ig.id}`}
          href={withLoc(`/admin/catalog/g/${encodeURIComponent(ig.id)}`, locationId)}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <FolderTile folder={ig} />
        </Link>
      ))}
    </div>
  )
}

/// Deep-search results view. Compact row layout: small thumbnail on the
/// left, name + breadcrumb path in the middle, item count and value on
/// the right. Optimised for scanning many hits without eating the whole
/// viewport per row. Folder hits link to the folder itself; item-group
/// hits link to the group page. Empty-state and loading states live here
/// so both callers stay simple.
export function SearchResults({
  hits,
  loading,
  locationId,
}: {
  hits: CatalogSearchHit[]
  loading: boolean
  locationId: string | null
}) {
  if (loading && hits.length === 0) {
    return (
      <div className="empty-state">
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>Searching…</p>
      </div>
    )
  }
  if (hits.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">No matches</p>
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: '0.9rem' }}>
          Try a different folder or product name.
        </p>
      </div>
    )
  }

  const folderHits = hits.filter((h) => h.kind === 'folder')
  const itemGroupHits = hits.filter((h) => h.kind === 'item-group')
  const itemHits = hits.filter((h) => h.kind === 'item')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {itemHits.length > 0 && (
        <SearchGroup title="Items" count={itemHits.length} hits={itemHits} locationId={locationId} />
      )}
      {itemGroupHits.length > 0 && (
        <SearchGroup title="Products" count={itemGroupHits.length} hits={itemGroupHits} locationId={locationId} />
      )}
      {folderHits.length > 0 && (
        <SearchGroup title="Folders" count={folderHits.length} hits={folderHits} locationId={locationId} />
      )}
    </div>
  )
}

function SearchGroup({
  title,
  count,
  hits,
  locationId,
}: {
  title: string
  count: number
  hits: CatalogSearchHit[]
  locationId: string | null
}) {
  return (
    <section>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '4px 0 8px',
          fontSize: '0.78rem',
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        <span>{title}</span>
        <span style={{ color: 'var(--text-faint)' }}>{count}</span>
      </header>
      <div
        className="card"
        style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
      >
        {hits.map((hit, i) => (
          <SearchRow key={`${hit.kind}:${hit.row.id}`} hit={hit} locationId={locationId} last={i === hits.length - 1} />
        ))}
      </div>
    </section>
  )
}

function SearchRow({
  hit,
  locationId,
  last,
}: {
  hit: CatalogSearchHit
  locationId: string | null
  last: boolean
}) {
  const href =
    hit.kind === 'folder'
      ? withLoc(`/admin/catalog/f/${encodeURIComponent(hit.row.id)}`, locationId)
      : hit.kind === 'item'
        ? withLoc(`/admin/catalog/i/${encodeURIComponent(hit.row.id)}`, locationId)
        : withLoc(`/admin/catalog/g/${encodeURIComponent(hit.row.id)}`, locationId)
  return (
    <Link
      href={href}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <SearchThumb photoUrl={hit.row.previewPhotoUrl} name={hit.row.name} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: '0.95rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={hit.row.name}
        >
          {hit.row.name}
        </div>
        {hit.path.length > 0 && (
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={hit.path.map((c) => c.name).join(' › ')}
          >
            in {hit.path.map((c) => c.name).join(' › ')}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          fontSize: '0.78rem',
          color: 'var(--text-dim)',
          flexShrink: 0,
        }}
      >
        {hit.kind === 'folder' && hit.row.subfolderCount > 0 && (
          <IconStat glyph="folder" value={hit.row.subfolderCount} />
        )}
        <IconStat glyph="stack" value={hit.row.itemCount} />
        <span style={{ minWidth: 72, textAlign: 'right' }}>
          {formatMoney(hit.row.totalValueCents)}
        </span>
      </div>
    </Link>
  )
}

function SearchThumb({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  return (
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-sunken)',
        overflow: 'hidden',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl}
          alt={name}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      ) : (
        <Swatch familyName={null} size="md" />
      )}
    </div>
  )
}
