'use client'

import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode'
import type { ReceiveBoxResult } from '@winterborn/shared'
import { ApiError, receiveBox } from '../lib/api'

/// Modal camera scanner. Opens a live camera view (via html5-qrcode),
/// reads a single QR code, calls POST /boxes/receive with the token,
/// and returns the server's result to the caller via `onScanned`.
///
/// `expectedRequestId` scopes the scanner to one specific request — a
/// scan for a box that belongs to a different request is rejected in
/// the UI with a clear "wrong request" message so the manager knows
/// they grabbed the wrong label. Leave undefined for the global scanner
/// (accept any box the operator is authorised for).

const SCANNER_DIV_ID = 'winterborn-scanner-view'

export function Scanner({
  open,
  onClose,
  onScanned,
  expectedRequestId,
}: {
  open: boolean
  onClose: () => void
  onScanned: (result: ReceiveBoxResult) => void
  expectedRequestId?: string
}) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'starting' | 'scanning' | 'submitting'>('starting')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let scanner: Html5Qrcode | null = null

    // React StrictMode fires this effect + its cleanup twice in dev
    // (Mount → Cleanup → Mount) synchronously before any timers or
    // microtasks run. If we call `Html5Qrcode.start()` directly from
    // the effect body, both mounts create a scanner instance and both
    // pending `start()` promises inject a <video> into the same div —
    // the "two faces" bug. Deferring the real work behind a
    // `setTimeout(..., 0)` guarantees the first mount's cleanup fires
    // (setting cancelled=true and clearing the timer) before any
    // camera work happens. Only the second (real) mount ever
    // actually creates a scanner.
    const bootHandle = setTimeout(() => {
      if (cancelled) return
      const el = document.getElementById(SCANNER_DIV_ID)
      if (!el) return
      // Defensive: if a prior aborted attempt somehow left a video
      // behind, wipe it before booting the real scanner.
      el.innerHTML = ''

      scanner = new Html5Qrcode(SCANNER_DIV_ID, { verbose: false })
      scannerRef.current = scanner

      scanner
        .start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          async (decoded) => {
            if (busyRef.current || cancelled) return
            busyRef.current = true
            setStatus('submitting')
            try {
              // Pass expectedRequestId server-side. If the box belongs
              // to a different request, the API throws BEFORE any
              // ledger write — this is the fix for the "wrong box
              // still added to stock" bug where the client checked
              // after the write had already landed.
              const result = await receiveBox(decoded, expectedRequestId)
              if (cancelled) return
              onScanned(result)
            } catch (err) {
              if (cancelled) return
              const msg = err instanceof ApiError ? err.message : 'Could not process this code.'
              setError(msg)
              busyRef.current = false
              setStatus('scanning')
            }
          },
          () => {
            // Per-frame decode misses are expected while aiming the camera.
          },
        )
        .then(() => {
          if (cancelled) {
            // Unmounted before start() resolved — tear down.
            void scanner?.stop().catch(() => undefined)
            try {
              scanner?.clear()
            } catch {
              // ignore
            }
            return
          }
          setStatus('scanning')
        })
        .catch((err) => {
          if (cancelled) return
          const msg = err instanceof Error ? err.message : 'Could not start the camera.'
          setError(msg)
        })
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(bootHandle)
      const s = scanner
      scanner = null
      scannerRef.current = null
      if (!s) return
      try {
        const state = s.getState()
        if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) {
          s.stop()
            .then(() => s.clear())
            .catch(() => undefined)
        }
      } catch {
        // ignore
      }
    }
  }, [open, expectedRequestId, onScanned])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan box QR"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, 100%)',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div>
            <div className="eyebrow" style={{ color: 'var(--text-dim)' }}>
              Scan
            </div>
            <h2 style={{ margin: '2px 0 0', fontSize: '1rem' }}>
              {expectedRequestId ? 'Receive a box on this request' : 'Receive any box'}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="Close"
            style={{ minHeight: 32, padding: '4px 10px' }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 12 }}>
          <div
            id={SCANNER_DIV_ID}
            style={{
              width: '100%',
              minHeight: 280,
              background: '#000',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}
          />
          <p
            style={{
              margin: '10px 0 0',
              color: 'var(--text-dim)',
              fontSize: '0.85rem',
              textAlign: 'center',
            }}
          >
            {status === 'starting' && 'Starting camera…'}
            {status === 'scanning' && 'Point the camera at the box QR label.'}
            {status === 'submitting' && 'Confirming…'}
          </p>
          {error && (
            <p
              className="error-banner"
              style={{ marginTop: 10 }}
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
