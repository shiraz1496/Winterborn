'use client'

import { useEffect, useMemo, useState } from 'react'
import type { AdminUserDto, CurrentUserDto, LocationDto } from '@winterborn/shared'
import { PageHeader } from '../../../components/PageHeader'
import { RequireAuth } from '../../../components/RequireAuth'
import { SearchableSelect } from '../../../components/SearchableSelect'
import {
  ApiError,
  createAdminUser,
  listAdminUsers,
  listLocations,
  updateAdminUser,
} from '../../../lib/api'
import { useToast } from '../../../lib/toast'

type Role = CurrentUserDto['role']

const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Owner',
  WAREHOUSE_MANAGER: 'Warehouse manager',
  WAREHOUSE_OPERATOR: 'Warehouse operator',
  MARKET_MANAGER: 'Market manager',
  SALES: 'Sales',
}

const ROLE_DESC: Record<Role, string> = {
  OWNER: 'Full access. Can add users, edit catalog, override every setting.',
  WAREHOUSE_MANAGER: 'Receive, pack, approve requests, edit catalog and colour families.',
  WAREHOUSE_OPERATOR: 'Receive and pack. Cannot edit catalog or approve.',
  MARKET_MANAGER: 'Sees one market only. Submits restock requests.',
  SALES: 'Square till only. No access to this app.',
}

function generatePassword(): string {
  // Two short words + digits — memorable enough for the owner to speak
  // once, still long enough to satisfy the >=8-char rule server-side.
  const words = ['pine', 'winter', 'atlas', 'harbor', 'meadow', 'timber', 'ridge', 'blaze', 'ember', 'north']
  const w = words[Math.floor(Math.random() * words.length)]
  const digits = String(Math.floor(1000 + Math.random() * 9000))
  return `${w}-${digits}`
}

function UsersBody() {
  const toast = useToast()
  const [users, setUsers] = useState<AdminUserDto[]>([])
  const [locations, setLocations] = useState<LocationDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminUserDto | null>(null)
  const [creating, setCreating] = useState(false)
  const [flashPassword, setFlashPassword] = useState<{ email: string; password: string } | null>(null)

  async function load() {
    try {
      const [u, l] = await Promise.all([listAdminUsers(), listLocations()])
      setUsers(u)
      setLocations(l)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const markets = useMemo(() => locations.filter((l) => l.kind === 'MARKET'), [locations])
  const locationName = useMemo(() => {
    const map = new Map(locations.map((l) => [l.id, l.name]))
    return (id: string | null) => (id ? map.get(id) ?? id : null)
  }, [locations])

  const grouped = useMemo(() => {
    const active = users.filter((u) => u.isActive)
    const inactive = users.filter((u) => !u.isActive)
    return { active, inactive }
  }, [users])

  return (
    <div>
      <PageHeader
        eyebrow="Owner only"
        title="Users"
        description="Everyone with access to Winterborn. Create accounts, assign roles, reset passwords, deactivate. Sales-role accounts exist here but only get to the Square till, not this app."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)} style={{ minHeight: 40, padding: '8px 14px', fontSize: '0.85rem', width: 'auto' }}>
            + New user
          </button>
        }
      />

      {error && <p className="error-banner">{error}</p>}

      {flashPassword && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--signal)', background: 'rgba(210,137,42,0.08)' }}>
          <div className="row-between" style={{ marginBottom: 6 }}>
            <strong>Share this password once — it won&apos;t be shown again</strong>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ minHeight: 32, padding: '4px 10px', fontSize: '0.8rem' }}
              onClick={() => setFlashPassword(null)}
            >
              Dismiss
            </button>
          </div>
          <div className="kv-grid">
            <div className="kv-key">Email</div>
            <div className="kv-val mono">{flashPassword.email}</div>
            <div className="kv-key">Password</div>
            <div className="kv-val mono" style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--signal)' }}>
              {flashPassword.password}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="screen-loading">
          <div className="spinner" aria-hidden="true" />
        </div>
      ) : (
        <>
          <div className="section-heading">
            <h2>Active</h2>
            <span className="eyebrow">{grouped.active.length}</span>
          </div>
          <UserGrid users={grouped.active} locationName={locationName} onEdit={setEditing} />

          {grouped.inactive.length > 0 && (
            <>
              <div className="section-heading">
                <h2>Deactivated</h2>
                <span className="eyebrow">{grouped.inactive.length}</span>
              </div>
              <p className="section-desc">These accounts cannot log in. Reactivate to restore access.</p>
              <UserGrid users={grouped.inactive} locationName={locationName} onEdit={setEditing} />
            </>
          )}
        </>
      )}

      {creating && (
        <UserModal
          title="Create user"
          markets={markets}
          onClose={() => setCreating(false)}
          onSave={async (form) => {
            try {
              const result = await createAdminUser({
                email: form.email.trim(),
                name: form.name.trim(),
                role: form.role,
                password: form.password || undefined,
                locationId: form.locationId || null,
              })
              toast.success(`User created: ${result.email}`)
              if (result.password) {
                setFlashPassword({ email: result.email, password: result.password })
              }
              await load()
              setCreating(false)
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Could not create user.'
              toast.error(msg)
              throw err
            }
          }}
        />
      )}

      {editing && (
        <UserModal
          title="Edit user"
          user={editing}
          markets={markets}
          onClose={() => setEditing(null)}
          onSave={async (form) => {
            try {
              const patch: Parameters<typeof updateAdminUser>[1] = {}
              if (form.name.trim() !== editing.name) patch.name = form.name.trim()
              if (form.role !== editing.role) patch.role = form.role
              if ((form.locationId || null) !== editing.locationId) patch.locationId = form.locationId || null
              if (form.password) patch.password = form.password
              if (form.isActive !== editing.isActive) patch.isActive = form.isActive
              if (Object.keys(patch).length === 0) {
                setEditing(null)
                return
              }
              const result = await updateAdminUser(editing.id, patch)
              toast.success(`Updated ${result.email}`)
              if (result.password) {
                setFlashPassword({ email: result.email, password: result.password })
              }
              await load()
              setEditing(null)
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Could not update user.'
              toast.error(msg)
              throw err
            }
          }}
        />
      )}
    </div>
  )
}

