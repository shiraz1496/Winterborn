import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { hash as hashArgon2 } from '@node-rs/argon2'
import { Test } from '@nestjs/testing'
import type { INestApplication, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AppModule } from '../src/app.module.js'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { AuthService } from '../src/auth/auth.service.js'
import { RolesGuard } from '../src/auth/roles.guard.js'
import { SESSION_COOKIE_NAME } from '../src/auth/cookies.js'
import { seedDevCatalog, type DevSeed } from '../prisma/seed-dev.js'

process.env.JWT_SECRET = 'test-jwt-secret'

const prisma = new PrismaService()
const auth = new AuthService(prisma)
let seed: DevSeed

const PLAINTEXT_PASSWORD = 'correct horse battery staple'

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  seed = await seedDevCatalog(prisma)
})

async function createUser(
  email: string,
  role: 'OWNER' | 'WAREHOUSE' | 'MARKET_MANAGER' | 'OPERATOR',
  locationId: string | null = null,
  password: string | null = PLAINTEXT_PASSWORD,
) {
  const passwordHash = password === null ? null : await hashArgon2(password)
  return prisma.user.create({ data: { email, name: email, role, locationId, passwordHash } })
}

describe('AuthService.login', () => {
  it('returns a session for correct credentials', async () => {
    await createUser('owner@test.local', 'OWNER')
    const result = await auth.login('owner@test.local', PLAINTEXT_PASSWORD)
    expect(result.user.email).toBe('owner@test.local')
    expect(result.jwt).toEqual(expect.any(String))
  })

  it('rejects a wrong password without revealing whether the email exists', async () => {
    await createUser('warehouse@test.local', 'WAREHOUSE')

    const wrongPassword = auth.login('warehouse@test.local', 'not-the-password').catch((e) => e)
    const unknownEmail = auth.login('nobody-here@test.local', 'anything').catch((e) => e)
    const [wrongPasswordErr, unknownEmailErr] = await Promise.all([wrongPassword, unknownEmail])

    expect(wrongPasswordErr).toBeInstanceOf(Error)
    expect(unknownEmailErr).toBeInstanceOf(Error)
    // Same message either way -- nothing in the response distinguishes
    // "wrong password" from "no such user".
    expect((wrongPasswordErr as Error).message).toBe((unknownEmailErr as Error).message)
    expect((wrongPasswordErr as Error).message.toLowerCase()).not.toContain('no such user')
    expect((wrongPasswordErr as Error).message.toLowerCase()).not.toContain('not found')
  })

  it('rejects a user with no passwordHash set', async () => {
    await createUser('operator@test.local', 'OPERATOR', null, null)
    await expect(auth.login('operator@test.local', 'anything')).rejects.toThrow()
  })

  it('never persists or logs the plaintext password', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await createUser('plaintext-check@test.local', 'OWNER')
      await auth.login('plaintext-check@test.local', PLAINTEXT_PASSWORD)
      // A failed attempt too -- a rejected login is exactly the path most
      // likely to end up in an exception log with the request body attached.
      await auth.login('plaintext-check@test.local', 'wrong-guess').catch(() => {})

      const row = await prisma.user.findUniqueOrThrow({ where: { email: 'plaintext-check@test.local' } })
      expect(row.passwordHash).not.toBeNull()
      expect(row.passwordHash).not.toBe(PLAINTEXT_PASSWORD)
      expect(row.passwordHash?.startsWith('$argon2')).toBe(true)

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join('\n')
      expect(allLoggedText).not.toContain(PLAINTEXT_PASSWORD)
      expect(allLoggedText).not.toContain('wrong-guess')
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

describe('RolesGuard', () => {
  function contextWithUser(user: { role: string } | undefined): ExecutionContext {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext
  }

  // Reflector.getAllAndOverride is stubbed rather than exercised through real
  // decorator metadata -- what's under test here is RolesGuard's own
  // decision (allow / 403), not Nest's metadata plumbing (skipped per the
  // plan's testing policy: "skip framework wiring").
  function guardRequiring(roles: string[]): RolesGuard {
    const reflector = { getAllAndOverride: () => roles } as unknown as Reflector
    return new RolesGuard(reflector)
  }

  it('throws ForbiddenException (403) for a MARKET_MANAGER on a route requiring WAREHOUSE', () => {
    const guard = guardRequiring(['WAREHOUSE'])
    const ctx = contextWithUser({ role: 'MARKET_MANAGER' })
    expect(() => guard.canActivate(ctx)).toThrow(/insufficient role/)
  })

  it('allows a WAREHOUSE user through a route requiring WAREHOUSE', () => {
    const guard = guardRequiring(['WAREHOUSE'])
    const ctx = contextWithUser({ role: 'WAREHOUSE' })
    expect(guard.canActivate(ctx)).toBe(true)
  })

  it('allows any authenticated user through a route with no @Roles(...) at all', () => {
    const guard = guardRequiring([])
    const ctx = contextWithUser({ role: 'MARKET_MANAGER' })
    expect(guard.canActivate(ctx)).toBe(true)
  })
})

describe('POST /auth/login + GET /auth/me', () => {
  let app: INestApplication
  let baseUrl: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    await app.listen(0)
    baseUrl = await app.getUrl()
  })
  afterAll(async () => {
    await app.close()
  })

  it('401s with no cookie', async () => {
    const res = await fetch(`${baseUrl}/auth/me`)
    expect(res.status).toBe(401)
  })

  it('sets a session cookie for correct credentials, and /auth/me then resolves', async () => {
    await createUser('me@test.local', 'OWNER')

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'me@test.local', password: PLAINTEXT_PASSWORD }),
    })
    expect(loginRes.status).toBe(200)
    const setCookie = loginRes.headers.get('set-cookie') as string
    expect(setCookie).toContain(SESSION_COOKIE_NAME)
    expect(setCookie.toLowerCase()).toContain('httponly')
    const cookieValue = setCookie.split(';')[0] as string

    const meRes = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: cookieValue } })
    expect(meRes.status).toBe(200)
    const body = (await meRes.json()) as { user: { email: string } }
    expect(body.user.email).toBe('me@test.local')
  })

  it('rejects a wrong password with 401 and no session cookie', async () => {
    await createUser('reject@test.local', 'WAREHOUSE')

    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reject@test.local', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('logout clears the cookie and the session stops working', async () => {
    await createUser('logout@test.local', 'OWNER')

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'logout@test.local', password: PLAINTEXT_PASSWORD }),
    })
    const cookieValue = (loginRes.headers.get('set-cookie') as string).split(';')[0] as string

    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookieValue },
    })
    expect(logoutRes.status).toBe(200)
    const clearedCookie = logoutRes.headers.get('set-cookie') as string
    expect(clearedCookie).toContain(SESSION_COOKIE_NAME)

    const meRes = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: cookieValue } })
    expect(meRes.status).toBe(401)
  })
})
