'use client'

import { usePathname } from 'next/navigation'
import { useAuth } from '../lib/auth-context'
import { logout } from '../lib/api'
import { BottomNav } from './BottomNav'
import { SideNav } from './SideNav'

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/requests': 'Requests',
  '/intake': 'Receive inventory',
  '/pack': 'Pack',
  '/notifications': 'Notifications',
  '/admin/colours': 'Colours',
  '/admin/catalog': 'Catalog',
  '/admin/users': 'Users',
  '/scan': 'Scan',
}

function titleFor(pathname: string): string {
  if (pathname.startsWith('/requests/')) return 'Request'
  if (pathname.startsWith('/pack/')) return 'Pack'
  if (pathname.startsWith('/admin/catalog/')) return 'Catalog'
  for (const [prefix, title] of Object.entries(TITLES)) {
    if (prefix !== '/' && pathname.startsWith(prefix)) return title
  }
  return TITLES[pathname] ?? 'Winterborn'
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const pathname = usePathname()

  if (pathname === '/login' || !user) {
    return <div className="app-shell">{children}</div>
  }

  async function onLogout() {
    // Best-effort server-side revoke: even on failure (offline warehouse
    // wifi) we still want the client to end up at /login with fresh state.
    await logout().catch(() => {})
    // Full page load, not router.replace(). A client-side navigation can
    // leave the current tree mounted with a stale user reference, and if
    // refresh() throws (any non-401 network error) the navigation never
    // runs at all. Full load also discards react/react-query caches so no
    // data from the previous session survives.
    window.location.href = '/login'
  }

  return (
    <div className="app-shell">
      <SideNav user={user} onSignOut={onLogout} />
      <header className="app-topbar">
        <span className="app-topbar-brand">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <g stroke="var(--signal)" strokeWidth="2" strokeLinecap="round" fill="none">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="6" y1="7" x2="18" y2="17" />
              <line x1="18" y1="7" x2="6" y2="17" />
            </g>
            <circle cx="12" cy="12" r="1.6" fill="var(--pine)" />
          </svg>
          <span>Winterborn</span>
          <span className="app-topbar-sep">·</span>
          <span className="app-topbar-page">{titleFor(pathname)}</span>
        </span>
        <div className="app-topbar-right">
          <span className="app-topbar-user">
            {user.name}
            <br />
            {user.locationId ? 'market' : user.role.replace(/_/g, ' ').toLowerCase()}
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
