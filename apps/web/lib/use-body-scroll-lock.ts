'use client'

import { useEffect } from 'react'

/// Lock body scroll while the calling component is mounted. Modals call
/// this once at the top of their body so opening a modal doesn't leave
/// the page scrolling behind it, and closing (unmount) restores whatever
/// overflow the body had before.
///
/// Handles concurrent locks: if two modals stack (rare, but possible),
/// only the first mount touches the body's overflow and only the last
/// unmount restores it. Uses a global counter for that reason — a
/// ref-per-component wouldn't know about siblings.
///
/// Also compensates for the scrollbar disappearing: when overflow is
/// hidden on the body, the vertical scrollbar space vanishes and the
/// page can visually shift right. We measure the scrollbar width once
/// and add matching padding-right so the layout stays put.
let lockCount = 0
let previousOverflow: string | null = null
let previousPaddingRight: string | null = null

export function useBodyScrollLock(active: boolean = true): void {
  useEffect(() => {
    if (!active) return
    if (typeof document === 'undefined') return

    if (lockCount === 0) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
      previousOverflow = document.body.style.overflow || ''
      previousPaddingRight = document.body.style.paddingRight || ''
      document.body.style.overflow = 'hidden'
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`
      }
    }
    lockCount++

    return () => {
      lockCount--
      if (lockCount === 0) {
        document.body.style.overflow = previousOverflow ?? ''
        document.body.style.paddingRight = previousPaddingRight ?? ''
        previousOverflow = null
        previousPaddingRight = null
      }
    }
  }, [active])
}
