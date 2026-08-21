'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '../lib/auth-context'
import { logout } from '../lib/api'
import { BottomNav } from './BottomNav'

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/requests': 'Requests',
  '/pack': 'Pack',
  '/scan': 'Scan',
  '/admin/colours': 'Colours',
}

function titleFor(pathname: string): string {
  if (pathname.startsWith('/requests/')) return 'Request'
  if (pathname.startsWith('/pack/')) return 'Pack'
  for (const [prefix, title] of Object.entries(TITLES)) {
    if (prefix !== '/' && pathname.startsWith(prefix)) return title
  }
  return TITLES[pathname] ?? 'Winterborn'
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, refresh } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  if (pathname === '/login' || !user) {
    return <div className="app-shell">{children}</div>
  }

  async function onLogout() {
    // Best-effort: even if the request fails (offline warehouse wifi),
    // refresh() below re-checks /auth/me and the app still routes to
    // /login on the resulting 401 -- so this never strands someone on a
    // page that thinks it's signed in when the cookie is already gone.
    await logout().catch(() => {})
    await refresh()
    router.replace('/login')
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <span className="app-topbar-title">{titleFor(pathname)}</span>
        <div className="app-topbar-right">
          <span className="app-topbar-user">
            {user.name}
            <br />
            {user.locationId ? 'market' : user.role.replace('_', ' ').toLowerCase()}
          </span>
          <button type="button" className="app-topbar-logout" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="app-main">{children}</main>
      <BottomNav role={user.role} />
    </div>
  )
}
