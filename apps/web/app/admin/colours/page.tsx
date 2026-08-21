'use client'

import { useEffect, useState } from 'react'
import type { ColourFamilyDto, UnassignedColourVariant } from '@winterborn/shared'
import { RequireAuth } from '../../../components/RequireAuth'
import { Swatch } from '../../../components/Swatch'
import { NO_COLOUR_FAMILY_NAME } from '../../../lib/colours'
import { API_ORIGIN, ApiError, assignColourFamily, listColourFamilies, listUnassignedColourVariants } from '../../../lib/api'

function ColourQueueBody() {
  const [queue, setQueue] = useState<UnassignedColourVariant[]>([])
  const [familiesByCategory, setFamiliesByCategory] = useState<Record<string, ColourFamilyDto[]>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    listUnassignedColourVariants()
      .then(async (rows) => {
        setQueue(rows)
        const categoryIds = [...new Set(rows.map((r) => r.categoryId))]
        const results = await Promise.all(categoryIds.map((id) => listColourFamilies(id)))
        const map: Record<string, ColourFamilyDto[]> = {}
        categoryIds.forEach((id, i) => (map[id] = results[i]!))
        setFamiliesByCategory(map)
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the colour queue.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(t)
  }, [toast])

  async function assign(variant: UnassignedColourVariant, family: ColourFamilyDto) {
    setBusyId(variant.id)
    setError(null)
    try {
      await assignColourFamily(variant.id, { colourFamilyId: family.id })
      setQueue((prev) => prev.filter((v) => v.id !== variant.id))
      setToast(`${variant.name} → ${family.name}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  return (
    <div>
      {error && <p className="error-banner">{error}</p>}
      <p className="eyebrow" style={{ marginBottom: 18 }}>
        {queue.length} to review
      </p>

      {queue.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">Queue clear</p>
          <p className="empty-state-body">Every warehouse colour has a family, or a deliberate &ldquo;no colour&rdquo;.</p>
        </div>
      ) : (
        <div className="stack">
          {queue.map((variant) => {
            const families = (familiesByCategory[variant.categoryId] ?? []).filter(
              (f) => f.name !== NO_COLOUR_FAMILY_NAME,
            )
            const noColour = (familiesByCategory[variant.categoryId] ?? []).find(
              (f) => f.name === NO_COLOUR_FAMILY_NAME,
            )
            const busy = busyId === variant.id
            return (
              <div key={variant.id} className="card">
                <div className="row" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
                  {variant.photoUrl ? (
                    <img
                      src={`${API_ORIGIN}/${variant.photoUrl}`}
                      alt={variant.name}
                      style={{
                        width: 84,
                        height: 84,
                        objectFit: 'cover',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--line)',
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 84,
                        height: 84,
                        borderRadius: 'var(--radius-md)',
                        border: '1px dashed var(--line-strong)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-faint)',
                        fontSize: '0.65rem',
                        textAlign: 'center',
                        flexShrink: 0,
                      }}
                    >
                      no photo
                    </div>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="list-row-title">{variant.name}</div>
                    <div className="list-row-meta">{variant.categoryName}</div>
                    {variant.sortlyName && variant.sortlyName !== variant.name && (
                      <div className="list-row-meta">was &ldquo;{variant.sortlyName}&rdquo;</div>
                    )}
                  </div>
                </div>

                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  {families.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => assign(variant, f)}
                      disabled={busy}
                      className="chip"
                      style={{ cursor: 'pointer', gap: 7, padding: '6px 10px' }}
                    >
                      <Swatch familyName={f.name} />
                      {f.name}
                    </button>
                  ))}
                  {noColour && (
                    <button
                      onClick={() => assign(variant, noColour)}
                      disabled={busy}
                      className="chip"
                      style={{ cursor: 'pointer', gap: 7, padding: '6px 10px' }}
                    >
                      <Swatch familyName={null} />
                      No colour
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 84,
            background: 'var(--pine)',
            color: 'var(--pine-ink)',
            padding: '10px 18px',
            borderRadius: 999,
            fontWeight: 700,
            fontSize: '0.85rem',
            zIndex: 50,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}

export default function ColourQueuePage() {
  return (
    <RequireAuth roles={['OWNER', 'WAREHOUSE', 'OPERATOR']}>
      <ColourQueueBody />
    </RequireAuth>
  )
}
