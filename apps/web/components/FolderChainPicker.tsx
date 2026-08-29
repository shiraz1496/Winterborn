'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CatalogFolderRow, CategoryTreeNode } from '@winterborn/shared'
import { ApiError, browseFolder, createCategory } from '../lib/api'
import { SearchableSelect } from './SearchableSelect'

/// Cascading folder picker for the product-creation modal. Emits an
/// ordered chain of Category IDs [rootChild, subFolder, sub-sub, ...],
/// terminating at whichever leaf the operator picks. The final element
/// is the folder the ItemGroup will be created under.
///
/// Each level is a SearchableSelect fetched lazily via /catalog/browse.
/// A "+ Create new folder" action at the bottom of every dropdown opens
/// an inline "type a name" input; submit POSTs a new Category and
/// auto-selects it. A "+ Subfolder" button appears after the deepest
/// picked folder so the operator can extend the chain arbitrarily deep
/// (matching the Sortly export's up-to-4-levels shape without hard-coding
/// a limit).

interface LevelState {
  parentId: string | null
  parentName: string | null
  options: CatalogFolderRow[]
  loading: boolean
  error: string | null
  pickedId: string | null
  /// When set, this level is showing the "type a name" inline card
  /// instead of the dropdown. Named lifecycle so canceling doesn't lose
  /// the operator's typed input on accident.
  creating: { name: string; busy: boolean } | null
}

const CREATE_NEW_ID = '__create-new__'

