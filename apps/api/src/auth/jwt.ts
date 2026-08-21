import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * A minimal, dependency-free HS256 JWT signer/verifier. There is no exotic
 * requirement here -- spec §10.1 says "keep it boring" -- so this avoids
 * pulling in a JWT library for three lines of HMAC. Not a general-purpose
 * JWT implementation: no alg negotiation, no key rotation, one algorithm.
 */

export interface JwtPayload {
  sub: string
  role: string
  sessionId: string
  /// Unix seconds.
  exp: number
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function signJwt(payload: Omit<JwtPayload, 'exp'>, secret: string, expiresInSeconds: number): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const full: JwtPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds }
  const headerPart = base64url(JSON.stringify(header))
  const payloadPart = base64url(JSON.stringify(full))
  const signature = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest('base64url')
  return `${headerPart}.${payloadPart}.${signature}`
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')
  const [headerPart, payloadPart, signature] = parts as [string, string, string]

  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest('base64url')
  const expectedBuf = Buffer.from(expected)
  const givenBuf = Buffer.from(signature)
  if (expectedBuf.length !== givenBuf.length || !timingSafeEqual(expectedBuf, givenBuf)) {
    throw new Error('invalid signature')
  }

  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as JwtPayload
  if (payload.exp * 1000 < Date.now()) throw new Error('token expired')
  return payload
}
