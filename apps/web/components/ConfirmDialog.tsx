'use client'

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Themed replacement for `window.confirm` — same intent (a modal yes/no
 * gate before a destructive or lossy action) but rendered in the app's
 * own design language so the copy fits alongside the surrounding UI
 * instead of the browser's stark black chrome. Modelled on the
 * `Scanner` overlay so both feel like the same design family.
 *
 * Handles the usual expectations:
 *   - Click the backdrop to cancel.
 *   - Escape to cancel.
 *   - Focuses the confirm button on open so keyboard operators can Enter
 *     straight through when they're sure. Cancel stays first in the DOM
 *     so Shift+Tab is intuitive.
 *
 * The `variant` decides the confirm button's colour. `danger` reads as
 * an irreversible loss (unpack, short-ship); `primary` reads as "go".
 */

export interface ConfirmDialogProps {
  open: boolean
  title: string
  /// Body copy — string or JSX so callers can render structured
  /// summaries (per-request shortfalls, etc.) without HTML escaping.
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  variant?: 'primary' | 'danger'
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  variant = 'primary',
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const prevActive = document.activeElement as HTMLElement | null
    // Focus the confirm button so the primary path is one Enter away.
    requestAnimationFrame(() => confirmRef.current?.focus())
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prevActive?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20, 15, 8, 0.55)',
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
          width: 'min(460px, 100%)',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--line-strong)',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.25)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '18px 20px 14px' }}>
          <h2
            id="confirm-dialog-title"
            style={{
              margin: 0,
              fontSize: '1.05rem',
              fontWeight: 700,
              color: 'var(--text)',
              letterSpacing: '-0.005em',
            }}
          >
            {title}
          </h2>
        </div>
        <div
          style={{
            padding: '0 20px 18px',
            fontSize: '0.9rem',
            color: 'var(--text-dim)',
            lineHeight: 1.5,
          }}
        >
          {typeof body === 'string' ? <p style={{ margin: 0 }}>{body}</p> : body}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '12px 16px 16px',
            borderTop: '1px solid var(--line)',
            background: 'var(--surface-sunken)',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
            style={{ minWidth: 96 }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
            style={{ minWidth: 120, width: 'auto' }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
