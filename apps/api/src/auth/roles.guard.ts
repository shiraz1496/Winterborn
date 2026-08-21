import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY } from './roles.decorator.js'
import type { CurrentUserPayload } from './current-user.js'

/// Reads the `@Roles(...)` metadata set on a handler or controller and
/// checks it against `request.user.role`. Must run after `JwtGuard` --
/// `request.user` is only populated once that guard has authenticated the
/// request.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required || required.length === 0) return true

    const { user } = context.switchToHttp().getRequest<{ user?: CurrentUserPayload }>()
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('insufficient role')
    }
    return true
  }
}
