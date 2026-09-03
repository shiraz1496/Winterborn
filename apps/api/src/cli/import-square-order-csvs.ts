import './load-env.js'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'csv-parse/sync'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerService } from '../ledger/ledger.service.js'

/**
 * Import historical Square order CSVs into `LedgerEvent` as SALEs (with
 * paired INTAKEs so market on-hand stays untouched).
 *
 * The CSVs were exported from Square's dashboard and dropped into
 * `apps/api/data/square-order-csv/`. Each row is one line item from one
 * order:
 *
 *   Order Date | Fulfilment Location | Item Quantity | Item Name |
 *   Item Variation | ... | Receipt number
 *
 * The catalog names in Square drift from our own — colour labels differ,
 * item names include parenthetical asides, etc. — so this CLI fuzzy-
 * matches each row to a WarehouseVariant by:
 *
 *   1. `Item Name` → ItemGroup (via token + bigram similarity)
 *   2. `Item Variation` → one of that ItemGroup's WarehouseVariants
 *      (scored against colour + size)
 *
 * Rows that don't clear the confidence threshold are skipped and logged
 * to `unmatched.csv` in the input directory so the operator can review
 * (and either fix the catalog or ignore).
 *
 * Every SALE is paired with an INTAKE 1ms earlier at the same market —
 * the same trick `backfill-square-sales.ts` uses. Net effect on today's
 * derived on-hand is zero, but the SALE stays visible to the
 * suggestion engine (which filters on type='SALE').
 *
 * Dry-run by default. Pass `--apply` to write. Rerunning is safe —
 * idempotency keys are derived from `{filename}:{lineNumber}` so the
 * ledger dedupes.
 *
 * Usage:
 *   pnpm --filter api cli:import-square-order-csvs
 *   pnpm --filter api cli:import-square-order-csvs -- --apply
 *   pnpm --filter api cli:import-square-order-csvs -- --dir custom/path --min-score 0.65 --apply
 */

const DEFAULT_DIR = 'data/square-order-csv'
// Threshold tuned against real CSVs: DB names carry extra descriptors
// ("Standard Scarves | Plaids" vs CSV "Scarf (Plaids)") that cap symmetric
// similarity around 0.4-0.7. csvCoverage-weighted scoring pushes clean
// matches back above 0.55 without letting truly wrong items slip through.
const DEFAULT_MIN_SCORE = 0.55

// ------------------------------ Fuzzy matcher ------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip trailing plural/possessive so "scarves"/"scarf", "capes"/"cape",
 *  "beanies"/"beanie" collapse to the same token. Also strips a leading
 *  "w"/"w/" and treats "and" as a stopword since our catalog uses "|" and
 *  "&" interchangeably. Domain-specific but safe: it only ever shortens
 *  tokens, never invents new characters. */
function stem(token: string): string {
  if (token === 'and' || token === 'w' || token === 'the' || token === 'a') return ''
  // scarves → scarf, gloves → glof (fine — CSV & DB both stem the same)
  if (token.length > 3 && token.endsWith('ves')) return token.slice(0, -3) + 'f'
  // beanies → beanie (drop trailing 's') so it matches CSV "beanie"
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -1)
  // capes → cape, socks → sock, cards → card (single trailing s)
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  return token
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .map(stem)
    .filter(Boolean)
}

function bigrams(s: string): Set<string> {
  const n = normalize(s).replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2))
  return out
}

function diceBigrams(a: string, b: string): number {
  const ba = bigrams(a)
  const bb = bigrams(b)
  if (ba.size === 0 || bb.size === 0) return 0
  let inter = 0
  for (const x of ba) if (bb.has(x)) inter++
  return (2 * inter) / (ba.size + bb.size)
}

/** Asymmetric score in [0,1] favouring CSV-side coverage.
 *
 *  The DB item groups tend to carry extra qualifier tokens (year, family
 *  label, notes) that the CSV doesn't. Symmetric similarity punishes that.
 *  csvCoverage asks: "how much of the CSV's item name shows up in the DB
 *  name?" — the right question, since the CSV is the terser side. Bigram
 *  dice keeps a safety net for typos and single-word items.
 *  dbCoverage carries a small weight so that a CSV item that's a subset
 *  of TWO different DB names still prefers the shorter, more specific one.
 */
