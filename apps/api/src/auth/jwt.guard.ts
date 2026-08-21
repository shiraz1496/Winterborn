import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { parseCookieHeader, SESSION_COOKIE_NAME } from './cookies.js'
import { verifyJwt } from './jwt.js'
import { requireJwtSecret, type CurrentUserPayload } from './current-user.js'

/// Minimal shape we need off the request -- see webhook.controller.ts's
/// InboundWebhookRequest for why this package doesn't just import express's
/// own Request type.
interface AuthenticatedRequest {
  headers: { cookie?: string }
  user?: CurrentUserPayload
}

/**
 * Verifies the session cookie and attaches the current user to the request.
 *
 * Deliberately re-reads the user (and the Session row) from the database on
 * every request rather than trusting the JWT payload alone: a deactivated
 * user or an expired/revoked session must lose access immediately, not
 * whenever their token happens to expire.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME]
    if (!token) throw new UnauthorizedException('not authenticated')

    let payload
    try {
      payload = verifyJwt(token, requireJwtSecret())
    } catch {
      throw new UnauthorizedException('invalid session')
    }

    const session = await this.prisma.session.findUnique({ where: { id: payload.sessionId } })
    if (!session || session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('session expired')
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user || !user.isActive) throw new UnauthorizedException('user not found or inactive')

    req.user = { id: user.id, email: user.email, name: user.name, role: user.role, locationId: user.locationId }
    return true
  }
}
