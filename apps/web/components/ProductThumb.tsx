import type { WarehouseVariantSummary } from '@winterborn/shared'
import { Swatch } from './Swatch'

/// First non-null photo across a variation's variants, or null if none
/// have one. Cheap loop — a family rarely has more than a handful of
/// variants.
export function firstPhoto(variants: readonly WarehouseVariantSummary[]): string | null {
  for (const wv of variants) if (wv.photoUrl) return wv.photoUrl
  return null
}

/// Small product thumbnail for list rows across intake / requests. Renders
/// the first available product photo when there is one; otherwise falls
/// back to the colour swatch so unphotographed products still get a
/// visual affordance in the row.
export function ProductThumb({
  photoUrl,
  familyName,
  alt,
}: {
  photoUrl: string | null
  familyName: string
  alt: string
}) {
  if (!photoUrl) return <Swatch familyName={familyName} />
  return (
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-sunken)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl}
        alt={alt}
        loading="lazy"
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  )
}
