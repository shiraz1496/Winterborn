import { parse } from 'csv-parse/sync'

/**
 * Maps warehouse (Sortly) item groups to Square catalog items by name, and
 * parses the Square catalog CSV export into the shape `catalog-plan.ts`
 * needs (task-5 brief). The two systems never named the same product the
 * same way -- `Standard Scarves | Stripes` against `Scarf (Stripes)`,
 * `Flip Mitts (Glittens)` against `Mittens (Flip Mitts)` -- so this is a
 * fuzzy join, not an exact one, and it is scored, reported, and left for
 * a human to confirm rather than applied blindly.
 */

export type JoinCandidate = {
  sortlyGroup: string
  squareItemName: string
  score: number
  reason: string
}

export type JoinResult = {
  matched: JoinCandidate[]
  unmatchedSortly: string[]
  unmatchedSquare: string[]
}

/**
 * A pair scoring at or above this on the token-overlap measure below is
 * offered as a match. Chosen so that two names sharing most of their
 * meaningful tokens (e.g. "flip"/"mitts" out of three tokens each side)
 * clear it, while two names sharing only structural words ("only", "in")
 * do not -- see the stopword list, which is what actually keeps that case
 * out, not the threshold value itself.
 */
const ACCEPT_THRESHOLD = 0.4

/**
 * Structural words common enough in item names to carry no matching
 * signal on their own. Without this list, "Only In Sortly" and "Only In
 * Square" would score high on shared tokens ("only", "in") despite naming
 * unrelated things -- exactly the false-positive a real join must not
 * produce, since a wrong join sends the wrong stock to the wrong market.
 */
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'w', 'with', 'and', 'or', 'for', 'only', 'set'])

/**
 * Lowercases, drops the segment before the last "|" (Sortly's own
 * "Group | Pattern" convention -- the group prefix is shared across many
 * unrelated patterns and would otherwise swamp the signal), strips a
 * `[Brand]` bracketed qualifier entirely (e.g. "[Fraas]" -- a resale-brand
 * tag, not part of the product's identity), turns remaining punctuation
 * into spaces (so "Scarf (Stripes)" keeps "stripes" as a token rather than
 * losing it), and drops stopwords.
 */
function normaliseTokens(raw: string): string[] {
  let s = raw.toLowerCase()
  const pipeIndex = s.lastIndexOf('|')
  if (pipeIndex !== -1) s = s.slice(pipeIndex + 1)
  s = s.replace(/\[[^\]]*\]/g, ' ')
  s = s.replace(/[^a-z0-9]+/g, ' ')
  return s
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
}

/** Dice coefficient over token sets: 2 * |intersection| / (|A| + |B|). */
function similarity(a: string[], b: string[]): { score: number; shared: string[] } {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size === 0 || setB.size === 0) return { score: 0, shared: [] }
  const shared = [...setA].filter((t) => setB.has(t))
  return { score: (2 * shared.length) / (setA.size + setB.size), shared }
}

/**
 * Scores every (sortlyGroup, squareItem) pair and keeps the ones at or
 * above `ACCEPT_THRESHOLD` as `matched`. Deliberately does **not** reduce
 * to one best match per group: a group with more than one candidate above
 * threshold stays ambiguous in the output (every candidate present, same
 * `sortlyGroup`) so the caller can flag it for manual resolution instead
 * of silently picking one. `unmatchedSortly`/`unmatchedSquare` are names
 * with zero candidates above threshold on either side -- reported
 * honestly rather than forced, per the brief: no clean bijection exists
 * between Sortly's 12 Sport Socks pattern groups and Square's single
 * `Socks (Sport)` item, and a join claiming one would be wrong.
 */
