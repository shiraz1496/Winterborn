/**
 * Build guide guard 4 ("stop on first failure"). The restructure runs
 * several categories in sequence (decision record Consequences item 12:
 * Scarves first as 29% of revenue, then Mittens, Socks, Stuffies,
 * Capes/Wraps). If plan/apply/verify fails on any one of them, the run
 * must halt and report which category failed, rather than ploughing into
 * the next four against a catalog now in an unknown, only-partially
 * migrated state.
 *
 * `runCategoriesSequentially` is the control-flow primitive, kept separate
 * from any actual Square/Prisma call so it can be tested as pure
 * sequencing logic: given N categories where category K's `runOne` fails,
 * categories K+1..N must never be invoked. `cli/catalog-migrate.ts` wires
 * the real plan/apply/verify pipeline into `runOne`.
 */

export type CategoryRunResult = {
  category: string
  status: 'ok' | 'failed'
  reason?: string
}

export type CategoryRunOutcome = { ok: true } | { ok: false; reason: string }

export type RunCategoriesResult = {
  results: CategoryRunResult[]
  /** The category that failed, if the run halted before finishing. Absent if every category succeeded. */
  haltedAt?: string
}

export async function runCategoriesSequentially(
  categories: string[],
  runOne: (category: string) => Promise<CategoryRunOutcome>,
): Promise<RunCategoriesResult> {
  const results: CategoryRunResult[] = []

  for (const category of categories) {
    const outcome = await runOne(category)
    if (!outcome.ok) {
      results.push({ category, status: 'failed', reason: outcome.reason })
      return { results, haltedAt: category }
    }
    results.push({ category, status: 'ok' })
  }

  return { results }
}
