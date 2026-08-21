'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { CurrentUserDto } from '@winterborn/shared'
import { ApiError, getMe } from './api'

interface AuthState {
  /// `undefined` while the initial /auth/me check is in flight, `null` once
  /// it has resolved to "not signed in". Distinguishing the two matters:
  /// redirecting to /login before the check finishes would bounce someone
  /// with a perfectly good session.
  user: CurrentUserDto | null | undefined
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUserDto | null | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      setUser(await getMe())
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
      } else {
        // A network hiccup shouldn't be indistinguishable from "not signed
        // in" -- that would bounce someone to /login when the API is just
        // slow to boot. Leave `user` as-is; the caller can retry.
        throw err
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <AuthContext.Provider value={{ user, refresh }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>')
  return ctx
}
