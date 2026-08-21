import { SetMetadata } from '@nestjs/common'
import type { UserRole } from '@prisma/client'

export const ROLES_KEY = 'roles'

/// Marks a route (or a whole controller) as restricted to the given roles.
/// Read by `RolesGuard`. A route with no `@Roles(...)` at all is left open
/// to anyone `JwtGuard` has already authenticated.
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles)