const ROLE_ACCENT: Record<Role, string> = {
  OWNER: 'var(--signal)',
  WAREHOUSE_MANAGER: 'var(--pine)',
  WAREHOUSE_OPERATOR: 'var(--pine)',
  MARKET_MANAGER: '#7ea3d0',
  SALES: 'var(--text-faint)',
}

function UserGrid({
  users,
  locationName,
  onEdit,
}: {
  users: AdminUserDto[]
  locationName: (id: string | null) => string | null
  onEdit: (u: AdminUserDto) => void
}) {
  if (users.length === 0) {
    return (
      <div className="card">
        <p style={{ margin: 0, color: 'var(--text-dim)' }}>Nobody here.</p>
      </div>
    )
  }

  return (
    <div className="user-grid">
      {users.map((u) => {
        const market = locationName(u.locationId)
        return (
          <button
            key={u.id}
            type="button"
            className={`user-card${u.isActive ? '' : ' user-card-disabled'}`}
            onClick={() => onEdit(u)}
            style={{ borderLeft: `3px solid ${u.isActive ? ROLE_ACCENT[u.role] : 'var(--rust)'}` }}
          >
            <div className="user-card-role">{u.isActive ? ROLE_LABEL[u.role] : 'Disabled'}</div>
            <div className="user-card-name">{u.name}</div>
            <div className="user-card-email mono">{u.email}</div>
            <div className="user-card-meta">
              {u.isActive ? ROLE_DESC[u.role] : `Was ${ROLE_LABEL[u.role].toLowerCase()}. Cannot sign in.`}
            </div>
            {(market || !u.hasPassword) && (
              <div className="user-card-foot">
                {market && (
                  <span className="chip" title="Scoped to one market">
                    {market}
                  </span>
                )}
                {!u.hasPassword && (
                  <span className="chip chip-signal" title="No password set — user cannot log in until one is set">
                    no password
                  </span>
                )}
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}

interface FormState {
  email: string
  name: string
  role: Role
  password: string
  locationId: string
  isActive: boolean
}

function UserModal({
  title,
  user,
  markets,
  onClose,
  onSave,
}: {
  title: string
  user?: AdminUserDto
  markets: LocationDto[]
  onClose: () => void
  onSave: (form: FormState) => Promise<void>
}) {
  const [form, setForm] = useState<FormState>({
    email: user?.email ?? '',
    name: user?.name ?? '',
    role: user?.role ?? 'WAREHOUSE_OPERATOR',
    password: '',
    locationId: user?.locationId ?? '',
    isActive: user?.isActive ?? true,
  })
  const [busy, setBusy] = useState(false)

  const needsMarket = form.role === 'MARKET_MANAGER'
  const isEditing = !!user

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await onSave(form)
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              disabled={isEditing}
              autoComplete="off"
            />
            {isEditing && <span className="eyebrow">Email cannot be changed after creation.</span>}
          </div>

          <div className="field">
            <label>Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoComplete="off"
            />
          </div>

          <div className="field">
            <label>Role</label>
            <SearchableSelect
              value={form.role}
              options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ id: r, label: ROLE_LABEL[r] }))}
              onChange={(id) => id && setForm({ ...form, role: id as Role })}
              showId={false}
              allowClear={false}
            />
            <span className="eyebrow" style={{ color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0, fontSize: '0.8rem' }}>
              {ROLE_DESC[form.role]}
            </span>
          </div>

          {needsMarket && (
            <div className="field">
              <label>Market</label>
              <SearchableSelect
                value={form.locationId || null}
                options={markets.map((m) => ({ id: m.id, label: m.name }))}
                placeholder="(none — user will see nothing)"
                onChange={(id) => setForm({ ...form, locationId: id ?? '' })}
                showId={false}
              />
            </div>
          )}

          <div className="field">
            <label>{isEditing ? 'Set new password (leave blank to keep)' : 'Password'}</label>
            <div className="row" style={{ gap: 8 }}>
              <input
                type="text"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={isEditing ? '(unchanged)' : 'min 8 characters'}
                autoComplete="new-password"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                style={{ minHeight: 40 }}
                onClick={() => setForm({ ...form, password: generatePassword() })}
              >
                Generate
              </button>
            </div>
            <span className="eyebrow" style={{ color: 'var(--text-dim)', textTransform: 'none', letterSpacing: 0, fontSize: '0.8rem' }}>
              Shown once after saving, so you can pass it to the user. Never stored in plaintext.
            </span>
          </div>

          {isEditing && (
            <div className="field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  style={{ width: 18, height: 18 }}
                />
                Active — user can sign in
              </label>
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" style={{ width: 'auto', minHeight: 44 }} disabled={busy}>
              {busy ? 'Saving…' : isEditing ? 'Save changes' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function AdminUsersPage() {
  return (
    <RequireAuth roles={['OWNER']}>
      <UsersBody />
    </RequireAuth>
  )
}
