import 'reflect-metadata'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
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
process.env.MAIL_TRANSPORT = 'console'

const prisma = new PrismaService()
const auth = new AuthService(prisma)
let seed: DevSeed

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  seed = await seedDevCatalog(prisma)
})

async function createUser(email: string, role: 'OWNER' | 'WAREHOUSE' | 'MARKET_MANAGER' | 'OPERATOR', locationId: string | null = null) {
  return prisma.user.create({ data: { email, name: email, role, locationId } })
}

describe('AuthService.requestMagicLink / verifyMagicLink', () => {
  it('stores only the SHA-256 hash of the token, never the raw value', async () => {
    await createUser('owner@test.local', 'OWNER')
    const result = await auth.requestMagicLink('owner@test.local')
    expect(result.devLink).toBeDefined()
    const token = new URL(result.devLink as string).searchParams.get('token') as string

    const rows = await prisma.magicLinkToken.findMany({ where: { email: 'owner@test.local' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).not.toBe(token)
    expect(rows[0]?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
  })

  it('is single-use: a second verify of the same token is rejected', async () => {
    await createUser('warehouse@test.local', 'WAREHOUSE')
    const { devLink } = await auth.requestMagicLink('warehouse@test.local')
    const token = new URL(devLink as string).searchParams.get('token') as string

    const first = await auth.verifyMagicLink(token)
    expect(first.user.email).toBe('warehouse@test.local')

    await expect(auth.verifyMagicLink(token)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    await createUser('operator@test.local', 'OPERATOR')
    const { devLink } = await auth.requestMagicLink('operator@test.local')
    const token = new URL(devLink as string).searchParams.get('token') as string

    const hash = createHash('sha256').update(token).digest('hex')
    await prisma.magicLinkToken.update({ where: { tokenHash: hash }, data: { expiresAt: new Date(Date.now() - 1000) } })

    await expect(auth.verifyMagicLink(token)).rejects.toThrow()
  })

  it('rejects a token that was never issued', async () => {
    await expect(auth.verifyMagicLink('not-a-real-token')).rejects.toThrow()
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

describe('GET /auth/me', () => {
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

  it('returns the user for a valid session cookie set by /auth/verify', async () => {
    await createUser('me@test.local', 'OWNER')
    const { devLink } = await auth.requestMagicLink('me@test.local')
    const token = new URL(devLink as string).searchParams.get('token') as string

    const verifyRes = await fetch(`${baseUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    expect(verifyRes.status).toBe(200)
    const setCookie = verifyRes.headers.get('set-cookie') as string
    expect(setCookie).toContain(SESSION_COOKIE_NAME)
    expect(setCookie.toLowerCase()).toContain('httponly')
    const cookieValue = setCookie.split(';')[0] as string

    const meRes = await fetch(`${baseUrl}/auth/me`, { headers: { cookie: cookieValue } })
    expect(meRes.status).toBe(200)
    const body = (await meRes.json()) as { user: { email: string } }
    expect(body.user.email).toBe('me@test.local')
  })
})
