import { parse } from 'csv-parse/sync'

/**
 * One row of the Sortly warehouse export, normalised into the shape the
 * catalog importer consumes. `colour`, `style` and `size` are carried
 * through faithfully from whichever `Attribute N` slot they occupied in the
 * source row — see `readAttributes` below. This type intentionally does not
 * interpret what a colour value *means* (a real colour vs. a design name);
 * that judgement belongs to family assignment, not this parser.
 */
export type ParsedSortlyItem = {
  entryName: string
  sid: string
  itemGroupName: string
  colour?: string
  style?: string
  size?: string
  quantity: number
  minLevel?: number
  unitCostCents?: number
  /// Alias for `photoUrls[0]`. Kept for existing callers (importer's
  /// ColourVariant photo backfill) that want the representative image
  /// without knowing about the array.
  photoUrl?: string
  /// Every non-empty Photo1..Photo8 cell in file order. 542/547 rows have
  /// Photo1; 131 have Photo2; 74 have Photo3; the tail is tiny (Photo8: 1
  /// row). Reading all eight is cheaper than deciding a cutoff.
  photoUrls: string[]
  primaryFolder: string
  subfolder1?: string
  subfolder2?: string
}

export type SkippedRow = { row: number; reason: string }

export type ParseResult = {
  items: ParsedSortlyItem[]
  skipped: SkippedRow[]
}

type RawRow = Record<string, string>

/** Trims a raw CSV field and treats the empty string as absent. */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Attributes are scattered across three (name, option) slots and keyed by
 * name, not position: `Attribute 1 Name` is `Color` on the majority of real
 * rows but `Style` or `Size` on hundreds of others, and the same value can
 * appear in any of the three slots depending on the row. Reading slot 1 as
 * "colour" silently mislabels every row where it isn't — this scans all
 * three slots and keys on the declared name instead.
 */
function readAttributes(row: RawRow): { colour?: string; style?: string; size?: string } {
  const result: { colour?: string; style?: string; size?: string } = {}
  for (const slot of [1, 2, 3] as const) {
    const name = clean(row[`Attribute ${slot} Name`])
    const option = clean(row[`Attribute ${slot} Option`])
    if (!name || !option) continue
    if (name === 'Color') result.colour = option
    else if (name === 'Style') result.style = option
    else if (name === 'Size') result.size = option
    // An unrecognised attribute name is deliberately ignored rather than
    // thrown on: it carries no downstream meaning today and the row's other
    // fields are still worth importing.
  }
  return result
}

/**
 * Parses a decimal-string quantity into a non-negative integer. Sortly
 * exports quantity as e.g. "12.0"; blank becomes 0 per the import contract,
 * distinct from Min Level and Price where blank means "unset".
 */
function parseQuantity(raw: string | undefined): number {
  const trimmed = raw?.trim()
  if (!trimmed) return 0
  const n = Number(trimmed)
  if (!Number.isFinite(n)) throw new Error(`invalid Quantity "${raw}"`)
  return Math.round(n)
}

/** Blank Min Level means "not set", which is not the same thing as 0. */
function parseMinLevel(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) throw new Error(`invalid Min Level "${raw}"`)
  return Math.round(n)
}

/**
 * Converts the Price column (a decimal dollar string) to integer cents.
 * Blank means unset. A literal "0.0" is also treated as unset: Sortly
 * defaults this field to 0.0 for the overwhelming majority of rows that
 * were never priced at all (405 blank + 153 literal "0.0" out of 564 real
 * rows), and nothing in the catalog genuinely costs $0.00 — only 6 real
 * rows carry an actual entered price. Collapsing both to `undefined` is
 * what makes "items with a price" mean something during import.
 */
function parsePriceCents(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) throw new Error(`invalid Price "${raw}"`)
  if (n === 0) return undefined
  return Math.round(n * 100)
}

/**
 * Parses a Sortly CSV export into catalog-ready rows.
 *
 * Never throws on a bad row: any row that fails to parse (unrecognised
 * Entry Type, an unparseable numeric field, a missing SID) is recorded in
 * `skipped` with a reason and parsing continues, so one bad row cannot cost
 * the other hundreds.
 */
export function parseSortlyCsv(csvText: string): ParseResult {
  const items: ParsedSortlyItem[] = []
  const skipped: SkippedRow[] = []

  let records: RawRow[]
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as RawRow[]
  } catch (err) {
    // A totally malformed file: nothing to parse, nothing to skip
    // individually. Surface it as a single skipped "row".
    skipped.push({ row: 0, reason: `failed to parse CSV: ${(err as Error).message}` })
    return { items, skipped }
  }

  records.forEach((row, index) => {
    // Row 1 is the header; data rows are 1-indexed from there, matching
    // what a spreadsheet viewer would show.
    const rowNumber = index + 2
    try {
      const entryType = clean(row['Entry Type'])
      if (entryType !== 'Item') {
        skipped.push({ row: rowNumber, reason: `Entry Type is "${entryType ?? ''}", not Item` })
        return
      }

      const sid = clean(row['SID'])
      if (!sid) {
        skipped.push({ row: rowNumber, reason: 'missing SID' })
        return
      }

      const entryName = clean(row['Entry Name'])
      if (!entryName) {
        skipped.push({ row: rowNumber, reason: 'missing Entry Name' })
        return
      }

      const primaryFolder = clean(row['Primary Folder'])
      if (!primaryFolder) {
        skipped.push({ row: rowNumber, reason: 'missing Primary Folder' })
        return
      }

      // 2 of 564 real rows carry no Item Group Name at all. There is
      // nowhere else in the schema for a warehouse variant to hang off of,
      // so falling back to the entry's own name keeps the row importable
      // instead of discarding it.
      const itemGroupName = clean(row['Item Group Name']) ?? entryName

      const { colour, style, size } = readAttributes(row)
      const quantity = parseQuantity(row['Quantity'])
      const minLevel = parseMinLevel(row['Min Level'])
      const unitCostCents = parsePriceCents(row['Price'])
      const photoUrls: string[] = []
      for (const slot of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
        const url = clean(row[`Photo${slot}`])
        if (url) photoUrls.push(url)
      }
      const subfolder1 = clean(row['Subfolder-level1'])
      const subfolder2 = clean(row['Subfolder-level2'])

      items.push({
        entryName,
        sid,
        itemGroupName,
        colour,
        style,
        size,
        quantity,
        minLevel,
        unitCostCents,
        photoUrl: photoUrls[0],
        photoUrls,
        primaryFolder,
        subfolder1,
        subfolder2,
      })
    } catch (err) {
      skipped.push({ row: rowNumber, reason: (err as Error).message })
    }
  })

  return { items, skipped }
}
