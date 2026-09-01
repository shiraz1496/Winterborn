import type { ReactNode } from 'react'
import { InfoTooltip } from './InfoTooltip'

/// One consistent opening on every page. `eyebrow` is an optional small tag
/// above the title (role scope, breadcrumb hint); `description` is a plain-
/// language line answering "what am I looking at and what am I supposed to
/// do here" — now shown as a hoverable info icon beside the title so it
/// doesn't dominate the layout on every page. Actions render on the right
/// side when there is room.
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  titleAdornment,
}: {
  title: string
  description?: ReactNode
  eyebrow?: string
  actions?: ReactNode
  /// Inline slot rendered directly beside the h1 (e.g. a copy-title button).
  /// Distinct from `actions`, which sits on the far right of the header row.
  titleAdornment?: ReactNode
}) {
  return (
    <header className="page-header">
      <div className="page-header-top">
        <div>
          {eyebrow && <div className="page-header-eyebrow">{eyebrow}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{title}</h1>
            {description && (
              <InfoTooltip label={`About ${title}`}>{description}</InfoTooltip>
            )}
            {titleAdornment}
          </div>
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
    </header>
  )
}
