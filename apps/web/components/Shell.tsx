'use client'

import { usePathname } from 'next/navigation'
import { useAuth } from '../lib/auth-context'
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
  const { user } = useAuth()
  const pathname = usePathname()

  if (pathname === '/login' || !user) {
    return <div className="app-shell">{children}</div>
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <span className="app-topbar-title">{titleFor(pathname)}</span>
        <span className="app-topbar-user">
          {user.name}
          <br />
          {user.locationId ? 'market' : user.role.replace('_', ' ').toLowerCase()}
        </span>
      </header>
      <main className="app-main">{children}</main>
      <BottomNav role={user.role} />
    </div>
  )
}
