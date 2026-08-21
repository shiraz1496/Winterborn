'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ApiError, requestMagicLink, verifyMagicLink } from '../../lib/api'
import { useAuth } from '../../lib/auth-context'

function LoginInner() {
  const router = useRouter()
  const params = useSearchParams()
  const { user, refresh } = useAuth()

  const [email, setEmail] = useState('')
  const [devLink, setDevLink] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tokenFromLink = params.get('token')

  useEffect(() => {
    if (user) router.replace('/')
  }, [user, router])

  useEffect(() => {
    if (!tokenFromLink) return
    setBusy(true)
    verifyMagicLink(tokenFromLink)
      .then(async () => {
        await refresh()
        router.replace('/')
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'That link is no good. Request a new one below.')
      })
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenFromLink])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await requestMagicLink(email.trim())
      setSent(true)
      setDevLink(result.devLink ?? null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  async function useDevLink() {
    if (!devLink) return
    const url = new URL(devLink)
    const token = url.searchParams.get('token')
    if (!token) return
    setBusy(true)
    try {
      await verifyMagicLink(token)
      await refresh()
      router.replace('/')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That link is no good.')
    } finally {
      setBusy(false)
    }
  }

  if (tokenFromLink) {
    return (
      <div className="login-screen">
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
        {error && <p className="error-banner">{error}</p>}
      </div>
    )
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
      <p className="login-sub">Sign in with your work email. We&apos;ll send a one-tap link.</p>

      {error && <p className="error-banner">{error}</p>}

      {!sent ? (
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
          <button type="submit" className="btn btn-primary" disabled={busy || email.trim().length === 0}>
            {busy ? 'Sending…' : 'Send magic link'}
          </button>
        </form>
      ) : (
        <div className="stack">
          <div className="card">
            <p style={{ margin: 0 }}>
              If <strong>{email}</strong> has an account, a sign-in link is on its way.
            </p>
          </div>
          {devLink && (
            <div className="card">
              <p className="eyebrow" style={{ marginBottom: 8 }}>
                Dev only — mail transport is console
              </p>
              <p className="mono" style={{ fontSize: '0.78rem', wordBreak: 'break-all', marginBottom: 12 }}>
                {devLink}
              </p>
              <button className="btn btn-primary" onClick={useDevLink} disabled={busy}>
                {busy ? 'Signing in…' : 'Continue with this link'}
              </button>
            </div>
          )}
          <button className="btn btn-ghost" onClick={() => setSent(false)}>
            Use a different email
          </button>
        </div>
      )}
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="screen-loading"><div className="spinner" aria-hidden="true" /></div>}>
      <LoginInner />
    </Suspense>
  )
}
