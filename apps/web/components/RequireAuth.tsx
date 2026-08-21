'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { UserRole } from '@winterborn/shared'
import { useAuth } from '../lib/auth-context'

/// Gates a screen behind a signed-in session and, optionally, a role list.
/// The API is the real enforcement (every write is behind JwtGuard +
/// RolesGuard); this only saves someone the trip of tapping into a screen
/// their role can't use and watching every request 403.
export function RequireAuth({
  roles,
  children,
}: {
  roles?: UserRole[]
  children: React.ReactNode
}) {
  const { user } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (user === null) router.replace('/login')
  }, [user, router])

  if (user === undefined) {
    return (
      <div className="screen-loading">
        <div className="spinner" aria-hidden="true" />
      </div>
    )
  }

  if (user === null) return null

  if (roles && !roles.includes(user.role)) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">Not for this role</p>
        <p className="empty-state-body">
          {user.name} ({user.role.replace('_', ' ').toLowerCase()}) doesn&apos;t have access to this screen.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