function fuzzyScore(csv: string, db: string): number {
  const csvTokens = new Set(tokens(csv))
  const dbTokens = new Set(tokens(db))
  if (csvTokens.size === 0 || dbTokens.size === 0) return 0
  let inter = 0
  for (const t of csvTokens) if (dbTokens.has(t)) inter++
  const csvCoverage = inter / csvTokens.size
  const dbCoverage = inter / dbTokens.size
  const bigramSim = diceBigrams(csv, db)
  return 0.6 * csvCoverage + 0.15 * dbCoverage + 0.25 * bigramSim
}

// ------------------------------ Types ------------------------------

interface Args {
  dir: string
  apply: boolean
  minScore: number
}

interface WvCandidate {
  wvId: string
  variationId: string
  itemGroupId: string
  itemGroupName: string
  colourFamilyName: string
  colourVariantName: string
  sizeOptionName: string
  /** cached lowercased variation label: "solid color regular" */
  variationLabel: string
}

interface CatalogIndex {
  /** itemGroupId → { name, wvs[] } */
  groups: Map<string, { name: string; wvs: WvCandidate[] }>
  /** Every candidate WV so we can walk them when picking a colour+size. */
  allWvs: WvCandidate[]
}

interface LocationEntry {
  id: string
  name: string
}

// ------------------------------ Args ------------------------------

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply')
  const dir = pick(argv, '--dir') ?? DEFAULT_DIR
  const rawScore = pick(argv, '--min-score')
  const minScore = rawScore ? Number(rawScore) : DEFAULT_MIN_SCORE
  if (!Number.isFinite(minScore) || minScore <= 0 || minScore > 1) {
    throw new Error(`--min-score must be a number in (0, 1]. Got: ${rawScore}`)
  }
  return { dir, apply, minScore }
}

function pick(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  return argv[i + 1]
}

// ------------------------------ CSV row shape ------------------------------

interface SquareCsvRow {
  'Order Date': string
  'Fulfilment Location': string
  'Item Quantity': string
  'Item Name': string
  'Item Variation': string
  'Receipt number': string
}

