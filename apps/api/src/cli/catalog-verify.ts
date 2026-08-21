import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CatalogPlan } from '../catalog/catalog-plan.js'
import { verifyPlan } from '../catalog/catalog-plan.js'

/**
 * `catalog-verify --plan <file>` -- re-reads every item in the plan from
 * Square and asserts the decision record's gate: `item_id` unchanged, the
 * legacy variation still present and unsellable, `present_at_location_ids`
 * intact, historical order lines (when the plan carries any) still
 * resolving, and -- the check that matters most -- every override in the
 * plan present on the new variations. Exits non-zero on any failure.
 */

function parseArgs(argv: string[]): { plan: string } {
  const idx = argv.indexOf('--plan')
  const plan = idx === -1 ? undefined : argv[idx + 1]
  if (!plan) throw new Error('usage: cli:catalog-verify -- --plan <file>')
  return { plan }
}

async function main(): Promise<void> {
  const { plan: planPath } = parseArgs(process.argv.slice(2))
  const path = resolve(process.cwd(), planPath)
  const plan: CatalogPlan = JSON.parse(readFileSync(path, 'utf8'))

  console.log(`\nCatalog verify: ${plan.category}  (plan ${plan.createdAt})`)
  const { ok, failures } = await verifyPlan(plan)

  if (ok) {
    console.log(`  OK -- ${plan.items.length} item(s) verified, 0 failures\n`)
    return
  }

  console.error(`  FAILED -- ${failures.length} failure(s):\n`)
  for (const f of failures) console.error(`    [${f.itemGroupName}] ${f.reason}`)
  console.error('')
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
