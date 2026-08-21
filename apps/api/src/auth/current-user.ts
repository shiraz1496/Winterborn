import type { UserRole } from '@prisma/client'

/// Attached to `request.user` by `JwtGuard`. `locationId` is only ever
/// non-null for MARKET_MANAGER; the other three roles see everything.
export interface CurrentUserPayload {
  id: string
  email: string
  name: string
  role: UserRole
  locationId: string | null
}

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set')
  return secret
}
