import type { BoxLabelDto } from '@winterborn/shared'

export function BoxLabel({ label }: { label: BoxLabelDto }) {
  return (
    <div className="label-ticket">
      <div className="eyebrow" style={{ color: 'var(--paper-ink)', opacity: 0.6 }}>
        Winterborn · restock box
      </div>
      <div className="label-dest">{label.destinationLocationName}</div>
      <div className="row-between">
        <div>
          <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>box id</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
            {label.qrToken.slice(0, 12).toUpperCase()}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>lines</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{label.lineCount}</div>
          <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: 10 }}>packed</div>
          <div style={{ fontSize: '0.85rem' }}>
            {label.packedAt ? new Date(label.packedAt).toLocaleDateString() : '—'}
          </div>
        </div>
      </div>
      <div className="label-token">{label.qrToken}</div>
    </div>
  )
}