export function proposeJoins(sortlyGroups: string[], squareItems: string[]): JoinResult {
  const matched: JoinCandidate[] = []
  const matchedSortly = new Set<string>()
  const matchedSquare = new Set<string>()

  for (const group of sortlyGroups) {
    const groupTokens = normaliseTokens(group)

    // Score every Square item for this group, then keep only the ones
    // tied for the group's own best score (exact equality -- these are
    // Dice coefficients over small integer-sized token sets, so a
    // genuine tie comes out bit-identical, not merely close). A group
    // with one clear best candidate (e.g. "Tech Socks" scoring 1.00
    // against "Socks (Tech)" while a same-category "Socks (Dress)" only
    // manages 0.50 on the shared word "socks") gets exactly that one
    // candidate here, not every item that happened to clear the
    // threshold. A genuine tie (two different groups both naming a
    // "Stripes" pattern, one a scarf, one a sock, both scoring the same
    // against the single Square item "Scarf (Stripes)") still comes
    // through as more than one candidate for the group, which is what
    // lets the caller flag real "more than one Square item" ambiguity
    // instead of drowning every group with three matches in noise from
    // weaker also-rans.
    let bestScore = 0
    const scored: Array<{ item: string; score: number; shared: string[] }> = []
    for (const item of squareItems) {
      const itemTokens = normaliseTokens(item)
      const { score, shared } = similarity(groupTokens, itemTokens)
      if (score < ACCEPT_THRESHOLD) continue
      scored.push({ item, score, shared })
      if (score > bestScore) bestScore = score
    }

    for (const { item, score, shared } of scored) {
      if (score !== bestScore) continue
      matched.push({
        sortlyGroup: group,
        squareItemName: item,
        score: Math.round(score * 100) / 100,
        reason: `shared token(s): ${shared.join(', ')}`,
      })
      matchedSortly.add(group)
      matchedSquare.add(item)
    }
  }

  return {
    matched,
    unmatchedSortly: sortlyGroups.filter((g) => !matchedSortly.has(g)),
    unmatchedSquare: squareItems.filter((i) => !matchedSquare.has(i)),
  }
}

// ---------------------------------------------------------------------------
// Square catalog CSV parsing. `catalog-item-library-export.csv` is a
// variation-level export -- one row per Square ITEM_VARIATION, item fields
// (Item Name, Archived, ...) repeated on every row for that item.
// ---------------------------------------------------------------------------

const LOCATION_NAMES = [
  'Atlanta',
  'Aurora',
  'Baltimore',
  'Boston (Snowport)',
  'Carmel',
  'Chicago (Daley Plaza)',
  'Chicago (Wrigley)',
  'Cullman, AL',
  'Denver',
  'Grand Rapids',
  'Philadelphia',
  'Savannah, GA',
  'Seattle',
  'Washington DC',
] as const

export type SquareCsvVariationRow = {
  token: string
  itemName: string
  variationName: string
  archived: boolean
  basePriceCents?: number
  /** Location names where "Enabled <Location>" is "Y" for this row. */
  enabledLocations: string[]
  /** Location name -> override price in cents, only where it differs from the base price. */
  locationOverrides: Record<string, number>
}

function parseDollarsToCents(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return undefined
  return Math.round(n * 100)
}

/** Parses the raw CSV text into one row per Square variation. */
export function parseSquareCatalogCsv(csvText: string): SquareCsvVariationRow[] {
  const records: Record<string, string>[] = parse(csvText, { columns: true, skip_empty_lines: true })

  return records.map((row) => {
    const basePriceCents = parseDollarsToCents(row['Price'])
    const enabledLocations: string[] = []
    const locationOverrides: Record<string, number> = {}

    for (const location of LOCATION_NAMES) {
      if ((row[`Enabled ${location}`] ?? '').trim() === 'Y') enabledLocations.push(location)
      const overrideCents = parseDollarsToCents(row[`Price ${location}`])
      if (overrideCents !== undefined && overrideCents !== basePriceCents) {
        locationOverrides[location] = overrideCents
      }
    }

    return {
      token: row['Token'] ?? '',
      itemName: row['Item Name'] ?? '',
      variationName: row['Variation Name'] ?? '',
      archived: (row['Archived'] ?? '').trim() === 'Y',
      basePriceCents,
      enabledLocations,
      locationOverrides,
    }
  })
}

/** Distinct, sorted item names among the non-archived rows. */
export function activeSquareItemNames(rows: SquareCsvVariationRow[]): string[] {
  return [...new Set(rows.filter((r) => !r.archived).map((r) => r.itemName))].sort((a, b) => a.localeCompare(b))
}
