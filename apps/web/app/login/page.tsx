'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError, login } from '../../lib/api'
import { useAuth } from '../../lib/auth-context'

export default function LoginPage() {
  const router = useRouter()
  const { user, refresh } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (user) router.replace('/')
  }, [user, router])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await login(email.trim(), password)
      await refresh()
      router.replace('/')
    } catch (err) {
      // The API's 401 message is deliberately generic ("invalid email or
      // password") -- it never reveals whether the address is known, so
      // this can surface it verbatim.
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-mark" aria-hidden="true">
        <svg viewBox="0 0 512 512" width="56" height="56">
          <g stroke="#e8a33d" strokeWidth="30" strokeLinecap="round" fill="none">
            <line x1="256" y1="120" x2="256" y2="392" />
            <line x1="140" y1="163" x2="372" y2="349" />
            <line x1="372" y1="163" x2="140" y2="349" />
          </g>
          <circle cx="256" cy="256" r="22" fill="#5c8a76" />
        </svg>
      </div>
      <h1 className="login-title">Winterborn Restock</h1>
      <p className="login-sub">Sign in with your work email and password.</p>

      {error && <p className="error-banner">{error}</p>}

      <form onSubmit={onSubmit} className="stack">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="off"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@winterborn.example"
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || email.trim().length === 0 || password.length === 0}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
