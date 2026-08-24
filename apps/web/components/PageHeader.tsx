import type { ReactNode } from 'react'

/// One consistent opening on every page. `eyebrow` is an optional small tag
/// above the title (role scope, breadcrumb hint); `description` is a plain-
/// language line answering "what am I looking at and what am I supposed to
/// do here". Actions render on the right side when there is room.
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string
  description?: string
  eyebrow?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div className="page-header-top">
        <div>
          {eyebrow && <div className="page-header-eyebrow">{eyebrow}</div>}
          <h1>{title}</h1>
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      {description && <p className="page-header-desc">{description}</p>}
    </header>
  )
}
