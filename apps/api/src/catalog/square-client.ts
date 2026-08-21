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
 * Build guide guard 3 ("no deletes, ever"): this wrapper is the one place
 * every production catalog write goes through (`catalog-plan.ts`,
 * `catalog-rollback.ts`, and anything future). Deleting or archiving a
 * catalog object is exactly the failure mode the flat-item migration is
 * designed around -- see decision record Decisions 1-2 -- so a delete or
 * archive attempted through this `square` instance throws *before* any
 * HTTP call is made, no matter which call site reaches for it, including
 * ones written after this guard.
 *
 * This is intentionally scoped to this file's `square` instance, not to
 * the SDK globally: `prototypes/src/client.ts` constructs its own,
 * unguarded `SquareClient` and legitimately deletes objects in sandbox to
 * prove the negative control in `prototypes/src/verify.test.ts`. That is
 * sandbox throwaway data on a different code path; this guard belongs on
 * the one that will eventually run against the live $2.9M catalog.
 *
 * Square exposes exactly two ways to make a catalog object disappear
 * through this SDK:
 *   1. `catalog.object.delete` / `catalog.batchDelete` -- hard delete.
 *   2. `catalog.object.upsert` with `itemData.isArchived: true` on an
 *      ITEM -- Square's own soft-delete/archive, which goes through the
 *      same upsert endpoint the migration uses for legitimate writes, so
 *      it has to be inspected per-call rather than blocked wholesale.
 * Both are covered below.
 */
function forbidCatalogDeletion(action: string): never {
  throw new Error(
    `Refusing to ${action}. This codebase's production catalog write path only ` +
      `adds and renames catalog objects -- never deletes or archives one -- per ` +
      `docs/superpowers/decisions/2026-08-19-flat-item-migration.md (Decisions 1-2). ` +
      `Square has no undo: a delete or archive here would be irreversible against a ` +
      `$2.9M season of live sales history across 14 markets. If an object genuinely ` +
      `needs to go away, that is a deliberate call for Joel to make by hand in the ` +
      `Square Dashboard, not something this code path performs.`,
  )
}

function isArchivingUpsert(request: unknown): boolean {
  if (typeof request !== 'object' || request === null) return false
  const obj = (request as { object?: unknown }).object
  if (typeof obj !== 'object' || obj === null) return false
  const o = obj as { type?: string; itemData?: { isArchived?: boolean | null } }
  return o.type === 'ITEM' && o.itemData?.isArchived === true
}

const objectClient = square.catalog.object as unknown as {
  upsert: (request: unknown, options?: unknown) => unknown
  delete: (request: unknown, options?: unknown) => unknown
}
const catalogClient = square.catalog as unknown as {
  batchDelete: (request: unknown, options?: unknown) => unknown
}

const realUpsert = objectClient.upsert.bind(objectClient)

// `async` throughout, deliberately: every guarded method here replaces one
// that's typed to return a promise-like (`core.HttpResponsePromise`), and
// callers use `await`/`.catch()`/`.rejects` against that contract. A bare
// synchronous throw would break out of that shape instead of rejecting it.
objectClient.upsert = async (request: unknown, options?: unknown) => {
  if (isArchivingUpsert(request)) return forbidCatalogDeletion('upsert a catalog object with itemData.isArchived: true')
  return realUpsert(request, options)
}
objectClient.delete = async () => forbidCatalogDeletion('delete a catalog object (catalog.object.delete)')
catalogClient.batchDelete = async () => forbidCatalogDeletion('batch-delete catalog objects (catalog.batchDelete)')

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
