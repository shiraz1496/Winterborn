import type { StockStatus } from '@winterborn/shared'
import { STOCK_STATUS_LABEL } from '@winterborn/shared'

const ORDER: StockStatus[] = ['HEALTHY', 'LOW', 'CRITICAL', 'OUT_OF_STOCK']

const DOT_COLOUR: Record<StockStatus, string> = {
  HEALTHY: 'var(--pine)',
  LOW: 'var(--signal)',
  CRITICAL: 'var(--rust)',
  OUT_OF_STOCK: '#7a1414',
}

/// One-line legend explaining the four stock-status zones. Rendered once
/// at the top of the dashboard so the coloured chips on every row are
/// self-documenting without a manual.
export function StatusLegend() {
  return (
    <div className="legend" role="note" aria-label="Stock status legend">
      <span className="legend-title">Stock status</span>
      {ORDER.map((s) => (
        <span key={s} className="legend-item">
          <span className="legend-dot" style={{ background: DOT_COLOUR[s] }} />
          {STOCK_STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  )
}
