import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CatalogPlan } from '../catalog/catalog-plan.js'
import { applyPlan } from '../catalog/catalog-plan.js'

/**
 * `catalog-apply --plan <file>` -- executes a plan written by
 * `catalog-plan`. Read-modify-write per item, idempotent and resumable
 * (see `applyPlan`'s docstring), every Square call passed through the
 * `assertNoErrors` check established in Plan 1. Records what it did to
 * `<file>.result.json` alongside the plan.
 */

function parseArgs(argv: string[]): { plan: string } {
  const idx = argv.indexOf('--plan')
  const plan = idx === -1 ? undefined : argv[idx + 1]
  if (!plan) throw new Error('usage: cli:catalog-apply -- --plan <file>')
  return { plan }
}

async function main(): Promise<void> {
  const { plan: planPath } = parseArgs(process.argv.slice(2))
  const path = resolve(process.cwd(), planPath)
  const plan: CatalogPlan = JSON.parse(readFileSync(path, 'utf8'))

  console.log(`\nCatalog apply: ${plan.category}  (plan ${plan.createdAt})`)
  const results = await applyPlan(plan)

  let applied = 0
  let already = 0
  let failed = 0
  for (const r of results) {
    if (r.status === 'applied') applied++
    else if (r.status === 'already-applied') already++
    else failed++
    console.log(`  ${r.status.padEnd(16)} ${r.itemGroupName}  (${r.squareItemId})`)
    if (r.error) console.log(`    error: ${r.error}`)
    if (r.newVariationIds) {
      for (const [sku, id] of Object.entries(r.newVariationIds)) console.log(`    ${sku} -> ${id}`)
    }
  }

  const resultPath = `${path}.result.json`
  writeFileSync(resultPath, JSON.stringify(results, null, 2))
  console.log(`\n  applied: ${applied}  already-applied: ${already}  failed: ${failed}`)
  console.log(`  results written to ${resultPath}\n`)

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
