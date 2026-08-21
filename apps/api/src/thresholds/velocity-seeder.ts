import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'csv-parse/sync'
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { proposeJoins } from '../catalog/square-join.js'

/**
 * Seeds `Threshold.minLevel` from 2025 velocity (spec §9.7). Reads
 * `data/square-2025/item-detail/*.csv` -- the same nine weekly exports
 * `cli:replay-season` replays into the ledger -- and, deliberately, goes
 * no further than the `Item` column.
 *
 * WHY STYLE LEVEL, NOT COLOUR LEVEL (spec §6.5, explicit non-goal): the
 * export's `Price Point Name` column mixes colour ("Cream/Tan") and size
 * ("Small", "Medium") in one free-text field with no reliable way to tell
 * which is which, and 2025 data carries an identifiable colour on only
 * 4.8% of revenue. Splitting velocity by that column would fabricate a
 * precision the data cannot support -- exactly the "colour-level
 * prediction" the spec rules out for this season. Instead every `Variation`
 * under one `ItemGroup` (every colour family, every size) inherits the SAME
 * minLevel, computed once from that item's total units at that location.
 * This is a known, coarse approximation, not a hidden one -- SEEDED source
 * marks it as a starting point, distinct from a MANUAL override an owner
 * or operator later dials in per line once real pilot experience exists.
 *
 * THE FORMULA: for each (item, location) pair, take the highest units-sold
 * in any single one of the nine weekly files -- i.e. the worst week of the
 * actual 2025 season, not an average across it -- and floor it at
 * PEAK_WEEK_FLOOR. "One week of peak velocity" is deliberate, not "one
 * week of average velocity": thresholds exist to survive the busiest
 * stretch a market sees (the audit's own Black-Friday-through-mid-December
 * curve), and an average would systematically under-threshold every SKU
 * during exactly the weeks a stockout is most expensive. The floor exists
 * so a style that barely sold in 2025 -- a new colourway, a slow mover --
 * still carries a minLevel above zero and therefore still restocks once,
 * rather than sitting silent all season because its computed velocity
 * rounded to nothing. FUTURE READER: if you inherit a minLevel of, say,
 * 40, that number is this item's single highest-selling week in 2025 at
 * this location -- not a guess and not a target. Check `source` on the
 * row: SEEDED means this formula produced it, MANUAL means a human moved
 * it since, and this seeder will never overwrite a MANUAL row.
 */
const PEAK_WEEK_FLOOR = 2

interface CsvRow {
  Item: string
  Qty: string
  'Event Type': string
  Location: string
}

export interface ThresholdBucket {
  itemGroupName: string
  locationName: string
  minLevel: number
}

export interface SeedResult {
  weeksRead: number
  linesRead: number
  pairsResolved: number
  pairsUnresolved: number
  thresholdsCreated: number
  thresholdsUpdated: number
  thresholdsUnchanged: number
  thresholdsSkippedManual: number
  /** minLevel -> count of Threshold rows at that level, for reporting a distribution. */
  distribution: Record<number, number>
  /** Top ten (item, location) pairs by computed minLevel. */
  topTen: ThresholdBucket[]
}