export function FolderChainPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (chain: string[]) => void
}) {
  const [levels, setLevels] = useState<LevelState[]>([])
  const [rootId, setRootId] = useState<string | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)

  /// Fetch the direct children of `parentId` (or of the tree root when
  /// parentId is null). Returns just the subfolders — item groups aren't
  /// pickable as folders in this UI.
  const fetchChildren = useCallback(
    async (parentId: string | null): Promise<{ options: CatalogFolderRow[]; effectiveParentId: string | null; effectiveParentName: string | null }> => {
      const res = await browseFolder(parentId ?? undefined)
      return {
        options: res.subfolders,
        effectiveParentId: res.folder?.id ?? parentId,
        effectiveParentName: res.folder?.name ?? null,
      }
    },
    [],
  )

  /// Initial mount: load level 0 (root's children). browseFolder() with
  /// no argument auto-unwraps the single root, so `folder` in the response
  /// is the actual root Category ID we'll use as parent when creating a
  /// top-level folder.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { options, effectiveParentId, effectiveParentName } = await fetchChildren(null)
        if (cancelled) return
        setRootId(effectiveParentId)
        setLevels([
          {
            parentId: effectiveParentId,
            parentName: effectiveParentName,
            options,
            loading: false,
            error: null,
            pickedId: null,
            creating: null,
          },
        ])
      } catch (err) {
        if (cancelled) return
        setRootError(err instanceof ApiError ? err.message : 'Could not load folders.')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /// Emit the chain up to the deepest picked level whenever the picks
  /// change. Chain length matches how deep the operator has drilled in.
  useEffect(() => {
    const chain = levels
      .map((l) => l.pickedId)
      .filter((id): id is string => id !== null)
    // Cheap identity check to avoid firing onChange on every render.
    if (chain.length !== value.length || chain.some((id, i) => id !== value[i])) {
      onChange(chain)
    }
  }, [levels, value, onChange])

  async function pick(levelIdx: number, folderId: string) {
    setLevels((prev) => {
      const next = prev.slice(0, levelIdx + 1)
      const current = next[levelIdx]
      if (!current) return prev
      next[levelIdx] = { ...current, pickedId: folderId, creating: null }
      return next
    })
    // Warm up the next level's options — but ONLY expand into a fresh
    // dropdown when the picked folder actually has children. A leaf
    // folder (no subfolders yet) shouldn't auto-open a placeholder
    // dropdown that the operator now has to click through; instead we
    // surface a "+ Subfolder" button at the tail of the chain so the
    // operator can extend it deliberately.
    try {
      const { options, effectiveParentId, effectiveParentName } = await fetchChildren(folderId)
      if (options.length === 0) return
      setLevels((prev) => {
        const trimmed = prev.slice(0, levelIdx + 1)
        return [
          ...trimmed,
          {
            parentId: effectiveParentId,
            parentName: effectiveParentName,
            options,
            loading: false,
            error: null,
            pickedId: null,
            creating: null,
          },
        ]
      })
    } catch (err) {
      setLevels((prev) => {
        const next = [...prev]
        if (next[levelIdx]) next[levelIdx] = { ...next[levelIdx], error: err instanceof ApiError ? err.message : 'Could not load subfolders.' }
        return next
      })
    }
  }

  /// User explicitly clicked "+ Subfolder" at the tail — extend the
  /// chain by one level even though the leaf has no existing children.
  /// The new level starts as an empty dropdown; the operator's only
  /// meaningful action is "+ Create new folder" inside it.
  async function extendChain() {
    const last = levels[levels.length - 1]
    if (!last || !last.pickedId) return
    try {
      const { options, effectiveParentId, effectiveParentName } = await fetchChildren(last.pickedId)
      setLevels((prev) => [
        ...prev,
        {
          parentId: effectiveParentId,
          parentName: effectiveParentName,
          options,
          loading: false,
          error: null,
          pickedId: null,
          creating: null,
        },
      ])
    } catch (err) {
      setLevels((prev) => {
        const next = [...prev]
        const lastIdx = next.length - 1
        if (next[lastIdx]) next[lastIdx] = { ...next[lastIdx], error: err instanceof ApiError ? err.message : 'Could not extend chain.' }
        return next
      })
    }
  }

  function openCreate(levelIdx: number) {
    setLevels((prev) => {
      const next = [...prev]
      const current = next[levelIdx]
      if (!current) return prev
      next[levelIdx] = { ...current, creating: { name: '', busy: false } }
      return next
    })
  }

  function cancelCreate(levelIdx: number) {
    setLevels((prev) => {
      const next = [...prev]
      const current = next[levelIdx]
      if (!current) return prev
      next[levelIdx] = { ...current, creating: null }
      return next
    })
  }

  function setCreateName(levelIdx: number, name: string) {
    setLevels((prev) => {
      const next = [...prev]
      const current = next[levelIdx]
      if (!current || !current.creating) return prev
      next[levelIdx] = { ...current, creating: { ...current.creating, name } }
      return next
    })
  }

  async function submitCreate(levelIdx: number) {
    const level = levels[levelIdx]
    if (!level || !level.creating) return
    const name = level.creating.name.trim()
    if (!name) return
    setLevels((prev) => {
      const next = [...prev]
      const current = next[levelIdx]
      if (!current || !current.creating) return prev
      next[levelIdx] = { ...current, creating: { ...current.creating, busy: true } }
      return next
    })
    try {
      const created = await createCategory({ parentId: level.parentId, name })
      // Refresh this level's options and select the new folder.
      const { options, effectiveParentId, effectiveParentName } = await fetchChildren(level.parentId)
      setLevels((prev) => {
        const trimmed = prev.slice(0, levelIdx + 1)
        const currentLevel: LevelState = {
          parentId: effectiveParentId,
          parentName: effectiveParentName,
          options,
          loading: false,
          error: null,
          pickedId: created.id,
          creating: null,
        }
        return [...trimmed.slice(0, levelIdx), currentLevel]
      })
      // Also warm up the freshly-created folder's children (empty — but
      // starts the next level's dropdown so operators can immediately
      // extend the chain).
      const nextChildren = await fetchChildren(created.id)
      setLevels((prev) => {
        return [
          ...prev,
          {
            parentId: nextChildren.effectiveParentId,
            parentName: nextChildren.effectiveParentName,
            options: nextChildren.options,
            loading: false,
            error: null,
            pickedId: null,
            creating: null,
          },
        ]
      })
    } catch (err) {
      setLevels((prev) => {
        const next = [...prev]
        const current = next[levelIdx]
        if (!current) return prev
        next[levelIdx] = {
          ...current,
          creating: current.creating ? { ...current.creating, busy: false } : null,
          error: err instanceof ApiError ? err.message : 'Could not create folder.',
        }
        return next
      })
    }
  }

  if (rootError) {
    return <p className="error-banner">{rootError}</p>
  }
  if (rootId === null) {
    return (
      <div style={{ padding: 8, color: 'var(--text-dim)', fontSize: '0.85rem' }}>
        Loading folders…
      </div>
    )
  }

  const chain: string[] = levels
    .map((l) => l.pickedId)
    .filter((id): id is string => id !== null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {levels.map((level, idx) => {
        const isLast = idx === levels.length - 1
        const label = idx === 0 ? 'Folder' : `Subfolder ${idx}`
        if (level.creating) {
          return (
            <div key={`create-${idx}`} style={createCardStyle}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-dim)', marginBottom: 6 }}>
                New {label.toLowerCase()}
                {level.parentName ? ` in ${level.parentName}` : ' at the root'}
              </div>
              <input
                autoFocus
                type="text"
                placeholder="Folder name"
                value={level.creating.name}
                onChange={(e) => setCreateName(idx, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && level.creating?.name.trim() && !level.creating.busy) {
                    void submitCreate(idx)
                  } else if (e.key === 'Escape') {
                    cancelCreate(idx)
                  }
                }}
                style={inputStyle}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button type="button" className="btn btn-ghost" onClick={() => cancelCreate(idx)} disabled={level.creating.busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={level.creating.busy || !level.creating.name.trim()}
                  onClick={() => void submitCreate(idx)}
                >
                  {level.creating.busy ? 'Creating…' : 'Add folder'}
                </button>
              </div>
            </div>
          )
        }
        return (
          <div key={`level-${idx}`}>
            <label style={labelStyle}>{label}</label>
            <SearchableSelect
              value={level.pickedId}
              showId={false}
              options={[
                ...level.options.map((f) => ({ id: f.id, label: f.name })),
                { id: CREATE_NEW_ID, label: '+ Create new folder', variant: 'action' as const },
              ]}
              placeholder={level.options.length === 0 ? 'No folders yet — create one' : `Pick a ${label.toLowerCase()}…`}
              onChange={(id) => {
                if (id === null) return
                if (id === CREATE_NEW_ID) openCreate(idx)
                else void pick(idx, id)
              }}
              emptyMessage="No folders match."
            />
            {level.error && <p style={{ color: 'var(--danger, #b3261e)', fontSize: '0.78rem', marginTop: 4 }}>{level.error}</p>}
          </div>
        )
      })}

      {/* "+ Subfolder" button appears only when the tail level has a pick
          AND no deeper level auto-opened (leaf with no children). Click
          reveals the deeper dropdown so the operator can create the
          first subfolder there. */}
      {chain.length === levels.length && chain.length > 0 && !levels[levels.length - 1]?.creating && (
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => void extendChain()}
            style={{ minHeight: 32, padding: '4px 12px', fontSize: '0.82rem' }}
          >
            + Subfolder
          </button>
        </div>
      )}

      {chain.length > 0 && !levels[levels.length - 1]?.creating && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          Chain: {levels.filter((l) => l.pickedId).map((l) => l.options.find((o) => o.id === l.pickedId)?.name).join(' / ')}
        </div>
      )}
    </div>
  )
}

const createCardStyle = {
  padding: 12,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--line-strong)',
  background: 'var(--surface-sunken)',
} as const

const inputStyle = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--line)',
  fontSize: '0.9rem',
  background: 'var(--surface)',
  boxSizing: 'border-box' as const,
}

const labelStyle = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 700,
  marginBottom: 4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  color: 'var(--text-dim)',
}
