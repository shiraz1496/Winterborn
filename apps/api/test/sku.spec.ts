import { describe, it, expect } from 'vitest'
import { tillSku, warehouseSku, checkCollisions } from '../src/catalog/sku.js'

describe('tillSku', () => {
  it('builds CAT-GROUP-FAMILY-SIZE', () => {
    expect(tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')).toBe('SCF-STR-BLU-R')
  })

  it('is stable across calls', () => {
    const a = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    const b = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    expect(a).toBe(b)
  })
})

describe('warehouseSku', () => {
  it('uses the variant, not the family, in the colour segment', () => {
    const till = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    const wh = warehouseSku('Scarves', 'Standard Scarves | Stripes', 'Bright Blue Variegated', 'Regular', 'OWN')
    expect(wh).not.toBe(till)
    expect(wh.startsWith('SCF-STR-')).toBe(true)
  })

  it('carries a brand segment for Fraas resale', () => {
    const own = warehouseSku('Scarves', 'Standard Scarves | Plaids', 'Bold Green', 'Regular', 'OWN')
    const fraas = warehouseSku('Scarves', 'Standard Scarves | Plaids', 'Bold Green', 'Regular', 'FRAAS')
    expect(fraas).not.toBe(own)
    expect(fraas).toContain('FR')
  })
})

describe('checkCollisions', () => {
  it('reports duplicates with their counts', () => {
    const dupes = checkCollisions(['A-B-C-D', 'A-B-C-D', 'X-Y-Z-W'])
    expect(dupes).toEqual([{ sku: 'A-B-C-D', count: 2 }])
  })

  it('reports nothing when every sku is unique', () => {
    expect(checkCollisions(['A-1', 'B-2', 'C-3'])).toEqual([])
  })
})

describe('abbreviation', () => {
  it('distinguishes names that share a prefix', () => {
    // "Standard Scarves | Stripes" and "Standard Scarves | Single Color" both
    // begin the same way. A naive first-three-letters abbreviation collapses
    // them, and the collision only surfaces after both are written to Square.
    const stripes = tillSku('Scarves', 'Standard Scarves | Stripes', 'Blue', 'Regular')
    const single = tillSku('Scarves', 'Standard Scarves | Single Color', 'Blue', 'Regular')
    expect(stripes).not.toBe(single)
  })
})
