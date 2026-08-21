import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaService } from '../prisma/prisma.service.js'
import { buildPlan, applyPlan, verifyPlan } from '../catalog/catalog-plan.js'
import { runCategoriesSequentially } from '../catalog/catalog-migrate.js'

/**
 * `catalog-migrate --categories <comma-separated list>` -- runs
 * plan -> apply -> verify for each category in order, in one process, and
 * halts at the first one that fails (build guide guard 4). Every plan is
 * still written to disk exactly as `catalog-plan` would write it, so
 * what's reviewable on disk is still what ran -- this command does not
 * replace reading the diff for the categories ahead of time, it just
 * removes the need to babysit five separate manual invocations and to
 * remember to stop by hand if one fails partway through.
 *
 * Category names must match `Category.name` in the database exactly --
 * confirm with `SELECT name FROM "Category"` before running against a real
 * environment. Decision record Consequences item 12 gives the intended
 * production order (Scarves first, 29% of revenue, then Mittens, Socks,
 * Stuffies, Capes/Wraps); this command does not hardcode it, since the
 * exact category names differ between the seeded dev database and the real
 * catalog.
 */

function parseArgs(argv: string[]): { categories: string[] } {
  const idx = argv.indexOf('--categories')
  const raw = idx === -1 ? undefined : argv[idx + 1]
  if (!raw) throw new Error('usage: cli:catalog-migrate -- --categories <comma-separated category names>')
  const categories = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (categories.length === 0) throw new Error('usage: cli:catalog-migrate -- --categories <comma-separated category names>')
  return { categories }
}

async function main(): Promise<void> {
  const { categories } = parseArgs(process.argv.slice(2))
  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const { results, haltedAt } = await runCategoriesSequentially(categories, async (category) => {
      console.log(`\n=== ${category} ===`)

      const plan = await buildPlan(prisma, category)
      const planPath = resolve(process.cwd(), `catalog-plan-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`)
      writeFileSync(planPath, JSON.stringify(plan, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
      console.log(`  plan written to ${planPath}  (${plan.items.length} item group(s))`)

      const applyResults = await applyPlan(plan)
      writeFileSync(`${planPath}.result.json`, JSON.stringify(applyResults, null, 2))
      const failed = applyResults.filter((r) => r.status === 'failed')
      if (failed.length > 0) {
        return {
          ok: false,
          reason: `apply failed on ${failed.length} item(s): ${failed.map((f) => `${f.itemGroupName} (${f.error})`).join('; ')}`,
        }
      }
      console.log(`  applied: ${applyResults.filter((r) => r.status === 'applied').length}  already-applied: ${applyResults.filter((r) => r.status === 'already-applied').length}`)

      const verify = await verifyPlan(plan)
      if (!verify.ok) {
        return {
          ok: false,
          reason: `verify failed: ${verify.failures.map((f) => `[${f.itemGroupName}] ${f.reason}`).join('; ')}`,
        }
      }
      console.log(`  verified: ${plan.items.length} item group(s), 0 failures`)

      return { ok: true }
    })

    console.log('\n--- summary ---')
    for (const r of results) {
      console.log(`  ${r.status.padEnd(8)} ${r.category}${r.reason ? `\n           ${r.reason}` : ''}`)
    }

    if (haltedAt) {
      const remaining = categories.slice(categories.indexOf(haltedAt) + 1)
      console.error(`\nHALTED at "${haltedAt}". ${remaining.length > 0 ? `Never run: ${remaining.join(', ')}.` : ''}`)
      process.exitCode = 1
    } else {
      console.log(`\nAll ${categories.length} categories applied and verified.`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
