'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

/// Compact date-range picker used by the audit trail (and any other
/// "show me events between X and Y" screen). Emits ISO strings so callers
/// can pass them to backend queries directly.
///
/// Design:
///   - Trigger button reads "Sep 1 → Sep 15" / "Any date". Click to open.
///   - Popover has a preset column (Today / 7d / 30d / This month / Clear)
///     and a single month calendar with range-selection semantics: click
///     one day, then click another; earlier one is `from`, later is `to`.
///   - Chevrons on the calendar header step months.
///   - Click outside or press Esc to close.
///
/// Deliberately self-contained — no third-party date library. `date-fns`
/// would add a dependency and this component only needs one month grid,
/// start/end-of-day boundaries, and a handful of preset shortcuts.

export interface DateRangePickerProps {
  from: string | null
  to: string | null
  onChange: (from: string | null, to: string | null) => void
  placeholder?: string
}

const WEEKDAY_HEADERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

function endOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(23, 59, 59, 999)
  return out
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function formatShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatWithYear(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/// Six-row calendar grid keyed by day-in-month. Days from adjacent months
/// fill the leading/trailing slots so the grid always has 42 cells; caller
/// dims them with `inMonth = false`.
function monthGrid(year: number, month: number): Array<{ date: Date; inMonth: boolean }> {
  const firstOfMonth = new Date(year, month, 1)
  const startWeekday = firstOfMonth.getDay()
  const gridStart = new Date(year, month, 1 - startWeekday)
  const cells: Array<{ date: Date; inMonth: boolean }> = []
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart)
    date.setDate(gridStart.getDate() + i)
    cells.push({ date, inMonth: date.getMonth() === month })
  }
  return cells
}

