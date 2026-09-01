'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, CSSProperties } from 'react'

/// Small (?) badge inline with text or chips. Tap or hover to reveal a
/// short explanation of what a computed value means. Deliberately not a
/// modal -- an operator glancing at the screen should not have to dismiss
/// anything to keep working.
///
/// Positioning: after mount, measure the bubble's rect. If it overflows
/// the viewport horizontally, nudge left/right with an inline offset so
/// the bubble stays fully on-screen. THEN reposition the arrow so it
/// always points at the trigger's center — otherwise a shifted bubble
/// ends up with an arrow that visually disconnects from the icon.

interface BubbleStyle extends CSSProperties {
  '--tip-arrow-left'?: string
}

export function InfoTooltip({ label, children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement | null>(null)
  const bubbleRef = useRef<HTMLSpanElement | null>(null)
  const [bubbleStyle, setBubbleStyle] = useState<BubbleStyle>({})

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

  useLayoutEffect(() => {
    if (!open) {
      setBubbleStyle({})
      return
    }
    function measure() {
      const bubble = bubbleRef.current
      const parent = ref.current
      if (!bubble || !parent) return

      // Reset any prior inline positioning so the bubble measures at its
      // "natural" spot (right: 0 relative to the trigger, per the base CSS).
      bubble.style.left = ''
      bubble.style.right = ''
      const rect = bubble.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const viewport = window.innerWidth
      const gutter = 8

      let leftOffset: number | undefined
      let rightOffset: number | undefined = 0 // default anchor

      if (rect.left < gutter) {
        // Bubble clips off the left edge. Anchor its left edge to the
        // viewport's left gutter — offset expressed relative to the
        // parent span (the CSS reference frame for `left:`).
        leftOffset = gutter - parentRect.left
        rightOffset = undefined
      } else if (rect.right > viewport - gutter) {
        // Bubble clips off the right edge. Push it left by the overshoot.
        rightOffset = rect.right - (viewport - gutter)
        leftOffset = undefined
      }

      // Compute where the arrow should sit horizontally so it points at
      // the trigger's centre. Expressed as pixels from the bubble's own
      // left edge — CSS var `--tip-arrow-left` consumes it in globals.css.
      // Measure bubble's post-adjustment rect by predicting its new left:
      let bubbleLeftX: number
      if (leftOffset !== undefined) {
        // Bubble anchored to viewport gutter on the left.
        bubbleLeftX = gutter
      } else if (rightOffset !== undefined) {
        // Bubble anchored right (either default `right:0` or a shifted
        // right offset). Its right edge sits at parentRect.right - rightOffset,
        // so its left = right - width.
        bubbleLeftX = parentRect.right - rightOffset - rect.width
      } else {
        bubbleLeftX = rect.left
      }

      const triggerCentreX = parentRect.left + parentRect.width / 2
      const arrowLeft = Math.max(
        8, // don't let arrow escape the bubble's own left edge
        Math.min(rect.width - 18, triggerCentreX - bubbleLeftX - 5),
      )

      setBubbleStyle({
        left: leftOffset !== undefined ? `${leftOffset}px` : undefined,
        right: rightOffset !== undefined ? `${rightOffset}px` : undefined,
        '--tip-arrow-left': `${arrowLeft}px`,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
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
      {open && (
        <span ref={bubbleRef} className="info-tip-bubble" style={bubbleStyle}>
          {children}
        </span>
      )}
    </span>
  )
}
