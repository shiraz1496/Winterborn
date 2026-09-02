'use client'

import { useState, type InputHTMLAttributes } from 'react'

/**
 * `<input type="password">` with a show/hide toggle on the right. Starts
 * hidden. All standard input props pass through so the caller controls
 * `value`, `onChange`, `autoComplete`, `required`, `id`, etc. — the
 * component only owns the visibility state and the toggle button.
 *
 * Rendered as a small flex container so the input keeps its normal
 * width; the eye icon sits inside on the right so the field looks like
 * a single control instead of an input + button pair.
 */

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

export function PasswordInput(props: Props) {
  const [visible, setVisible] = useState(false)
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        style={{
          flex: 1,
          width: '100%',
          paddingRight: 42,
          ...(props.style ?? {}),
        }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {visible ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.79 19.79 0 0 1 4.06-5.94" />
            <path d="M9.9 5.24A10.05 10.05 0 0 1 12 5c7 0 11 8 11 8a19.86 19.86 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  )
}