export function DateRangePicker({ from, to, onChange, placeholder = 'Any date' }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const parsedFrom = from ? new Date(from) : null
  const parsedTo = to ? new Date(to) : null

  // Cursor month — what's on-screen. Defaults to the from-date's month, or
  // today. Left alone once opened so the user can page through months
  // without the picker resetting on every reselect.
  const [cursor, setCursor] = useState(() => {
    const anchor = parsedFrom ?? new Date()
    return new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  })

  // Intermediate state: user's first click sets `pendingFrom`; the second
  // click resolves the range. Escape or click-away commits nothing.
  const [pendingFrom, setPendingFrom] = useState<Date | null>(null)
  const [hover, setHover] = useState<Date | null>(null)

  useEffect(() => {
    if (!open) {
      setPendingFrom(null)
      setHover(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onClickAway(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickAway)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const grid = useMemo(() => monthGrid(cursor.getFullYear(), cursor.getMonth()), [cursor])

  function pickDay(d: Date) {
    if (!pendingFrom) {
      setPendingFrom(startOfDay(d))
      setHover(null)
      return
    }
    const start = pendingFrom
    const end = endOfDay(d)
    const [lo, hi] = start.getTime() <= end.getTime() ? [start, end] : [endOfDay(d), endOfDay(startOfDay(pendingFrom))]
    // Note the second branch flips: if the user picks an earlier end,
    // swap so `from` is always ≤ `to`.
    if (start.getTime() <= end.getTime()) {
      onChange(lo.toISOString(), hi.toISOString())
    } else {
      onChange(startOfDay(d).toISOString(), endOfDay(start).toISOString())
    }
    setOpen(false)
  }

  function applyPreset(preset: 'today' | '7d' | '30d' | 'month' | 'clear') {
    if (preset === 'clear') {
      onChange(null, null)
      setOpen(false)
      return
    }
    const now = new Date()
    let fromDate: Date
    let toDate: Date
    if (preset === 'today') {
      fromDate = startOfDay(now)
      toDate = endOfDay(now)
    } else if (preset === '7d') {
      fromDate = startOfDay(new Date(now.getTime() - 6 * 86400_000))
      toDate = endOfDay(now)
    } else if (preset === '30d') {
      fromDate = startOfDay(new Date(now.getTime() - 29 * 86400_000))
      toDate = endOfDay(now)
    } else {
      fromDate = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1))
      toDate = endOfDay(now)
    }
    onChange(fromDate.toISOString(), toDate.toISOString())
    setOpen(false)
  }

  function stepMonth(delta: number) {
    setCursor((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }

  const triggerLabel = useMemo(() => {
    if (!parsedFrom && !parsedTo) return placeholder
    if (parsedFrom && parsedTo) {
      const sameYear = parsedFrom.getFullYear() === parsedTo.getFullYear()
      const sameYearAsNow = parsedFrom.getFullYear() === new Date().getFullYear()
      if (sameYear && sameYearAsNow) return `${formatShort(parsedFrom)} → ${formatShort(parsedTo)}`
      return `${formatWithYear(parsedFrom)} → ${formatWithYear(parsedTo)}`
    }
    if (parsedFrom) return `From ${formatWithYear(parsedFrom)}`
    if (parsedTo) return `Until ${formatWithYear(parsedTo)}`
    return placeholder
  }, [parsedFrom, parsedTo, placeholder])

  // Range highlighting: pendingFrom takes priority so a live drag preview
  // is visible; otherwise fall back to the committed from/to pair.
  const rangeStart = pendingFrom ?? parsedFrom
  const rangeEnd = pendingFrom && hover ? hover : parsedTo

  function isInRange(d: Date): boolean {
    if (!rangeStart || !rangeEnd) return false
    const t = d.getTime()
    const lo = Math.min(rangeStart.getTime(), rangeEnd.getTime())
    const hi = Math.max(rangeStart.getTime(), rangeEnd.getTime())
    return t >= lo && t <= hi
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="mono"
        style={{
          all: 'unset',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '10px 12px',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface)',
          cursor: 'pointer',
          fontSize: '0.9rem',
          boxSizing: 'border-box',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v4M16 3v4" strokeLinecap="round" />
        </svg>
        <span style={{ flex: 1, textAlign: 'left', color: parsedFrom || parsedTo ? 'var(--text)' : 'var(--text-faint)' }}>
          {triggerLabel}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ opacity: 0.6 }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 30,
            background: 'var(--surface)',
            border: '1px solid var(--line-strong)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.12)',
            display: 'flex',
            padding: 12,
            gap: 12,
            boxSizing: 'border-box',
          }}
        >
          {/* Preset column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 110 }}>
            {(
              [
                ['today', 'Today'],
                ['7d', 'Last 7 days'],
                ['30d', 'Last 30 days'],
                ['month', 'This month'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                style={presetButtonStyle}
              >
                {label}
              </button>
            ))}
            <div style={{ borderTop: '1px solid var(--line)', margin: '6px 0' }} />
            <button
              type="button"
              onClick={() => applyPreset('clear')}
              style={{ ...presetButtonStyle, color: 'var(--text-dim)' }}
            >
              Clear range
            </button>
          </div>

          {/* Calendar column */}
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <button type="button" onClick={() => stepMonth(-1)} style={navButtonStyle} aria-label="Previous month">
                ‹
              </button>
              <strong style={{ fontSize: '0.9rem' }}>
                {cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </strong>
              <button type="button" onClick={() => stepMonth(1)} style={navButtonStyle} aria-label="Next month">
                ›
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, 1fr)',
                gap: 2,
                fontSize: '0.7rem',
                color: 'var(--text-dim)',
                textAlign: 'center',
                marginBottom: 4,
              }}
            >
              {WEEKDAY_HEADERS.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
              {grid.map(({ date, inMonth }, idx) => {
                const isStart = rangeStart && sameDay(date, rangeStart)
                const isEnd = rangeEnd && sameDay(date, rangeEnd)
                const isEndpoint = isStart || isEnd
                const inRange = isInRange(date)
                const isToday = sameDay(date, new Date())
                return (
                  <button
                    key={idx}
                    type="button"
                    onMouseEnter={() => pendingFrom && setHover(date)}
                    onClick={() => pickDay(date)}
                    style={{
                      all: 'unset',
                      textAlign: 'center',
                      padding: '6px 0',
                      cursor: 'pointer',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.82rem',
                      color: !inMonth
                        ? 'var(--text-faint)'
                        : isEndpoint
                          ? '#fff'
                          : 'var(--text)',
                      // Endpoints get the theme's active-amber (matches
                      // sidebar's active nav item); in-range days pick up
                      // a light tint of the same hue, borrowed straight
                      // from `.app-sidebar-item.active`.
                      background: isEndpoint
                        ? 'var(--signal, #d2892a)'
                        : inRange
                          ? 'rgba(210, 137, 42, 0.14)'
                          : 'transparent',
                      fontWeight: isEndpoint ? 700 : isToday ? 700 : 400,
                      border:
                        isToday && !isEndpoint
                          ? '1px solid var(--signal, #d2892a)'
                          : '1px solid transparent',
                      boxSizing: 'border-box',
                    }}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>

            <p style={{ margin: '10px 0 0', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
              {pendingFrom ? 'Pick the end date.' : 'Pick a start date, or use a preset on the left.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

const presetButtonStyle = {
  all: 'unset' as const,
  padding: '6px 10px',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.82rem',
  cursor: 'pointer',
  color: 'var(--text)',
}

const navButtonStyle = {
  all: 'unset' as const,
  padding: '4px 10px',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  fontSize: '1.1rem',
  color: 'var(--text-dim)',
}
