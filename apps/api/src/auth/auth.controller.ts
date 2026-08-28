import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common'
import { AuthService, SESSION_TTL_DAYS } from './auth.service.js'
import { JwtGuard } from './jwt.guard.js'
import { CurrentUser } from './current-user.decorator.js'
import { parseCookieHeader, SESSION_COOKIE_NAME } from './cookies.js'
import { verifyJwt } from './jwt.js'
import { requireJwtSecret, type CurrentUserPayload } from './current-user.js'

/// Minimal shape we need off the request/response -- see
/// webhook.controller.ts's InboundWebhookRequest for why this package
/// doesn't import express's own types.
interface CookieRequest {
  headers: { cookie?: string }
}
interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void
  clearCookie(name: string, options: Record<string, unknown>): void
}

/// `path` must match between `cookie()` and `clearCookie()` -- the browser
/// scopes cookies by path, so a clear with a different path silently no-ops.
const SESSION_COOKIE_PATH = { path: '/' }

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) { }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email?: unknown; password?: unknown },
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<{ user: CurrentUserPayload }> {
    if (typeof body?.email !== 'string' || body.email.length === 0) {
      throw new BadRequestException('email is required')
    }
    if (typeof body?.password !== 'string' || body.password.length === 0) {
      throw new BadRequestException('password is required')
    }
    const { jwt, user } = await this.auth.login(body.email, body.password)
    // IS_CROSS=true when web and API live on different registrable domains
    // (e.g. Vercel + Render). Explicit === 'true' check because every env
    // var is a string, and "false" would otherwise be truthy.
    const isCross = process.env.IS_CROSS === 'true'
    res.cookie(SESSION_COOKIE_NAME, jwt, {
      ...SESSION_COOKIE_PATH,
      httpOnly: true,
      // SameSite=None lets the cookie ride cross-site fetches; browsers
      // reject None without Secure, so pair them. Locally we stay on lax +
      // insecure so http://localhost dev keeps working.
      sameSite: isCross ? 'none' : 'lax',
      secure: isCross,
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    })
    return { user }
  }

  /**
   * Clears the session cookie and revokes the underlying Session row, so a
   * stolen or shared-phone cookie stops working immediately rather than
   * just being forgotten client-side. Deliberately not behind JwtGuard: an
   * already-expired or already-invalid cookie should still clear cleanly
   * (idempotent), not 401. Reads the cookie directly with the same
   * cookies.ts/jwt.ts helpers JwtGuard uses, rather than going through the
   * guard, so this endpoint works even when the guard would reject it.
   */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: CookieRequest, @Res({ passthrough: true }) res: CookieResponse): Promise<{ ok: true }> {
    const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME]
    if (token) {
      try {
        const payload = verifyJwt(token, requireJwtSecret())
        await this.auth.logout(payload.sessionId)
      } catch {
        // Invalid/expired token -- nothing to revoke server-side, still
        // clear the cookie below.
      }
    }
    // clearCookie must match the original cookie's sameSite/secure or
    // modern browsers reject the replacement and the stale cookie survives.
    const isCross = process.env.IS_CROSS === 'true'
    res.clearCookie(SESSION_COOKIE_NAME, {
      ...SESSION_COOKIE_PATH,
      httpOnly: true,
      sameSite: isCross ? 'none' : 'lax',
      secure: isCross,
    })
    return { ok: true }
  }

  @Get('me')
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: CurrentUserPayload): { user: CurrentUserPayload } {
    return { user }
  }
}
