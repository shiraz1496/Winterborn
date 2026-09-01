import type { ReactNode } from 'react'
import { InfoTooltip } from './InfoTooltip'

/// Consolidates the "big heading + explanatory paragraph" pattern that
/// used to appear as `<h2>` followed by `<p className="section-desc">`
/// on almost every screen. The paragraph now lives behind an info icon
/// so the section reads clean, while the copy stays discoverable.
///
/// Callers still get to slot arbitrary trailing content (a count chip, a
/// menu button) via `right`.
export function SectionHeading({
  title,
  description,
  right,
  level = 2,
}: {
  title: ReactNode
  description?: ReactNode
  right?: ReactNode
  /// Semantic level for the heading — most sections are h2; some pages
  /// use h3 within a card.
  level?: 2 | 3
}) {
  const Heading = level === 3 ? 'h3' : 'h2'
  return (
    <div className="section-heading">
      <Heading style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {title}
        {description && <InfoTooltip label="More about this section">{description}</InfoTooltip>}
      </Heading>
      {right}
    </div>
  )
}
