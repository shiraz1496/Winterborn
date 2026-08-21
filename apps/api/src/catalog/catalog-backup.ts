import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { square } from './square-client.js'
import type { CatalogPlan } from './catalog-plan.js'

/**
 * Build guide guard 1 ("backup before any write"). `backupCatalog` is the
 * rollback: it exports every top-level catalog object Square will hand
 * back (the default `catalog.list()` type set -- ITEM, CATEGORY, TAX,
 * DISCOUNT, MODIFIER_LIST, and friends -- which is everything the flat-item
 * migration touches, since `ITEM_VARIATION` objects are nested inline
 * inside each ITEM's `itemData.variations`, not listed separately) to a
 * timestamped JSON file under `data/backups/`. `assertFreshBackup` is the
 * hard stop: `applyPlan` (see `catalog-plan.ts`) calls it before making any
 * write, and refuses to run at all unless the newest backup post-dates the
 * plan it's about to apply.
 *
 * `data/` is gitignored -- backups never leave this machine and never
 * enter a commit.
 */

const DEFAULT_BACKUPS_DIR = 'data/backups'

export type CatalogBackupResult = {
  path: string
  objectCount: number
  createdAt: string
}

/**
 * Reads every page of `catalog.list()` (read-only -- no guard needed, this
 * is exactly the call the "no deletes" guard leaves untouched) and writes
 * it to `<backupsDir>/catalog-backup-<timestamp>.json`. `Money.amount` is
 * `bigint` on the wire, so the write uses a replacer -- see decision record
 * Consequences item 6.
 */
export async function backupCatalog(backupsDir: string = DEFAULT_BACKUPS_DIR): Promise<CatalogBackupResult> {
  mkdirSync(backupsDir, { recursive: true })

  const objects: unknown[] = []
  const page = await square.catalog.list()
  for await (const obj of page) objects.push(obj)

  const createdAt = new Date().toISOString()
  const fileName = `catalog-backup-${createdAt.replace(/[:.]/g, '-')}.json`
  const path = resolve(backupsDir, fileName)

  writeFileSync(
    path,
    JSON.stringify(
      { createdAt, objectCount: objects.length, objects },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  )

  return { path, objectCount: objects.length, createdAt }
}

/** The most recently modified `catalog-backup-*.json` file in `backupsDir`, or `undefined` if none exists. */
export function findLatestBackup(
  backupsDir: string = DEFAULT_BACKUPS_DIR,
): { path: string; mtimeMs: number } | undefined {
  if (!existsSync(backupsDir)) return undefined

  let latest: { path: string; mtimeMs: number } | undefined
  for (const fileName of readdirSync(backupsDir)) {
    if (!fileName.startsWith('catalog-backup-') || !fileName.endsWith('.json')) continue
    const path = resolve(backupsDir, fileName)
    const mtimeMs = statSync(path).mtimeMs
    if (!latest || mtimeMs > latest.mtimeMs) latest = { path, mtimeMs }
  }
  return latest
}

/**
 * The hard stop. Throws -- refusing to start, not merely warning -- unless
 * a backup exists under `backupsDir` whose file modification time is newer
 * than `plan.createdAt`. Called as the first line of `applyPlan`, so this
 * holds no matter which caller reaches `applyPlan` (the `catalog-apply` CLI,
 * `catalog-migrate`'s per-category loop, or a test).
 */
export function assertFreshBackup(plan: Pick<CatalogPlan, 'createdAt'>, backupsDir: string = DEFAULT_BACKUPS_DIR): void {
  const latest = findLatestBackup(backupsDir)
  if (!latest) {
    throw new Error(
      `catalog-apply refuses to start: no backup found under "${backupsDir}". ` +
        `Run \`pnpm --filter @winterborn/api cli:catalog-backup\` first -- Square has no undo, ` +
        `and this backup is the only rollback path if the apply goes wrong.`,
    )
  }

  const planTime = Date.parse(plan.createdAt)
  if (Number.isNaN(planTime)) {
    throw new Error(`catalog-apply refuses to start: plan.createdAt ("${plan.createdAt}") is not a valid timestamp.`)
  }

  if (latest.mtimeMs <= planTime) {
    throw new Error(
      `catalog-apply refuses to start: the newest backup (${latest.path}, ` +
        `${new Date(latest.mtimeMs).toISOString()}) is not newer than this plan ` +
        `(created ${plan.createdAt}). Run \`pnpm --filter @winterborn/api cli:catalog-backup\` again, ` +
        `right before applying, so the backup reflects the catalog state this plan is about to change.`,
    )
  }
}
