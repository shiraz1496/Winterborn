'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { CurrentUserDto } from '@winterborn/shared'

const ICONS = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="5" rx="1.5" />
      <rect x="13" y="11" width="8" height="10" rx="1.5" />
      <rect x="3" y="14" width="8" height="7" rx="1.5" />
    </svg>
  ),
  requests: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 3h11l3 3v15H5z" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </svg>
  ),
  intake: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  ),
  pack: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8l9-5 9 5-9 5-9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  ),
  admin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" strokeDasharray="3 2" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="9" cy="9" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" strokeLinecap="round" />
      <circle cx="17" cy="7" r="2.5" />
      <path d="M15 14c2.6.4 4.5 2.2 4.5 5" strokeLinecap="round" />
    </svg>
  ),
  square: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M9 9h6v6H9z" />
    </svg>
  ),
  catalog: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  ),
  scan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M4 16v2a2 2 0 0 0 2 2h2M16 20h2a2 2 0 0 0 2-2v-2" />
      <path d="M8 12h8" />
    </svg>
  ),
  sparkles: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  ),
}

const WAREHOUSE_ROLES: CurrentUserDto['role'][] = ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']
// Every non-SALES role sees Requests + Notifications. SALES is Square-
// terminal focused; they only need read-only Dashboard visibility for
// on-hand context.
const REQUEST_VIEW_ROLES: CurrentUserDto['role'][] = ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER']
const ALL_ROLES: CurrentUserDto['role'][] = ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER', 'SALES']

interface Tab {
  href: string
  label: string
  icon: keyof typeof ICONS
  roles?: CurrentUserDto['role'][]
}

const TABS: Tab[] = [
  { href: '/', label: 'Dashboard', icon: 'dashboard', roles: ALL_ROLES },
  { href: '/requests', label: 'Requests', icon: 'requests', roles: REQUEST_VIEW_ROLES },
  { href: '/requests/suggest', label: 'Suggest', icon: 'sparkles', roles: ['OWNER'] },
  { href: '/intake', label: 'Receive intake', icon: 'intake', roles: WAREHOUSE_ROLES },
  { href: '/pack', label: 'Pack', icon: 'pack', roles: WAREHOUSE_ROLES },
  { href: '/scan', label: 'Scan', icon: 'scan', roles: ['OWNER', 'MARKET_MANAGER'] },
  { href: '/warehouse', label: 'Warehouse', icon: 'pack', roles: ['OWNER', 'WAREHOUSE_MANAGER'] },
  { href: '/admin/catalog', label: 'Catalog', icon: 'catalog', roles: ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER'] },
  // Temporarily hidden from the nav — the underlying routes still work
  // if visited directly, so this is nav-only. Uncomment to restore.
  // { href: '/notifications', label: 'Notifications', icon: 'bell', roles: REQUEST_VIEW_ROLES },
  // { href: '/admin/colours', label: 'Colour queue', icon: 'admin', roles: ['OWNER', 'WAREHOUSE_MANAGER'] },
  // { href: '/admin/square-mapping', label: 'Square mapping', icon: 'square', roles: ['OWNER', 'WAREHOUSE_MANAGER'] },
  // { href: '/admin/square-sync', label: 'Square sync', icon: 'square', roles: ['OWNER', 'WAREHOUSE_MANAGER'] },
  { href: '/admin/locations', label: 'Locations', icon: 'admin', roles: ['OWNER', 'WAREHOUSE_MANAGER'] },
  { href: '/admin/users', label: 'Users', icon: 'users', roles: ['OWNER'] },
  { href: '/admin/audit', label: 'Audits', icon: 'admin', roles: ['OWNER'] },
]

export function SideNav({ user, onSignOut }: { user: CurrentUserDto; onSignOut: () => void }) {
  const pathname = usePathname()
  const tabs = TABS.filter((t) => !t.roles || t.roles.includes(user.role))
  // Longest-prefix wins so a nested route like /requests/suggest highlights
  // the Suggest tab, not both Suggest AND Requests. Plain `startsWith`
  // would light up every ancestor.
  const activeHref = [...tabs]
    .filter((t) => (t.href === '/' ? pathname === '/' : pathname === t.href || pathname.startsWith(t.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href

  return (
    <aside className="app-sidebar" aria-label="Primary navigation">
      <Link href="/" className="app-sidebar-brand">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <g stroke="var(--signal)" strokeWidth="2" strokeLinecap="round" fill="none">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="6" y1="7" x2="18" y2="17" />
            <line x1="18" y1="7" x2="6" y2="17" />
          </g>
          <circle cx="12" cy="12" r="1.6" fill="var(--pine)" />
        </svg>
        Winterborn
      </Link>

      <nav className="app-sidebar-nav">
        {tabs.map((tab) => {
          const active = tab.href === activeHref
          return (
            <Link key={tab.href} href={tab.href} className={`app-sidebar-item${active ? ' active' : ''}`}>
              {ICONS[tab.icon]}
              <span>{tab.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="app-sidebar-foot">
        <div className="app-sidebar-user">{user.name}</div>
        <div className="app-sidebar-role">{user.role.replace(/_/g, ' ').toLowerCase()}</div>
        <button type="button" className="app-sidebar-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </aside>
  )
}
