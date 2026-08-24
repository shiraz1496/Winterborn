import type { StockStatus } from '@winterborn/shared'
import { STOCK_STATUS_LABEL } from '@winterborn/shared'

const CHIP_CLASS: Record<StockStatus, string> = {
  HEALTHY: 'chip chip-pine',
  LOW: 'chip chip-signal',
  CRITICAL: 'chip chip-rust',
  OUT_OF_STOCK: 'chip chip-oos',
}

export function StockStatusChip({ status }: { status: StockStatus }) {
  return <span className={CHIP_CLASS[status]}>{STOCK_STATUS_LABEL[status]}</span>
}