// ------------------------------ Main ------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const prisma = new PrismaService()
  await prisma.$connect()
  const ledger = new LedgerService(prisma)

  try {
    console.log('\nSquare order CSV import')
    console.log(`  dir:       ${args.dir}`)
    console.log(`  mode:      ${args.apply ? 'APPLY (writes to ledger)' : 'DRY RUN (no writes)'}`)
    console.log(`  min score: ${args.minScore}`)

    if (!existsSync(args.dir)) {
      console.error(`\n  directory not found: ${args.dir}`)
      process.exitCode = 1
      return
    }
    const csvFiles = readdirSync(args.dir)
      .filter((f) => f.toLowerCase().endsWith('.csv') && f !== 'unmatched.csv')
      .sort()
    if (csvFiles.length === 0) {
      console.log('\n  no CSV files found — nothing to do.')
      return
    }
    console.log(`  files:     ${csvFiles.length}`)

    // --- Load catalog + locations into memory ---
    const [locations, wvs] = await Promise.all([
      prisma.location.findMany({
        where: { kind: 'MARKET' },
        select: { id: true, name: true },
      }),
      prisma.warehouseVariant.findMany({
        select: {
          id: true,
          variationId: true,
          itemGroupId: true,
          itemGroup: { select: { name: true } },
          colourVariant: {
            select: {
              name: true,
              colourFamily: { select: { name: true } },
            },
          },
          sizeOption: { select: { name: true } },
        },
      }),
    ])

    if (locations.length === 0) {
      console.error('\n  no MARKET locations in DB — nothing to import against. Run cli:seed-locations first.')
      process.exitCode = 1
      return
    }

    const catalog = buildCatalogIndex(wvs)
    console.log(`  catalog:   ${catalog.groups.size} item groups / ${catalog.allWvs.length} warehouse variants`)
    console.log(`  markets:   ${locations.length}`)

    // --- Caches: fuzzy-match once per unique CSV name, not per row ---
    const locationCache = new Map<string, LocationEntry | null>()
    interface ItemGroupHit { itemGroupId: string | null; bestName: string; bestScore: number }
    const itemGroupCache = new Map<string, ItemGroupHit>()
    const wvCache = new Map<string, string | null>() // `${itemGroupId}|${variationLabel}` → wvId

    let totalRows = 0
    let salesWritten = 0
    let intakesWritten = 0
    let dedupedSales = 0
    let dedupedIntakes = 0
    let unmatchedItem = 0
    let unmatchedLocation = 0
    let skippedInvalid = 0
    const unmatchedRows: string[] = []
    unmatchedRows.push(
      [
        'file',
        'line',
        'reason',
        'item_name',
        'item_variation',
        'fulfilment_location',
        'order_date',
        'best_item_group_match',
        'best_item_group_score',
      ].join(','),
    )

    for (const filename of csvFiles) {
      const path = join(args.dir, filename)
      const text = readFileSync(path, 'utf8')
      let rows: SquareCsvRow[]
      try {
        rows = parse(text, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
        }) as SquareCsvRow[]
      } catch (err) {
        console.error(`  ${filename}: parse failed — ${(err as Error).message}. Skipping.`)
        continue
      }
      if (rows.length === 0) {
        console.log(`  ${filename}: 0 rows`)
        continue
      }

      let fileSales = 0
      let fileIntakes = 0
      let fileDedupedSales = 0
      let fileDedupedIntakes = 0
      let fileUnmatched = 0
      let fileSkipped = 0

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!
        // Row number in the file (1-based, +1 for header) — used as the
        // stable idempotency suffix so rerunning the same CSV dedupes.
        const lineNumber = i + 2
        totalRows++

        const itemName = row['Item Name']?.trim() ?? ''
        const itemVariation = row['Item Variation']?.trim() ?? ''
        const csvLocation = row['Fulfilment Location']?.trim() ?? ''
        const qtyRaw = row['Item Quantity']?.trim() ?? ''
        const dateRaw = row['Order Date']?.trim() ?? ''

        const qty = Number(qtyRaw)
        if (!itemName || !csvLocation || !Number.isFinite(qty) || qty <= 0) {
          skippedInvalid++
          fileSkipped++
          continue
        }

        const occurredAt = parseSquareDate(dateRaw)
        if (!occurredAt) {
          skippedInvalid++
          fileSkipped++
          continue
        }

        // --- Location ---
        let locEntry: LocationEntry | null
        if (locationCache.has(csvLocation)) {
          locEntry = locationCache.get(csvLocation)!
        } else {
          locEntry = pickBestLocation(csvLocation, locations, args.minScore)
          locationCache.set(csvLocation, locEntry)
        }
        if (!locEntry) {
          unmatchedLocation++
          fileUnmatched++
          unmatchedRows.push(csvEscape([
            filename,
            String(lineNumber),
            'no location match',
            itemName,
            itemVariation,
            csvLocation,
            dateRaw,
            '',
            '',
          ]))
          continue
        }

        // --- ItemGroup ---
        let hit = itemGroupCache.get(itemName)
        if (!hit) {
          const match = pickBestItemGroup(itemName, catalog, args.minScore)
          hit = {
            itemGroupId: match.passed ? match.itemGroupId : null,
            bestName: match.name,
            bestScore: match.score,
          }
          itemGroupCache.set(itemName, hit)
        }
        const itemGroupId = hit.itemGroupId
        const bestScore = hit.bestScore
        const bestName = hit.bestName
        if (!itemGroupId) {
          unmatchedItem++
          fileUnmatched++
          unmatchedRows.push(csvEscape([
            filename,
            String(lineNumber),
            'no item-group match',
            itemName,
            itemVariation,
            csvLocation,
            dateRaw,
            bestName,
            bestScore.toFixed(3),
          ]))
          continue
        }

        // --- WarehouseVariant (colour + size) ---
        const wvKey = `${itemGroupId}|${normalize(itemVariation)}`
        let wvId: string | null
        if (wvCache.has(wvKey)) {
          wvId = wvCache.get(wvKey)!
        } else {
          wvId = pickBestWv(itemGroupId, itemVariation, catalog)
          wvCache.set(wvKey, wvId)
        }
        if (!wvId) {
          // Item Group matched but no WVs at all — extremely unusual. Log
          // and skip; the group is present but has no sellable variants.
          unmatchedItem++
          fileUnmatched++
          unmatchedRows.push(csvEscape([
            filename,
            String(lineNumber),
            'item group has no warehouse variants',
            itemName,
            itemVariation,
            csvLocation,
            dateRaw,
            bestName,
            bestScore.toFixed(3),
          ]))
          continue
        }

        const variationId = catalog.allWvs.find((c) => c.wvId === wvId)!.variationId

        const idempotencySuffix = `${filename}:${lineNumber}`
        const saleKey = `csv-sale:${idempotencySuffix}`
        const intakeKey = `csv-intake:${idempotencySuffix}`
        const intakeAt = new Date(occurredAt.getTime() - 1)

        if (args.apply) {
          const intakeRes = await ledger.append({
            type: 'INTAKE',
            locationId: locEntry.id,
            variationId,
            warehouseVariantId: wvId,
            quantity: qty,
            occurredAt: intakeAt,
            source: 'SCRIPT',
            sourceRef: 'import-square-order-csvs',
            idempotencyKey: intakeKey,
            note: 'synthetic balance for historical SALE (csv import)',
          })
          if (intakeRes.created) { intakesWritten++; fileIntakes++ } else { dedupedIntakes++; fileDedupedIntakes++ }

          const saleRes = await ledger.append({
            type: 'SALE',
            locationId: locEntry.id,
            variationId,
            warehouseVariantId: wvId,
            quantity: -qty,
            occurredAt,
            source: 'SCRIPT',
            sourceRef: 'import-square-order-csvs',
            idempotencyKey: saleKey,
          })
          if (saleRes.created) { salesWritten++; fileSales++ } else { dedupedSales++; fileDedupedSales++ }
        } else {
          salesWritten++
          intakesWritten++
          fileSales++
          fileIntakes++
        }
      }

      console.log(
        `  ${filename}: ${rows.length} rows → ` +
          (args.apply
            ? `${fileSales} sale + ${fileIntakes} intake written (${fileDedupedSales} + ${fileDedupedIntakes} deduped), ${fileUnmatched} unmatched, ${fileSkipped} skipped`
            : `${fileSales} sale + ${fileIntakes} intake WOULD write, ${fileUnmatched} unmatched, ${fileSkipped} skipped`),
      )
    }

    // --- Unmatched report ---
    const unmatchedPath = join(args.dir, 'unmatched.csv')
    if (unmatchedRows.length > 1) {
      writeFileSync(unmatchedPath, unmatchedRows.join('\n'))
      console.log(`\n  unmatched report: ${unmatchedPath} (${unmatchedRows.length - 1} row(s))`)
    }

    console.log('\nSummary')
    console.log(`  ${totalRows} row(s) scanned across ${csvFiles.length} file(s)`)
    if (args.apply) {
      console.log(`  ${salesWritten} SALE + ${intakesWritten} INTAKE row(s) appended`)
      console.log(`  ${dedupedSales} SALE + ${dedupedIntakes} INTAKE deduped (already present)`)
    } else {
      console.log(`  ${salesWritten} SALE + ${intakesWritten} INTAKE row(s) would be appended`)
    }
    console.log(`  ${unmatchedItem} row(s) unmatched by item name`)
    console.log(`  ${unmatchedLocation} row(s) unmatched by fulfilment location`)
    console.log(`  ${skippedInvalid} row(s) skipped (missing name/location/qty/date)`)
    if (!args.apply) {
      console.log('\nDry run — pass --apply to write.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

// ------------------------------ Helpers ------------------------------

function buildCatalogIndex(
  wvs: Array<{
    id: string
    variationId: string
    itemGroupId: string
    itemGroup: { name: string }
    colourVariant: { name: string; colourFamily: { name: string } }
    sizeOption: { name: string }
  }>,
): CatalogIndex {
  const groups = new Map<string, { name: string; wvs: WvCandidate[] }>()
  const allWvs: WvCandidate[] = []
  for (const wv of wvs) {
    const candidate: WvCandidate = {
      wvId: wv.id,
      variationId: wv.variationId,
      itemGroupId: wv.itemGroupId,
      itemGroupName: wv.itemGroup.name,
      colourFamilyName: wv.colourVariant.colourFamily.name,
      colourVariantName: wv.colourVariant.name,
      sizeOptionName: wv.sizeOption.name,
      variationLabel: normalize(
        [wv.colourVariant.colourFamily.name, wv.colourVariant.name, wv.sizeOption.name].join(' '),
      ),
    }
    allWvs.push(candidate)
    const g = groups.get(wv.itemGroupId)
    if (g) {
      g.wvs.push(candidate)
    } else {
      groups.set(wv.itemGroupId, { name: wv.itemGroup.name, wvs: [candidate] })
    }
  }
  return { groups, allWvs }
}

function pickBestLocation(
  csvName: string,
  locations: LocationEntry[],
  minScore: number,
): LocationEntry | null {
  let best: LocationEntry | null = null
  let bestScore = 0
  for (const l of locations) {
    const s = fuzzyScore(csvName, l.name)
    if (s > bestScore) {
      bestScore = s
      best = l
    }
  }
  return bestScore >= minScore ? best : null
}

function pickBestItemGroup(
  csvName: string,
  catalog: CatalogIndex,
  minScore: number,
): { itemGroupId: string; name: string; score: number; passed: boolean } {
  let bestId = ''
  let bestName = ''
  let bestScore = 0
  for (const [id, g] of catalog.groups) {
    const s = fuzzyScore(csvName, g.name)
    if (s > bestScore) {
      bestScore = s
      bestId = id
      bestName = g.name
    }
  }
  return { itemGroupId: bestId, name: bestName, score: bestScore, passed: bestScore >= minScore }
}

function pickBestWv(
  itemGroupId: string,
  csvVariation: string,
  catalog: CatalogIndex,
): string | null {
  const group = catalog.groups.get(itemGroupId)
  if (!group || group.wvs.length === 0) return null

  // If the CSV Item Variation is empty, just pick the first WV — there's
  // no signal to differentiate. Confidence for the whole match is
  // effectively "family only".
  if (!csvVariation) return group.wvs[0]!.wvId

  let best = group.wvs[0]!
  let bestScore = -1
  for (const wv of group.wvs) {
    const s = fuzzyScore(csvVariation, wv.variationLabel)
    if (s > bestScore) {
      bestScore = s
      best = wv
    }
  }
  // Even a weak WV match is better than the wrong WV — the family is
  // already right, and skipping over the colour/size choice would leave
  // the SALE unattributed. Fall back to the first WV if scores are all
  // zero (empty variation labels on our side).
  return best.wvId
}

function parseSquareDate(raw: string): Date | null {
  if (!raw) return null
  // Formats seen in the CSVs: "2025/12/01" and "12/1/25". Try both.
  const slash = raw.split('/')
  if (slash.length === 3) {
    if (slash[0]!.length === 4) {
      // YYYY/MM/DD
      const [y, m, d] = slash.map((p) => Number(p))
      if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
        return new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0))
      }
    } else {
      // M/D/YY
      const [m, d, yy] = slash.map((p) => Number(p))
      if (Number.isFinite(m) && Number.isFinite(d) && Number.isFinite(yy)) {
        const year = yy! < 100 ? 2000 + yy! : yy!
        return new Date(Date.UTC(year, m! - 1, d!, 12, 0, 0))
      }
    }
  }
  const fallback = new Date(raw)
  return Number.isNaN(fallback.getTime()) ? null : fallback
}

function csvEscape(fields: string[]): string {
  return fields
    .map((f) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f))
    .join(',')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
