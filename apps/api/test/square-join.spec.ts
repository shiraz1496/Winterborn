import { describe, it, expect } from 'vitest'
import { proposeJoins } from '../src/catalog/square-join.js'

describe('proposeJoins', () => {
  it('matches across the naming convention gap', () => {
    // Warehouse and till name the same product differently. Exact matching
    // finds almost nothing.
    const { matched } = proposeJoins(
      ['Standard Scarves | Stripes', 'Flip Mitts (Glittens)'],
      ['Scarf (Stripes)', 'Mittens (Flip Mitts)'],
    )
    const stripes = matched.find((m) => m.sortlyGroup === 'Standard Scarves | Stripes')
    expect(stripes?.squareItemName).toBe('Scarf (Stripes)')
    const mitts = matched.find((m) => m.sortlyGroup === 'Flip Mitts (Glittens)')
    expect(mitts?.squareItemName).toBe('Mittens (Flip Mitts)')
  })

  it('does not force a match when nothing is close', () => {
    // A wrong join silently sends the wrong stock to the wrong market. An
    // honest unmatched entry is worth more than a confident bad guess.
    const { matched, unmatchedSortly } = proposeJoins(['Dryer Balls'], ['Scarf (Stripes)'])
    expect(matched).toHaveLength(0)
    expect(unmatchedSortly).toContain('Dryer Balls')
  })

  it('reports both sides of the gap', () => {
    const r = proposeJoins(['Only In Sortly'], ['Only In Square'])
    expect(r.unmatchedSortly).toEqual(['Only In Sortly'])
    expect(r.unmatchedSquare).toEqual(['Only In Square'])
  })

  it('gives every match a reason a human can check', () => {
    const { matched } = proposeJoins(['Standard Scarves | Plaids'], ['Scarf (Plaids)'])
    expect(matched[0]?.reason.length).toBeGreaterThan(0)
    expect(matched[0]?.score).toBeGreaterThan(0)
  })
})
