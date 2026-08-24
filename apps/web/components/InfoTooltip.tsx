'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/// Small (?) badge inline with text or chips. Tap or hover to reveal a
/// short explanation of what a computed value means. Deliberately not a
/// modal -- an operator glancing at the screen should not have to dismiss
/// anything to keep working.
export function InfoTooltip({ label, children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <span className="info-tip" ref={ref}>
      <button
        type="button"
        className="info-tip-trigger"
        aria-label={label ?? 'More info'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        ?
      </button>
      {open && <span className="info-tip-bubble">{children}</span>}
    </span>
  )
}
