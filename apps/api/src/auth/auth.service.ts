import { Injectable, UnauthorizedException } from '@nestjs/common'
import { verify as verifyArgon2 } from '@node-rs/argon2'
import { PrismaService } from '../prisma/prisma.service.js'
import { signJwt } from './jwt.js'
import { requireJwtSecret, type CurrentUserPayload } from './current-user.js'

const SESSION_TTL_DAYS = 7

export interface LoginResult {
  jwt: string
  user: CurrentUserPayload
}

/**
 * Password auth. A user with no `passwordHash` (not yet seeded with one)
 * cannot log in -- same rejection as a wrong password, deliberately: this
 * never distinguishes "no such user" / "no password set" / "wrong
 * password" in what it tells the caller, only in server-side logs. The
 * raw password is never persisted or logged, only its Argon2id hash
 * (@node-rs/argon2, the library's own default parameters).
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } })

    // Verify against a hash even when no user/passwordHash exists, using a
    // fixed dummy hash of the same Argon2id shape. Returning early instead
    // would make a bad-email response measurably faster than a
    // bad-password response -- a timing side-channel that reveals which
    // emails are registered. This keeps both paths doing one Argon2
    // verify no matter which branch it started from.
    const hash = user?.passwordHash ?? DUMMY_HASH
    const ok = await verifyArgon2(hash, password).catch(() => false)

    if (!ok || !user || !user.passwordHash || !user.isActive) {
      throw new UnauthorizedException('invalid email or password')
    }

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

  async logout(sessionId: string): Promise<void> {
    // Deleting rather than expiring: this *is* the revoke. A shared
    // warehouse phone needs the next person locked out immediately, not
    // merely unable to get a fresh cookie.
    await this.prisma.session.deleteMany({ where: { id: sessionId } })
  }
}

/// A real Argon2id hash of an unguessable, never-used password, computed
/// once at module load. Exists purely so the no-such-user branch above
/// pays the same verify cost as the real one -- its value is never
/// checked against anything.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ArWY74yDQw/au5N1tzdh4w$vcBK96q4Yrj6YkMF/0MeILzAqhqw960VrIrlpoXUnQA'

export { SESSION_TTL_DAYS }
