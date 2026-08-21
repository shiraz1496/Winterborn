/// Name of the httpOnly cookie carrying the session JWT (spec §10.1).
export const SESSION_COOKIE_NAME = 'winterborn_session'

/**
 * Parses a raw `Cookie` request header into a name -> value map. There is no
 * `cookie-parser` middleware wired up (one less dependency for one header),
 * so guards read `req.headers.cookie` directly through this.
 */
export function parseCookieHeader(header?: string): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}
