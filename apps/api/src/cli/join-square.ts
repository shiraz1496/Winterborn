import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaService } from '../prisma/prisma.service.js'
import { proposeJoins, parseSquareCatalogCsv, activeSquareItemNames } from '../catalog/square-join.js'
import type { JoinCandidate } from '../catalog/square-join.js'

/**
 * Maps `ItemGroup` (warehouse/Sortly) names to Square catalog item names
 * (task-5 brief). Does **not** auto-apply the join: it writes a reviewable
 * report to stdout and persists `ItemGroup.squareItemId` only for a match
 * that is unambiguous on *both* sides -- exactly one Square item scores
 * above threshold for that group, and that Square item is not also the
 * top candidate for some other group. Everything else -- unmatched names
 * and ambiguous matches -- is listed for a human to resolve by hand. A
 * wrong join silently sends the wrong stock to the wrong market, so
 * forcing one here would be worse than leaving it open.
 *
 * `ItemGroup.squareItemId` caveat, stated plainly because it is easy to
 * misread later: the CSV export is variation-level (per the flat-item
 * migration decision record, "Item IDs are not in the CSV export -- the
 * Token column is variation-level"), and the sandbox merchant used for
 * Task 5's plan/apply/verify cycle is a disjoint environment from the
 * real client catalog this CSV describes. Neither source has a genuine
 * Square *item* ID to write here. What is persisted is the `Token` of the
 * first variation row for the matched item name -- a real, stable,
 * unique value from the export, and the closest available stand-in until
 * a production Square token exists and the real item IDs can be resolved
 * via `ListCatalogObjects`/`SearchCatalogObjects`. This is a deliberate,
 * documented deviation, not an oversight.
 */

const DEFAULT_CSV_PATH = '../../data/catalog-item-library-export.csv'

function parseArgs(argv: string[]): { file: string } {
  const idx = argv.indexOf('--file')
  const file = idx === -1 ? DEFAULT_CSV_PATH : (argv[idx + 1] ?? DEFAULT_CSV_PATH)
  return { file }
}

function fmtScore(score: number): string {
  return score.toFixed(2)
}

async function main(): Promise<void> {
  const { file } = parseArgs(process.argv.slice(2))
  const path = resolve(process.cwd(), file)
  const csvText = readFileSync(path, 'utf8')

  const squareRows = parseSquareCatalogCsv(csvText)
  const squareItemNames = activeSquareItemNames(squareRows)

  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const itemGroups = await prisma.itemGroup.findMany({ orderBy: { name: 'asc' } })
    const sortlyGroupNames = itemGroups.map((g) => g.name)
    const nameToGroupId = new Map(itemGroups.map((g) => [g.name, g.id] as const))

    // Representative token per Square item name: the first variation row
    // for that item, in file order. See the module docstring caveat above.
    const representativeToken = new Map<string, string>()
    for (const row of squareRows) {
      if (!representativeToken.has(row.itemName)) representativeToken.set(row.itemName, row.token)
    }

    const { matched, unmatchedSortly, unmatchedSquare } = proposeJoins(sortlyGroupNames, squareItemNames)

    const bySortly = new Map<string, JoinCandidate[]>()
    const bySquare = new Map<string, JoinCandidate[]>()
    for (const m of matched) {
      if (!bySortly.has(m.sortlyGroup)) bySortly.set(m.sortlyGroup, [])
      bySortly.get(m.sortlyGroup)!.push(m)
      if (!bySquare.has(m.squareItemName)) bySquare.set(m.squareItemName, [])
      bySquare.get(m.squareItemName)!.push(m)
    }

    const clean: JoinCandidate[] = []
    const ambiguous: JoinCandidate[] = []
    for (const m of matched) {
      const groupCandidates = bySortly.get(m.sortlyGroup)!
      const squareCandidates = bySquare.get(m.squareItemName)!
      if (groupCandidates.length === 1 && squareCandidates.length === 1) {
        clean.push(m)
      } else {
        ambiguous.push(m)
      }
    }

    let persisted = 0
    for (const m of clean) {
      const groupId = nameToGroupId.get(m.sortlyGroup)
      const token = representativeToken.get(m.squareItemName)
      if (!groupId || !token) continue
      await prisma.itemGroup.update({ where: { id: groupId }, data: { squareItemId: token } })
      persisted++
    }

    console.log('\nSquare join report')
    console.log(`  Sortly groups:        ${sortlyGroupNames.length}`)
    console.log(`  active Square items:  ${squareItemNames.length}`)

    console.log(`\n  clean matches, persisted to ItemGroup.squareItemId (${clean.length}):`)
    for (const m of [...clean].sort((a, b) => a.sortlyGroup.localeCompare(b.sortlyGroup))) {
      console.log(`    [${fmtScore(m.score)}] ${m.sortlyGroup}  ->  ${m.squareItemName}  (${m.reason})`)
    }

    const ambiguousGroups = new Set(ambiguous.map((m) => m.sortlyGroup))
    console.log(
      `\n  ambiguous -- NOT persisted, needs manual resolution (${ambiguousGroups.size} group(s), ${ambiguous.length} candidate pair(s)):`,
    )
    for (const groupName of [...ambiguousGroups].sort((a, b) => a.localeCompare(b))) {
      console.log(`    ${groupName}`)
      for (const m of bySortly.get(groupName)!.sort((a, b) => b.score - a.score)) {
        console.log(`      [${fmtScore(m.score)}] -> ${m.squareItemName}  (${m.reason})`)
      }
    }

    console.log(`\n  unmatched Sortly groups (${unmatchedSortly.length}):`)
    for (const g of unmatchedSortly) console.log(`    - ${g}`)

    console.log(`\n  unmatched Square items (${unmatchedSquare.length}):`)
    for (const s of unmatchedSquare) console.log(`    - ${s}`)

    console.log(`\n  persisted: ${persisted}  clean: ${clean.length}  ambiguous groups: ${ambiguousGroups.size}`)
    console.log('')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
