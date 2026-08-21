import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSortlyCsv } from '../src/catalog/sortly-parser.js'

const sample = readFileSync(join(__dirname, 'fixtures/sortly-sample.csv'), 'utf8')

describe('parseSortlyCsv', () => {
  it('skips folder rows and keeps only items', () => {
    const { items } = parseSortlyCsv(sample)
    expect(items.every((i) => i.sid.length > 0)).toBe(true)
    expect(items.some((i) => i.entryName.includes('FOLDER'))).toBe(false)
  })

  it('normalises attributes regardless of which slot they occupy', () => {
    // The real export puts Color in slot 1 on 453 rows, slot 2 on 37 others,
    // and Size in slots 1, 2 and 3 depending on the row. A parser that reads
    // slot 1 as "colour" silently mislabels hundreds of items.
    const { items } = parseSortlyCsv(sample)
    const colourInSlotTwo = items.find((i) => i.entryName === 'SLOT2_COLOUR')
    expect(colourInSlotTwo?.colour).toBe('Blue')
    const sizeInSlotThree = items.find((i) => i.entryName === 'SLOT3_SIZE')
    expect(sizeInSlotThree?.size).toBe('Large')
  })

  it('handles a row with no attributes at all', () => {
    const { items } = parseSortlyCsv(sample)
    const bare = items.find((i) => i.entryName === 'NO_ATTRS')
    expect(bare).toBeDefined()
    expect(bare?.colour).toBeUndefined()
  })

  it('parses quantity and leaves blank optional numerics undefined', () => {
    const { items } = parseSortlyCsv(sample)
    const zero = items.find((i) => i.entryName === 'ZERO_QTY')
    expect(zero?.quantity).toBe(0)
    expect(zero?.minLevel).toBeUndefined()
    expect(zero?.unitCostCents).toBeUndefined()
  })

  it('survives a quoted field containing a comma', () => {
    const { items } = parseSortlyCsv(sample)
    const comma = items.find((i) => i.entryName === 'COMMA_FIELD')
    expect(comma?.subfolder1).toBe('Cullman, AL')
  })

  it('reports skipped rows rather than dropping them silently', () => {
    const { skipped } = parseSortlyCsv(sample)
    expect(Array.isArray(skipped)).toBe(true)
    expect(skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 0)).toBe(true)
  })

  // Supplementary coverage beyond the brief's baseline spec, added while
  // implementing: the fixture also carries a row with all three attribute
  // slots populated and a colour value that is plainly a design name, not a
  // colour, since both broke exploratory parsing during real-file analysis.
  it('captures colour, style and size together when all three are present', () => {
    const { items } = parseSortlyCsv(sample)
    const all = items.find((i) => i.entryName === 'ALL_THREE')
    expect(all?.colour).toBe('Violet/Rose')
    expect(all?.style).toBe('Lozenge Variant')
    expect(all?.size).toBe('Medium')
  })

  it('carries a design-name colour value through untouched', () => {
    const { items } = parseSortlyCsv(sample)
    const designName = items.find((i) => i.entryName === 'DESIGN_NAME_COLOUR')
    expect(designName?.colour).toBe('Pirate Pants (2024)')
  })

  it('converts price to rounded integer cents and parses a set min level', () => {
    const { items } = parseSortlyCsv(sample)
    const priced = items.find((i) => i.entryName === 'PRICED')
    // 12.345 -> 1234.5 cents, rounds to 1235
    expect(priced?.unitCostCents).toBe(1235)
    expect(priced?.minLevel).toBe(1)
  })

  it('records a malformed numeric field as skipped instead of throwing', () => {
    expect(() => parseSortlyCsv(sample)).not.toThrow()
    const { items, skipped } = parseSortlyCsv(sample)
    expect(items.some((i) => i.entryName === 'MALFORMED_QTY')).toBe(false)
    expect(skipped.some((s) => s.reason.toLowerCase().includes('quantity'))).toBe(true)
  })
})
