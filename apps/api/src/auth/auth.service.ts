import { Injectable, UnauthorizedException } from '@nestjs/common'
import { randomBytes, createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'
import { signJwt } from './jwt.js'
import { requireJwtSecret, type CurrentUserPayload } from './current-user.js'

const SESSION_TTL_DAYS = 7

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export interface RequestMagicLinkResult {
  ok: true
  /// Only populated when MAIL_TRANSPORT is 'console' -- no sending domain is
  /// verified yet (deliberate, spec §10.1), so the API hands the link back
  /// instead of only printing it, and the PWA's /login shows it inline.
  devLink?: string
}

export interface VerifyMagicLinkResult {
  jwt: string
  user: CurrentUserPayload
}

/**
 * Magic-link auth: issues single-use, short-lived tokens; verifies them into
 * a session-backed JWT. Only the SHA-256 hash of a token is ever persisted
 * (MagicLinkToken.tokenHash) -- the raw token exists only in the link itself,
 * which this process never stores.
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async requestMagicLink(email: string): Promise<RequestMagicLinkResult> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user || !user.isActive) {
      // Do not reveal whether the address is known to the system.
      return { ok: true }
    }

    const token = randomBytes(32).toString('base64url')
    const tokenHash = sha256Hex(token)
    const ttlMinutes = Number(process.env.MAGIC_LINK_TTL_MINUTES ?? 15)
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000)

    await this.prisma.magicLinkToken.create({ data: { tokenHash, email, expiresAt } })

    const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000'
    const link = `${webOrigin}/login?token=${token}`

    const transport = process.env.MAIL_TRANSPORT ?? 'console'
    if (transport !== 'console') {
      // Sandbox only (Global Constraints): no other transport is wired up.
      throw new Error(`unsupported MAIL_TRANSPORT: ${transport}`)
    }
    // eslint-disable-next-line no-console -- this *is* the mail transport.
    console.log(`[auth] magic link for ${email}: ${link}`)
    return { ok: true, devLink: link }
  }

  async verifyMagicLink(token: string): Promise<VerifyMagicLinkResult> {
    const tokenHash = sha256Hex(token)
    const record = await this.prisma.magicLinkToken.findUnique({ where: { tokenHash } })
    if (!record) throw new UnauthorizedException('invalid magic link')
    if (record.consumedAt) throw new UnauthorizedException('magic link already used')
    if (record.expiresAt.getTime() < Date.now()) throw new UnauthorizedException('magic link expired')

    // Atomically claim the token: a compare-then-set update, not a
    // read-then-write, so two concurrent verify calls for the same token
    // cannot both succeed.
    const claim = await this.prisma.magicLinkToken.updateMany({
      where: { tokenHash, consumedAt: null },
      data: { consumedAt: new Date() },
    })
    if (claim.count === 0) throw new UnauthorizedException('magic link already used')

    const user = await this.prisma.user.findUnique({ where: { email: record.email } })
    if (!user || !user.isActive) throw new UnauthorizedException('no active user for this magic link')

    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60_000)
    const session = await this.prisma.session.create({ data: { userId: user.id, expiresAt } })

    const jwt = signJwt(
      { sub: user.id, role: user.role, sessionId: session.id },
      requireJwtSecret(),
      SESSION_TTL_DAYS * 24 * 60 * 60,
    )

    return {
      jwt,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, locationId: user.locationId },
    }
  }
}

export { SESSION_TTL_DAYS }
