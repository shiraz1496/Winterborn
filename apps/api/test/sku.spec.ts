import { describe, it, expect } from 'vitest'
import { warehouseSku, checkCollisions } from '../src/catalog/sku.js'

describe('warehouseSku', () => {
  it('builds CAT-GROUP-VARIANT-SIZE using the ColourVariant, not the family', () => {
    const sku = warehouseSku('Scarves', 'Standard Scarves | Stripes', 'Bright Blue Variegated', 'Regular', 'OWN')
    expect(sku.startsWith('SCF-STR-')).toBe(true)
  })

  it('carries a brand segment for Fraas resale', () => {
    const own = warehouseSku('Scarves', 'Standard Scarves | Plaids', 'Bold Green', 'Regular', 'OWN')
    const fraas = warehouseSku('Scarves', 'Standard Scarves | Plaids', 'Bold Green', 'Regular', 'FRAAS')
    expect(fraas).not.toBe(own)
    expect(fraas).toContain('FR')
  })

  it('distinguishes group names that share a prefix', () => {
    // "Standard Scarves | Stripes" and "Standard Scarves | Single Color"
    // both begin the same way. A naive first-three-letters abbreviation
    // collapses them, and the collision only surfaces after both are
    // written to Square.
    const stripes = warehouseSku('Scarves', 'Standard Scarves | Stripes', 'Bright Blue', 'Regular', 'OWN')
    const single = warehouseSku('Scarves', 'Standard Scarves | Single Color', 'Bright Blue', 'Regular', 'OWN')
    expect(stripes).not.toBe(single)
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
