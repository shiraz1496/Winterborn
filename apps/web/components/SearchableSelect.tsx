'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * A styled combobox: trigger button + popover with search input + filtered list.
 *
 * Built for the Square mapping modal where the raw <select> becomes unusable
 * once the option list grows past ~30 items. Each option carries an `id` (shown
 * mono, dim) and a `label` (regular weight) — the user sees both, and search
 * matches either.
 *
 * Keyboard behavior:
 *   - Up / Down navigate the filtered list.
 *   - Enter selects the highlighted row.
 *   - Escape closes without selecting.
 *   - Click outside closes.
 *
 * Positioning is `absolute` under the trigger; the parent container should be
 * `position: relative` (which is the default on our modal's flex column).
 * `maxHeight` on the list caps the popover so long option lists become
 * scrollable rather than pushing the modal past viewport.
 */

export interface SearchableOption {
  id: string
  label: string
  /// Optional visual treatment. 'action' renders the row as a distinct
  /// button-style CTA so options that trigger side effects (e.g. "+ Add axis")
  /// read as actions, not selectable items alongside real values.
  variant?: 'action'
}

interface SearchableSelectProps {
  value: string | null
  options: SearchableOption[]
  placeholder?: string
  emptyMessage?: string
  disabled?: boolean
  onChange: (value: string | null) => void
  size?: 'sm' | 'md'
  /** Optional secondary line beneath the selected value in the trigger. Useful for auto-match hints. */
  hint?: string
  /** Optional visual highlight for the trigger — used for auto-matched rows. */
  highlight?: boolean
  /** Show the option's raw id alongside the label. Off for internal cuid-style ids that carry no operator value. */
  showId?: boolean
}

const CHEVRON = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ opacity: 0.6 }}>
    <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function SearchableSelect({
  value,
  options,
  placeholder = '— pick one —',
  emptyMessage = 'No matches.',
  disabled = false,
  onChange,
  size = 'md',
  hint,
  highlight = false,
  showId = true,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedOption = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.id.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
  }, [options, query])

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      // -1 means "nothing highlighted yet" — the first row only lights up
      // once the user hovers or arrows into it. Auto-selecting index 0 made
      // the popover look like it had a pre-committed choice on every open.
      setHighlightIdx(-1)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    // Keep highlight in bounds when the filter shrinks the list
    if (highlightIdx >= filtered.length) setHighlightIdx(Math.max(0, filtered.length - 1))
  }, [filtered.length, highlightIdx])

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx((i) => Math.min(filtered.length - 1, i + 1))
      scrollHighlightIntoView(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx((i) => Math.max(0, i - 1))
      scrollHighlightIntoView(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[highlightIdx]
      if (opt) select(opt.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  function scrollHighlightIntoView(dir: number) {
    // Deferred so the state update paints first
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')
      if (!el) return
      el.scrollIntoView({ block: dir > 0 ? 'nearest' : 'nearest' })
    })
  }

  function select(id: string | null) {
    onChange(id)
    setOpen(false)
  }

  const triggerHeight = size === 'sm' ? 30 : 40
  const triggerPad = size === 'sm' ? '5px 10px' : '8px 12px'

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          all: 'unset',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: triggerHeight,
          padding: triggerPad,
          boxSizing: 'border-box',
          borderRadius: 'var(--radius-sm)',
          border: `1px solid ${open ? 'var(--signal, #b58a2c)' : 'var(--line)'}`,
          background: highlight ? 'var(--surface-warm, #fffbe9)' : 'var(--surface)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          fontSize: size === 'sm' ? '0.78rem' : '0.85rem',
          color: 'var(--text)',
          transition: 'border-color 0.12s',
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {selectedOption ? (
            <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              {showId && (
                <span className="mono" style={{ fontSize: '0.7em', color: 'var(--text-dim)' }}>{selectedOption.id}</span>
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{selectedOption.label}</span>
            </span>
          ) : (
            <span style={{ color: 'var(--text-faint)' }}>{placeholder}</span>
          )}
          {hint && <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>{hint}</span>}
        </div>
        {CHEVRON}
      </button>

      {open && (
        <div
          role="listbox"
          onKeyDown={handleKey}
          style={{
            position: 'absolute',
            top: `calc(100% + 4px)`,
            left: 0,
            right: 0,
            zIndex: 100,
            background: 'var(--surface)',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 10px 24px rgba(0,0,0,0.15)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 320,
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--line)' }}>
            <input
              ref={searchRef}
              type="search"
              placeholder="Type to filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKey}
              style={{
                width: '100%',
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line)',
                fontSize: '0.85rem',
                background: 'var(--surface-sunken)',
              }}
            />
          </div>
          <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(null)}
              style={{
                all: 'unset',
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                padding: '6px 10px',
                borderBottom: '1px solid var(--line-soft)',
                fontSize: '0.78rem',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                background: value === null ? 'var(--surface-sunken)' : 'transparent',
              }}
            >
              — clear selection —
            </button>
            {filtered.length === 0 ? (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>{emptyMessage}</div>
            ) : (
              (() => {
                // Separate normal options from action options so we can render
                // the actions as a distinct button-style block at the bottom
                // instead of visually blending them with selectable values.
                const items = filtered.filter((o) => o.variant !== 'action')
                const actions = filtered.filter((o) => o.variant === 'action')
                let idx = 0
                return (
                  <>
                    {items.map((o) => {
                      const currentIdx = idx++
                      const isSelected = o.id === value
                      const isHighlighted = currentIdx === highlightIdx
                      return (
                        <button
                          key={o.id}
                          type="button"
                          data-highlighted={isHighlighted ? 'true' : 'false'}
                          onMouseEnter={() => setHighlightIdx(currentIdx)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => select(o.id)}
                          style={{
                            all: 'unset',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            boxSizing: 'border-box',
                            padding: '7px 10px',
                            fontSize: '0.82rem',
                            cursor: 'pointer',
                            background: isHighlighted ? 'var(--surface-sunken)' : 'transparent',
                            borderLeft: isSelected ? '3px solid var(--signal, #b58a2c)' : '3px solid transparent',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                            {showId && (
                              <span className="mono" style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>{o.id}</span>
                            )}
                          </div>
                          {isSelected && <span style={{ color: 'var(--signal, #b58a2c)', fontSize: '0.9rem' }}>✓</span>}
                        </button>
                      )
                    })}
                    {actions.length > 0 && (
                      <div style={{ padding: '8px', borderTop: items.length > 0 ? '1px solid var(--line)' : 'none', background: 'var(--surface-sunken)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {actions.map((o) => {
                          const currentIdx = idx++
                          const isHighlighted = currentIdx === highlightIdx
                          return (
                            <button
                              key={o.id}
                              type="button"
                              data-highlighted={isHighlighted ? 'true' : 'false'}
                              onMouseEnter={() => setHighlightIdx(currentIdx)}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => select(o.id)}
                              style={{
                                all: 'unset',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 6,
                                width: '100%',
                                boxSizing: 'border-box',
                                padding: '7px 10px',
                                fontSize: '0.8rem',
                                fontWeight: 600,
                                letterSpacing: '0.02em',
                                cursor: 'pointer',
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid var(--signal, #b58a2c)',
                                color: 'var(--signal, #b58a2c)',
                                background: isHighlighted ? 'var(--signal, #b58a2c)' : 'transparent',
                                transition: 'background 0.12s, color 0.12s',
                                ...(isHighlighted ? { color: 'var(--surface)' } : {}),
                              }}
                            >
                              {o.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </>
                )
              })()
            )}
          </div>
        </div>
      )}
    </div>
  )
}
