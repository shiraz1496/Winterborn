'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { BoxLabelDto } from '@winterborn/shared'

/// Printable label for a packed box. Renders the destination, box id,
/// pack date, line count, and a scannable QR of the qrToken. Prints
/// straight from the browser via `window.print()` — the label CSS
/// already isolates this ticket on print.
export function BoxLabel({ label }: { label: BoxLabelDto }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Higher error-correction level (H = 30%) so a scuff on a warehouse
    // sticker doesn't render the label unscannable. Margin=1 keeps the
    // quiet zone small so the QR fits alongside the text on the ticket.
    QRCode.toDataURL(label.qrToken, { errorCorrectionLevel: 'H', margin: 1, width: 220 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [label.qrToken])

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
      {label.lines.length > 0 && (
        <div
          style={{
            marginTop: 14,
            paddingTop: 10,
            borderTop: '1px dashed var(--paper-ink, #666)',
            opacity: 0.85,
          }}
        >
          <div
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
              opacity: 0.75,
            }}
          >
            contents
          </div>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.82rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <tbody>
              {label.lines.map((line) => (
                <tr key={line.warehouseVariantId} style={{ borderBottom: '1px dotted rgba(0,0,0,0.15)' }}>
                  <td style={{ padding: '3px 0', verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 700 }}>{line.itemGroupName}</div>
                    <div style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                      {line.colourVariantName} · {line.sizeOptionName} · {line.warehouseSku}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '3px 0',
                      textAlign: 'right',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      verticalAlign: 'top',
                      minWidth: 40,
                    }}
                  >
                    ×{line.quantity}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Everything from here down is what Print isolates. The wrapper
          class lets print CSS hide the header / box-id / contents
          block above so a printed sticker carries the QR and its token
          only — nothing else the scanner or eye needs. On-screen
          layout is untouched (screen operators still see the full
          ticket alongside the QR). */}
      <div className="label-qr-block">
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '14px 0 6px',
          }}
        >
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt={`QR code for box ${label.qrToken.slice(0, 12).toUpperCase()}`}
              width={200}
              height={200}
              style={{ display: 'block' }}
            />
          ) : (
            <div
              style={{
                width: 200,
                height: 200,
                background: 'var(--paper, #fff)',
                border: '1px dashed var(--paper-ink, #666)',
                opacity: 0.4,
              }}
              aria-hidden="true"
            />
          )}
        </div>
        <div className="label-token" style={{ fontSize: '0.7rem', textAlign: 'center', opacity: 0.7 }}>
          {label.qrToken}
        </div>
      </div>
    </div>
  )
}