function parseQty(raw: string): number {
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** Reads one weekly CSV into flat rows: only the four columns this seeder needs, out of the ~30 the real export carries. */
function readWeek(path: string): CsvRow[] {
  const text = readFileSync(path, 'utf8')
  return parse(text, { columns: true, skip_empty_lines: true, relax_quotes: true }) as CsvRow[]
}

export interface VelocityPair {
  item: string
  location: string
  peakUnits: number
}

/**
 * Item and location names both routinely contain spaces ("Scarf
 * (Stripes)", "Boston (Snowport)"), so pairs are carried as a two-level
 * Map keyed on the raw strings, never joined into one delimited string and
 * split back apart later -- a join/split round trip would silently
 * corrupt the first pair whose item or location name contained the
 * delimiter.
 */
type PeakByItemThenLocation = Map<string, Map<string, number>>

/** Peak-of-nine-weeks units sold per (item, location): signed net of refunds within each week, floored at zero per week (a week cannot un-sell more than it sold), then the max across weeks. */
function computePeakVelocity(weekFiles: string[]): PeakByItemThenLocation {
  const peak: PeakByItemThenLocation = new Map()

  for (const file of weekFiles) {
    const weekTotals: PeakByItemThenLocation = new Map()
    for (const row of readWeek(file)) {
      const item = (row.Item ?? '').trim()
      const location = (row.Location ?? '').trim()
      if (!item || !location) continue
      const qty = parseQty(row.Qty)
      const eventType = (row['Event Type'] ?? '').trim().toLowerCase()
      const signed = eventType === 'refund' ? -qty : qty

      const byLocation = weekTotals.get(item) ?? new Map<string, number>()
      byLocation.set(location, (byLocation.get(location) ?? 0) + signed)
      weekTotals.set(item, byLocation)
    }
    for (const [item, byLocation] of weekTotals) {
      const peakByLocation = peak.get(item) ?? new Map<string, number>()
      for (const [location, total] of byLocation) {
        const weekUnits = Math.max(0, total)
        // `has`, not `?? 0`: a pair's first-ever week can itself net to
        // zero (an all-refund week, as Chicago's fixture week is), and
        // that must still register the pair at peak 0 rather than being
        // silently indistinguishable from "never seen this pair" and
        // dropped -- a dropped pair never gets a Threshold row at all,
        // which is a worse outcome than a floored-to-2 one.
        const prevPeak = peakByLocation.has(location) ? peakByLocation.get(location)! : -1
        if (weekUnits > prevPeak) peakByLocation.set(location, weekUnits)
      }
      peak.set(item, peakByLocation)
    }
  }

  return peak
}

function* iteratePairs(peak: PeakByItemThenLocation): Generator<VelocityPair> {
  for (const [item, byLocation] of peak) {
    for (const [location, peakUnits] of byLocation) {
      yield { item, location, peakUnits }
    }
  }
}

@Injectable()
export class VelocitySeeder {
  constructor(private readonly prisma: PrismaService) {}

  async seedFromSeason(dir: string): Promise<SeedResult> {
    const weekFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.csv'))
      .sort()
      .map((f) => resolve(dir, f))

    let linesRead = 0
    for (const file of weekFiles) linesRead += readWeek(file).length

    const peak = computePeakVelocity(weekFiles)
    const pairs = [...iteratePairs(peak)]

    const itemGroups = await this.prisma.itemGroup.findMany({ select: { id: true, name: true } })
    const itemGroupIdByName = new Map(itemGroups.map((g) => [g.name, g.id]))

    // One clean candidate only -- an item name that ties between two
    // ItemGroups is exactly the ambiguity square-join.ts's own withholding
    // rule exists for; a threshold seeder guessing wrong here writes a
    // wrong number into a live restock signal, so a tie is withheld too.
    const distinctItems = [...new Set(pairs.map((p) => p.item))]
    const { matched } = proposeJoins(distinctItems, itemGroups.map((g) => g.name))
    const candidatesByCsvItem = new Map<string, string[]>()
    for (const m of matched) {
      const list = candidatesByCsvItem.get(m.sortlyGroup) ?? []
      list.push(m.squareItemName)
      candidatesByCsvItem.set(m.sortlyGroup, list)
    }
    const itemGroupNameByCsvItem = new Map<string, string>()
    for (const [csvItem, candidates] of candidatesByCsvItem) {
      if (candidates.length === 1 && candidates[0]) itemGroupNameByCsvItem.set(csvItem, candidates[0])
    }

    // Locations: resolve-or-create by exact name, mirroring cli:replay-season
    // -- this is a byproduct of the export predating any Location rows
    // existing, not a fuzzy match, so seeding thresholds does not require
    // the season replay to have run first.
    const existingLocations = await this.prisma.location.findMany({ select: { id: true, name: true } })
    const locationIdByName = new Map(existingLocations.map((l) => [l.name, l.id]))
    const distinctLocations = [...new Set(pairs.map((p) => p.location))]
    for (const name of distinctLocations) {
      if (locationIdByName.has(name)) continue
      const loc = await this.prisma.location.upsert({
        where: { name },
        update: {},
        create: { name, kind: 'MARKET', timezone: 'America/New_York', isActive: true },
      })
      locationIdByName.set(name, loc.id)
    }
    const locationNameById = new Map([...locationIdByName].map(([name, id]) => [id, name]))

    let pairsResolved = 0
    let pairsUnresolved = 0
    const perItemGroupLocation = new Map<string, { itemGroupId: string; locationId: string; minLevel: number }>()
    for (const { item, location, peakUnits } of pairs) {
      const itemGroupName = itemGroupNameByCsvItem.get(item)
      const itemGroupId = itemGroupName ? itemGroupIdByName.get(itemGroupName) : undefined
      const locationId = locationIdByName.get(location)
      if (!itemGroupId || !locationId) {
        pairsUnresolved++
        continue
      }
      pairsResolved++
      const minLevel = Math.max(PEAK_WEEK_FLOOR, peakUnits)
      perItemGroupLocation.set(`${itemGroupId} ${locationId}`, { itemGroupId, locationId, minLevel })
    }

    let thresholdsCreated = 0
    let thresholdsUpdated = 0
    let thresholdsUnchanged = 0
    let thresholdsSkippedManual = 0
    const distribution: Record<number, number> = {}
    const topTen: ThresholdBucket[] = []
    const itemGroupNameById = new Map(itemGroups.map((g) => [g.id, g.name]))

    for (const { itemGroupId, locationId, minLevel } of perItemGroupLocation.values()) {
      const variations = await this.prisma.variation.findMany({ where: { itemGroupId }, select: { id: true } })

      for (const v of variations) {
        const existing = await this.prisma.threshold.findUnique({
          where: { variationId_locationId: { variationId: v.id, locationId } },
        })

        if (existing?.source === 'MANUAL') {
          thresholdsSkippedManual++
          continue
        }
        if (existing) {
          if (existing.minLevel === minLevel) {
            thresholdsUnchanged++
          } else {
            await this.prisma.threshold.update({ where: { id: existing.id }, data: { minLevel, source: 'SEEDED' } })
            thresholdsUpdated++
          }
        } else {
          await this.prisma.threshold.create({ data: { variationId: v.id, locationId, minLevel, source: 'SEEDED' } })
          thresholdsCreated++
        }
      }

      if (variations.length > 0) {
        distribution[minLevel] = (distribution[minLevel] ?? 0) + variations.length
        topTen.push({
          itemGroupName: itemGroupNameById.get(itemGroupId) ?? itemGroupId,
          locationName: locationNameById.get(locationId) ?? locationId,
          minLevel,
        })
      }
    }

    topTen.sort((a, b) => b.minLevel - a.minLevel)

    return {
      weeksRead: weekFiles.length,
      linesRead,
      pairsResolved,
      pairsUnresolved,
      thresholdsCreated,
      thresholdsUpdated,
      thresholdsUnchanged,
      thresholdsSkippedManual,
      distribution,
      topTen: topTen.slice(0, 10),
    }
  }
}
