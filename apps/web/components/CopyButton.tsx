'use client'

import { useEffect, useRef, useState } from 'react'

/// Small copy-to-clipboard button. Used next to folder/item-group titles
/// and on catalog tiles so an operator can paste the name (or SKU) into
/// Slack/spreadsheets without hand-selecting text. `onClick` stops event
/// propagation so the button works inside a wrapping `<Link>` tile
/// without triggering navigation.
export function CopyButton({
  text,
  label = 'Copy',
  size = 'md',
}: {
  text: string
  label?: string
  size?: 'sm' | 'md'
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const px = size === 'sm' ? 14 : 16
  const pad = size === 'sm' ? '4px' : '6px'

  async function copy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard permission denied or unavailable — silently no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: pad,
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--line)',
        background: copied ? 'var(--accent-soft, var(--surface-sunken))' : 'var(--surface, transparent)',
        color: copied ? 'var(--accent, var(--ink))' : 'var(--text-dim)',
        cursor: 'pointer',
        transition: 'background 0.12s, color 0.12s, border-color 0.12s',
        lineHeight: 0,
      }}
    >
      {copied ? (
        <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width={px} height={px} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}
