'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { NOTIFICATION_KIND_LABEL, type Notification, type NotificationKind } from '@winterborn/shared'
import { PageHeader } from '../../components/PageHeader'
import { RequireAuth } from '../../components/RequireAuth'
import { ApiError, listNotifications } from '../../lib/api'

const KIND_FILTERS: (NotificationKind | 'ALL')[] = [
  'ALL',
  'REQUEST_DRAFTED',
  'REQUEST_ADVANCED',
  'INTAKE_RECORDED',
  'DISPATCH_RECORDED',
]

function chipClassFor(kind: NotificationKind): string {
  if (kind === 'REQUEST_DRAFTED') return 'chip chip-signal'
  if (kind === 'REQUEST_ADVANCED') return 'chip chip-pine'
  if (kind === 'DISPATCH_RECORDED') return 'chip chip-pine'
  return 'chip'
}

function timeAgo(at: Date): string {
  const diffMs = Date.now() - at.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function NotificationsBody() {
  const [items, setItems] = useState<Notification[]>([])
  const [truncated, setTruncated] = useState(false)
  const [filter, setFilter] = useState<(typeof KIND_FILTERS)[number]>('ALL')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listNotifications()
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setTruncated(res.truncated)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load notifications.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(
    () => (filter === 'ALL' ? items : items.filter((n) => n.kind === filter)),
    [items, filter],
  )

  const eyebrow = truncated ? `showing latest ${items.length}` : `${items.length} total`

  return (
    <div>
      <PageHeader
        eyebrow={eyebrow}
        title="Notifications"
        description="Every threshold breach, request state change, intake and dispatch — newest first. Tap any row to jump to what it references."
      />

      {error && <p className="error-banner">{error}</p>}

      <div className="row" style={{ overflowX: 'auto', paddingBottom: 4, marginBottom: 16 }}>
        {KIND_FILTERS.map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className="chip"
            style={{
              cursor: 'pointer',
              background: filter === k ? 'var(--signal)' : 'transparent',
              color: filter === k ? 'var(--signal-ink)' : 'var(--text-dim)',
              borderColor: filter === k ? 'var(--signal)' : 'var(--line-strong)',
              flexShrink: 0,
            }}
          >
            {k === 'ALL' ? 'all' : NOTIFICATION_KIND_LABEL[k].toLowerCase()}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Nothing here yet</p>
          <p className="empty-state-body">
            {filter === 'ALL'
              ? 'No activity to report. Notifications appear as soon as thresholds trip, requests move, or stock lands.'
              : `No ${NOTIFICATION_KIND_LABEL[filter as NotificationKind].toLowerCase()} activity yet.`}
          </p>
        </div>
      ) : (
        <div className="list">
          {filtered.map((n) => {
            const inner = (
              <>
                <div className="list-row-body">
                  <div className="list-row-title">{n.title}</div>
                  <div className="list-row-meta">
                    {timeAgo(n.at)}
                    {n.locationName ? ` · ${n.locationName}` : ''} · {n.body}
                  </div>
                </div>
                <span className={chipClassFor(n.kind)}>{NOTIFICATION_KIND_LABEL[n.kind].toLowerCase()}</span>
              </>
            )
            return n.href ? (
              <Link key={n.id} href={n.href} className="list-row" style={{ textDecoration: 'none' }}>
                {inner}
              </Link>
            ) : (
              <div key={n.id} className="list-row">
                {inner}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function NotificationsPage() {
  return (
    <RequireAuth>
      <NotificationsBody />
    </RequireAuth>
  )
}
