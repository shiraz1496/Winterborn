import { square, assertNoErrors } from './square-client.js'
import { findLatestBackup } from './catalog-backup.js'

/**
 * Build guide guard 6. Everything here is a read -- nothing in this file
 * writes to Square -- so it can run any number of times with no
 * consequence, which is the point: it is the thing an operator runs first,
 * before touching anything else, and re-runs if anything about the
 * environment changes.
 *
 * Per DEPLOY.md §4, the production token Joel issues is meant to be scoped
 * to Catalog, Inventory, Orders, Merchants -- the Square OAuth scope names
 * for that are `ITEMS_READ`/`ITEMS_WRITE`, `INVENTORY_READ`/
 * `INVENTORY_WRITE`, `ORDERS_READ`, `MERCHANT_PROFILE_READ`. Overridable
 * via `opts.requiredScopes` in case the token that actually gets issued is
 * scoped differently than planned.
 */
export const DEFAULT_REQUIRED_SCOPES = [
  'ITEMS_READ',
  'ITEMS_WRITE',
  'INVENTORY_READ',
  'INVENTORY_WRITE',
  'ORDERS_READ',
  'MERCHANT_PROFILE_READ',
]

export type PreflightCheck = { name: string; ok: boolean; detail: string }
export type PreflightResult = { go: boolean; checks: PreflightCheck[] }

export type PreflightOptions = {
  /** What the operator intends to run against -- compared against the live `SQUARE_ENV`, not inferred from it. */
  expectedSquareEnv: 'sandbox' | 'production'
  /** How many Square locations should be visible -- 2 in sandbox during development, 14 in production. */
  expectedLocationCount: number
  requiredScopes?: string[]
  backupsDir?: string
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const checks: PreflightCheck[] = []
  const requiredScopes = opts.requiredScopes ?? DEFAULT_REQUIRED_SCOPES

  const actualEnv = process.env.SQUARE_ENV
  checks.push({
    name: 'SQUARE_ENV matches intent',
    ok: actualEnv === opts.expectedSquareEnv,
    detail: `operator intended "${opts.expectedSquareEnv}", process.env.SQUARE_ENV is "${actualEnv}"`,
  })

  try {
    const res = await square.oAuth.retrieveTokenStatus()
    assertNoErrors(res, 'oAuth.retrieveTokenStatus (preflight)')
    checks.push({
      name: 'token is valid',
      ok: true,
      detail: `merchantId=${res.merchantId ?? 'unknown'}, expiresAt=${res.expiresAt ?? 'never'}`,
    })

    const scopes = res.scopes ?? []
    const missing = requiredScopes.filter((s) => !scopes.includes(s))
    checks.push({
      name: 'token has required scopes',
      ok: missing.length === 0,
      detail: missing.length > 0 ? `missing: ${missing.join(', ')} (has: ${scopes.join(', ') || 'none'})` : `has: ${scopes.join(', ')}`,
    })
  } catch (err) {
    checks.push({ name: 'token is valid', ok: false, detail: (err as Error).message })
    checks.push({ name: 'token has required scopes', ok: false, detail: 'could not check -- token call failed above' })
  }

  try {
    const res = await square.locations.list()
    assertNoErrors(res, 'locations.list (preflight)')
    const count = (res.locations ?? []).length
    checks.push({
      name: 'expected number of locations visible',
      ok: count === opts.expectedLocationCount,
      detail: `expected ${opts.expectedLocationCount}, found ${count}`,
    })
  } catch (err) {
    checks.push({ name: 'expected number of locations visible', ok: false, detail: (err as Error).message })
  }

  const backupsDir = opts.backupsDir ?? 'data/backups'
  const latest = findLatestBackup(backupsDir)
  checks.push({
    name: 'a backup exists',
    ok: Boolean(latest),
    detail: latest
      ? `${latest.path} (${new Date(latest.mtimeMs).toISOString()})`
      : `no backup found under "${backupsDir}" -- run cli:catalog-backup`,
  })

  return { go: checks.every((c) => c.ok), checks }
}
