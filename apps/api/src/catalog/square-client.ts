import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import dotenv from 'dotenv'
import { SquareClient, SquareEnvironment } from 'square'

// .env lives at the repo root; this file is loaded from a variety of
// working directories (a `pnpm --filter` CLI run has cwd = apps/api, a
// vitest run may differ), so resolve relative to this file's own
// location rather than trusting process.cwd().
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') })

/**
 * Refuses to run against anything but the Square sandbox. Catalog writes
 * are destructive and irreversible against real sales history -- see
 * `docs/superpowers/decisions/2026-08-19-flat-item-migration.md`. The
 * production run is explicitly out of scope for this plan.
 */
export function assertSandbox(): void {
  if (process.env.SQUARE_ENV !== 'sandbox') {
    throw new Error(
      `Refusing to run: SQUARE_ENV is "${process.env.SQUARE_ENV}", expected "sandbox". ` +
        `This code must never touch production.`,
    )
  }
  const appId = process.env.SQUARE_APPLICATION_ID ?? ''
  if (!appId.startsWith('sandbox-')) {
    throw new Error(
      `Refusing to run: SQUARE_APPLICATION_ID does not start with "sandbox-". ` +
        `Got "${appId.slice(0, 12)}...". Check the environment toggle in the Developer Console.`,
    )
  }
}

assertSandbox()

export const square = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN!,
  environment: SquareEnvironment.Sandbox,
})

/**
 * Shape shared by every Square SDK response: a structurally-successful
 * HTTP call can still carry API-level failures in `errors`, without
 * throwing. Callers must check explicitly -- see decision record
 * Consequences item 4.
 */
interface ResponseWithErrors {
  errors?: Array<{ category?: string; code?: string; detail?: string; field?: string }>
}

function hasErrorsArray(res: unknown): res is ResponseWithErrors {
  return typeof res === 'object' && res !== null && 'errors' in res
}

/**
 * Throws if `res` carries a non-empty `errors` array. `context` names the
 * call that produced `res`, so a failure names the real cause instead of
 * surfacing downstream as a generic "field was missing" error.
 */
export function assertNoErrors(res: unknown, context: string): void {
  if (!hasErrorsArray(res) || !res.errors || res.errors.length === 0) return
  const detail = res.errors
    .map((e) => `${e.category ?? 'UNKNOWN'}/${e.code ?? 'UNKNOWN'}${e.detail ? `: ${e.detail}` : ''}`)
    .join('; ')
  throw new Error(`${context}: Square API returned errors -- ${detail}`)
}

let cachedLocationId: string | undefined

/** First location in the sandbox merchant. Cached for the life of the process. */
export async function mainLocationId(): Promise<string> {
  if (cachedLocationId) return cachedLocationId
  const res = await square.locations.list()
  assertNoErrors(res, 'locations.list (mainLocationId)')
  const id = res.locations?.[0]?.id
  if (!id) throw new Error('Sandbox merchant has no locations')
  cachedLocationId = id
  return id
}

/**
 * A 404 with this shape means "object does not exist" -- proved to be
 * indistinguishable from "object was deleted" by the negative control in
 * `prototypes/src/verify.test.ts`. Any other error shape must propagate,
 * not be swallowed as "absent".
 */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { statusCode?: number; errors?: Array<{ code?: string; category?: string }> }
  if (e.statusCode !== 404) return false
  return (e.errors ?? []).some((x) => x.code === 'NOT_FOUND' && x.category === 'INVALID_REQUEST_ERROR')
}

/** True if the catalog object still resolves (live), false if it 404s as absent. */
export async function catalogObjectExists(objectId: string): Promise<boolean> {
  try {
    const res = await square.catalog.object.get({ objectId })
    assertNoErrors(res, `catalog.object.get (catalogObjectExists ${objectId})`)
    return res.object !== undefined
  } catch (err) {
    if (isNotFoundError(err)) return false
    throw err
  }
}
