import { describe, it, expect } from 'vitest'
import { decideConfidence, type CrossMarketEvidence } from '../src/requests/packing-list-suggestion.service.js'

/// On a new market there are no local sales to be confident about, so the
/// grade evaluates how well the OTHER markets evidence each product. The
/// point is that it discriminates: a list should not come back with every
/// line wearing the same badge.
const base = {
  observed: 40,
  hasColourMix: true,
  targetMode: 'CUSTOM_REVENUE' as const,
  marketName: 'Massachusetts New',
}
const evidence = (over: Partial<CrossMarketEvidence>): CrossMarketEvidence => ({
  marketsSold: 11,
  marketsTotal: 13,
  totalUnits: 2400,
  topMarketShare: 0.2,
  ...over,
})

describe('decideConfidence on a new market', () => {
  it('grades a product that sells widely and evenly as strong', () => {
    const r = decideConfidence({ ...base, source: 'CROSS_MARKET', evidence: evidence({}) })
    expect(r.level).toBe('HIGH')
    expect(r.reason).toContain('11 of 13 markets')
    expect(r.reason).toContain('no history of its own')
  })

  it('grades a one-market favourite as thin, however big its volume', () => {
    const r = decideConfidence({
      ...base,
      source: 'CROSS_MARKET',
      evidence: evidence({ marketsSold: 1, totalUnits: 3000, topMarketShare: 1 }),
    })
    expect(r.level).toBe('LOW')
    expect(r.reason).toContain('local favourite')
  })

  it('holds back a product whose breadth is carried by one outlier market', () => {
    const r = decideConfidence({
      ...base,
      source: 'CROSS_MARKET',
      evidence: evidence({ topMarketShare: 0.85 }),
    })
    expect(r.level).toBe('MEDIUM')
    expect(r.reason).toContain('85%')
  })

  it('holds back a well-evidenced product when colours are only an even guess', () => {
    const r = decideConfidence({
      ...base,
      hasColourMix: false,
      source: 'CROSS_MARKET',
      evidence: evidence({}),
    })
    expect(r.level).toBe('MEDIUM')
    expect(r.reason).toContain('product level only')
  })

  it('grades thin volume as low even when it appears at several markets', () => {
    const r = decideConfidence({
      ...base,
      source: 'CROSS_MARKET',
      evidence: evidence({ marketsSold: 5, totalUnits: 8 }),
    })
    expect(r.level).toBe('LOW')
  })

  it('spreads across all three grades for one new market, rather than flattening', () => {
    const levels = [
      evidence({}),
      evidence({ marketsSold: 5, totalUnits: 200 }),
      evidence({ marketsSold: 1, totalUnits: 4, topMarketShare: 1 }),
    ].map((e) => decideConfidence({ ...base, source: 'CROSS_MARKET', evidence: e }).level)
    expect(new Set(levels).size).toBe(3)
  })

  it('says there is nothing to evaluate when no other market sold it', () => {
    const r = decideConfidence({ ...base, source: 'CROSS_MARKET', evidence: undefined })
    expect(r.level).toBe('LOW')
    expect(r.reason).toContain('nothing to evaluate')
  })
})

describe('decideConfidence on an established market', () => {
  it('still rates local colour-level sales as high confidence', () => {
    const r = decideConfidence({ ...base, source: 'LOCAL_SALES', targetMode: 'MATCH_LAST_YEAR' })
    expect(r.level).toBe('HIGH')
    expect(r.reason).toContain('own sales')
  })

  it('still drops to medium on a thin local sample', () => {
    const r = decideConfidence({ ...base, observed: 2, source: 'LOCAL_SALES', targetMode: 'MATCH_LAST_YEAR' })
    expect(r.level).toBe('MEDIUM')
  })
})
