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
  pack: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8l9-5 9 5-9 5-9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  ),
  scan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M4 16v3a1 1 0 0 0 1 1h3M20 8V5a1 1 0 0 0-1-1h-3M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M4 12h16" />
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
  intake: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  ),
}

interface Tab {
  href: string
  label: string
  icon: keyof typeof ICONS
}

const WAREHOUSE_ROLES: CurrentUserDto['role'][] = ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR']
const APP_ROLES: CurrentUserDto['role'][] = ['OWNER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_OPERATOR', 'MARKET_MANAGER']

const ALL_TABS: (Tab & { roles?: CurrentUserDto['role'][] })[] = [
  { href: '/', label: 'Home', icon: 'dashboard', roles: APP_ROLES },
  { href: '/requests', label: 'Requests', icon: 'requests', roles: APP_ROLES },
  { href: '/intake', label: 'Intake', icon: 'intake', roles: WAREHOUSE_ROLES },
  { href: '/pack', label: 'Pack', icon: 'pack', roles: WAREHOUSE_ROLES },
  { href: '/scan', label: 'Scan', icon: 'scan', roles: WAREHOUSE_ROLES },
  { href: '/admin/colours', label: 'Colours', icon: 'admin', roles: ['OWNER', 'WAREHOUSE_MANAGER'] },
]

export function BottomNav({ role }: { role: CurrentUserDto['role'] }) {
  const pathname = usePathname()
  const tabs = ALL_TABS.filter((t) => !t.roles || t.roles.includes(role))

  return (
    <nav className="bottom-nav">
      {tabs.map((tab) => {
        const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href)
        return (
          <Link key={tab.href} href={tab.href} className={`bottom-nav-item${active ? ' active' : ''}`}>
            {ICONS[tab.icon]}
            <span>{tab.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
