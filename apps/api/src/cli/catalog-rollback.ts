import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CatalogPlan } from '../catalog/catalog-plan.js'
import { rollbackPlan } from '../catalog/catalog-rollback.js'

/**
 * `catalog-rollback --plan <file>` -- reverses a plan `catalog-apply`
 * already applied: renames the legacy variation back to its pre-migration
 * name, and archives (hides, never deletes) the variations that were
 * added. Build guide guard 5 -- see `catalog-rollback.ts` for exactly what
 * "archive" means here and why.
 */

function parseArgs(argv: string[]): { plan: string } {
  const idx = argv.indexOf('--plan')
  const plan = idx === -1 ? undefined : argv[idx + 1]
  if (!plan) throw new Error('usage: cli:catalog-rollback -- --plan <file>')
  return { plan }
}

async function main(): Promise<void> {
  const { plan: planPath } = parseArgs(process.argv.slice(2))
  const path = resolve(process.cwd(), planPath)
  const plan: CatalogPlan = JSON.parse(readFileSync(path, 'utf8'))

  console.log(`\nCatalog rollback: ${plan.category}  (plan ${plan.createdAt})`)
  const results = await rollbackPlan(plan)

  let rolledBack = 0
  let already = 0
  let failed = 0
  for (const r of results) {
    if (r.status === 'rolled-back') rolledBack++
    else if (r.status === 'already-rolled-back') already++
    else failed++
    console.log(`  ${r.status.padEnd(20)} ${r.itemGroupName}  (${r.squareItemId})`)
    if (r.error) console.log(`    error: ${r.error}`)
    if (r.archivedVariationIds?.length) console.log(`    archived: ${r.archivedVariationIds.join(', ')}`)
  }

  console.log(`\n  rolled-back: ${rolledBack}  already-rolled-back: ${already}  failed: ${failed}\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
