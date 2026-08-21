'use client'

import { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

/// Renders `value` (a box's opaque qrToken -- never contents, per spec §9.4)
/// as a scannable QR code onto a canvas. Printed at warehouse-label size,
/// so the quiet zone (margin) matters more than it would on screen.
export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!ref.current) return
    void QRCode.toCanvas(ref.current, value, {
      width: size,
      margin: 2,
      color: { dark: '#201d17', light: '#ece7dc' },
    })
  }, [value, size])

  return <canvas ref={ref} width={size} height={size} style={{ display: 'block' }} />
}
