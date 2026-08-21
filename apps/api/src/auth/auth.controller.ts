import { BadRequestException, Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common'
import { AuthService, type RequestMagicLinkResult, SESSION_TTL_DAYS } from './auth.service.js'
import { JwtGuard } from './jwt.guard.js'
import { CurrentUser } from './current-user.decorator.js'
import { SESSION_COOKIE_NAME } from './cookies.js'
import type { CurrentUserPayload } from './current-user.js'

/// Minimal shape we need off the response -- see webhook.controller.ts's
/// InboundWebhookRequest for why this package doesn't import express's own
/// types.
interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('magic-link')
  @HttpCode(200)
  async magicLink(@Body() body: { email?: unknown }): Promise<RequestMagicLinkResult> {
    if (typeof body?.email !== 'string' || body.email.length === 0) {
      throw new BadRequestException('email is required')
    }
    return this.auth.requestMagicLink(body.email)
  }

  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() body: { token?: unknown },
    @Res({ passthrough: true }) res: CookieResponse,
  ): Promise<{ user: CurrentUserPayload }> {
    if (typeof body?.token !== 'string' || body.token.length === 0) {
      throw new BadRequestException('token is required')
    }
    const { jwt, user } = await this.auth.verifyMagicLink(body.token)
    res.cookie(SESSION_COOKIE_NAME, jwt, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      path: '/',
    })
    return { user }
  }

  @Get('me')
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: CurrentUserPayload): { user: CurrentUserPayload } {
    return { user }
  }
}
