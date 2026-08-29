'use client'

import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import type { CatalogFolderRow } from '@winterborn/shared'
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
          className="list-row-title"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={folder.name}
        >
          {folder.name}
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
        gap: 6,
        alignItems: 'center',
        fontSize: '0.82rem',
        marginBottom: 8,
        color: 'var(--text-dim)',
      }}
    >
      {crumbs.map((c, i) => (
        <span key={`${i}:${c.label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {c.href ? (
            <Link href={c.href} style={{ color: 'var(--text-dim)', textDecoration: 'none' }}>
              {c.label}
            </Link>
          ) : (
            <span style={{ color: 'var(--ink)' }}>{c.label}</span>
          )}
          {i < crumbs.length - 1 && <span style={{ color: 'var(--text-faint)' }}>/</span>}
        </span>
      ))}
    </nav>
  )
}

export function CatalogWrap({ children }: { children: ReactNode }) {
  return <div>{children}</div>
}

/// A subfolder tile wraps `FolderTile` with a link to `/admin/catalog/f/[id]`.
/// An item-group tile links to `/admin/catalog/g/[id]`. Both share the same
/// visual because they read the same at the parent level (Sortly parity).
export function TileGrid({
  subfolders,
  itemGroups,
}: {
  subfolders: CatalogFolderRow[]
  itemGroups: CatalogFolderRow[]
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
          href={`/admin/catalog/f/${encodeURIComponent(f.id)}`}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <FolderTile folder={f} />
        </Link>
      ))}
      {itemGroups.map((ig) => (
        <Link
          key={`g:${ig.id}`}
          href={`/admin/catalog/g/${encodeURIComponent(ig.id)}`}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <FolderTile folder={ig} />
        </Link>
      ))}
    </div>
  )
}
