import { PrismaService } from '../prisma/prisma.service.js'
import { assignFamily } from '../catalog/family-assigner.js'
import { Prisma } from '@prisma/client'
import type { FamilyAssignmentSource } from '@prisma/client'

const UNIQUE_VIOLATION = 'P2002'

/**
 * Reassigns every `ColourVariant` from the per-category `Unassigned`
 * placeholder Task 2 leaves it in to its real till family, using the
 * three-pass derivation in `family-assigner.ts`. Spec §6.3, task-3 brief.
 *
 * Scope: only the 248 distinct `sortlyName` values are colour values at
 * all. `ColourVariant.sortlyName` is null on rows where the Sortly export
 * carried no `Color` attribute (colourVariantIdentity fell back to Style or
 * the item group name — 56 real rows, mostly Toys, e.g. "Bear", "Alpaca w/
 * Blue Pom Hat"). Running the colour lexicon against arbitrary style text
 * would risk exactly the over-reach the brief warns about ("Alpaca w/ Blue
 * Pom Hat" contains the word "Blue" but is not a blue product family), so
 * those rows are left untouched — they stay in `Unassigned`, out of scope
 * for this task.
 *
 * Idempotent: reruns produce the same assignment for the same
 * `sortlyName` (family-assigner is a pure function) and Prisma's `update`
 * has no create-once effect, so running this twice does nothing new the
 * second time beyond redundant identical writes.
 */

type Row = {
  id: string
  sortlyName: string | null
  colourFamily: { categoryId: string; category: { name: string } }
}

type Counts = {
  /** Row-level: one per `ColourVariant`, the unit the DB actually updates. */
  lexical: number
  synonym: number
  residual: number
  outOfScope: number
}

type RunResult = {
  counts: Counts
  /**
   * Distinct `sortlyName` values by source — matches the brief's framing
   * ("248 distinct colour values"), since the same colour text can back a
   * `ColourVariant` row in more than one category.
   */
  distinctLexical: Set<string>
  distinctSynonym: Set<string>
  /** Distinct residual sortlyName values — the human review queue. */
  residualValues: string[]
  /** Category name -> set of real (non-Unassigned) family names now in use. */
  familySetsByCategory: Map<string, Set<string>>
}

async function run(prisma: PrismaService): Promise<RunResult> {
  const rows: Row[] = await prisma.colourVariant.findMany({
    include: { colourFamily: { include: { category: true } } },
  })

  const counts: Counts = { lexical: 0, synonym: 0, residual: 0, outOfScope: 0 }
  const distinctLexical = new Set<string>()
  const distinctSynonym = new Set<string>()
  const residualValues = new Set<string>()
  const familySetsByCategory = new Map<string, Set<string>>()
  // categoryId::familyName -> ColourFamily.id, so repeated categories/families
  // within one run cost one lookup-or-create, not one per variant.
  const familyIdCache = new Map<string, string>()

  for (const row of rows) {
    if (!row.sortlyName) {
      counts.outOfScope++
      continue
    }

    const categoryId = row.colourFamily.categoryId
    const categoryName = row.colourFamily.category.name

    const assignment = assignFamily(row.sortlyName)
    if (!assignment) {
      counts.residual++
      residualValues.add(row.sortlyName)
      continue
    }

    const cacheKey = `${categoryId}::${assignment.family}`
    let familyId = familyIdCache.get(cacheKey)
    if (!familyId) {
      const existing = await prisma.colourFamily.findUnique({
        where: { categoryId_name: { categoryId, name: assignment.family } },
      })
      if (existing) {
        familyId = existing.id
      } else {
        const maxOrder = await prisma.colourFamily.aggregate({
          where: { categoryId },
          _max: { displayOrder: true },
        })
        const created = await prisma.colourFamily.create({
          data: {
            categoryId,
            name: assignment.family,
            displayOrder: (maxOrder._max.displayOrder ?? 0) + 1,
          },
        })
        familyId = created.id
      }
      familyIdCache.set(cacheKey, familyId)
    }

    try {
      await prisma.colourVariant.update({
        where: { id: row.id },
        data: {
          colourFamilyId: familyId,
          familyAssignmentSource: assignment.source as FamilyAssignmentSource,
          familyConfidence: assignment.confidence,
        },
      })
    } catch (err) {
      // Two distinct ColourVariant rows -- different category, or a name
      // collision the raw export never intended to be the same physical
      // item -- can lexically resolve to the same (family, name) pair.
      // ColourVariant is unique on (colourFamilyId, name), so the second
      // one to arrive cannot silently move in on top of the first: that
      // would merge two different warehouse SKUs' colour identity. Fall
      // back to the residual queue instead of crashing the whole run --
      // exactly where a value the lexicon can't safely place already goes
      // (see assignFamily's docstring) -- so a human decides on
      // /admin/colours rather than the mismatch being decided by import
      // order.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        counts.residual++
        residualValues.add(row.sortlyName)
        continue
      }
      throw err
    }

    if (assignment.source === 'LEXICAL') {
      counts.lexical++
      distinctLexical.add(row.sortlyName)
    } else if (assignment.source === 'SYNONYM') {
      counts.synonym++
      distinctSynonym.add(row.sortlyName)
    }

    if (!familySetsByCategory.has(categoryName)) familySetsByCategory.set(categoryName, new Set())
    familySetsByCategory.get(categoryName)!.add(assignment.family)
  }

  return {
    counts,
    distinctLexical,
    distinctSynonym,
    residualValues: [...residualValues].sort((a, b) => a.localeCompare(b)),
    familySetsByCategory,
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const { counts, distinctLexical, distinctSynonym, residualValues, familySetsByCategory } = await run(prisma)
    const distinctTotal = distinctLexical.size + distinctSynonym.size + residualValues.length

    console.log('\nColour family assignment')
    console.log(`  ColourVariant rows: lexical ${counts.lexical}, synonym ${counts.synonym}, `)
    console.log(`    residual ${counts.residual}, out of scope ${counts.outOfScope} (no Sortly Color attribute)`)
    console.log(
      `  distinct colour values (of ${distinctTotal}): lexical ${distinctLexical.size}, ` +
        `synonym ${distinctSynonym.size}, residual ${residualValues.length}`,
    )

    console.log(`\n  residual queue (${residualValues.length}) — needs a human looking at the archived photo:`)
    for (const v of residualValues) console.log(`    - ${v}`)

    console.log('\n  family sets by category:')
    for (const [category, families] of [...familySetsByCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sorted = [...families].sort((a, b) => a.localeCompare(b))
      const flag = sorted.length > 12 ? '  <-- exceeds spec §6.1 target of 6-12' : ''
      console.log(`    ${category.padEnd(16)} (${sorted.length}) ${sorted.join(', ')}${flag}`)
    }
    console.log('')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
