import { describe, it, expect } from 'vitest'
import {
  balanceToBudget,
  fillToBudget,
  roundPack,
  type Candidate,
} from '../src/requests/packing-list-suggestion.service.js'

/// A budget mode has to actually hit its budget. The first implementation
/// scaled everything by one flat factor and re-capped, which lost the
/// shortfall twice over: a $25,000 revenue goal came out at $18,481. These
/// lock the fill in.

function candidate(over: Partial<Candidate> & { warehouseVariantId: string }): Candidate {
  return {
    variationId: 'v1',
    natural: 10,
    uncapped: 10,
    cap: 1000,
    onHand: 1000,
    competing: 0,
    fairShare: 1,
    fairAllocation: 1000,
    colourFairShare: 1,
    totalWarehouseOnHandForFamily: 1000,
    familyObserved: 50,
    lastYearSoldForColour: 10,
    colourSharePct: null,
    hasColourMix: true,
    priceCents: 5000,
    ...over,
  }
}

const cents = (c: Candidate) => c.priceCents ?? 0
const units = () => 1

function spent(list: Candidate[], qty: Map<string, number>, value: (c: Candidate) => number) {
  return list.reduce((sum, c) => sum + (qty.get(c.warehouseVariantId) ?? 0) * value(c), 0)
}

describe('fillToBudget', () => {
  it('reaches a revenue budget even when most lines are pinned at their stock cap', () => {
    // Three cheap lines with almost no stock, one deep line with plenty.
    // The flat-factor version left the budget mostly unspent here.
    const list = [
      candidate({ warehouseVariantId: 'a', natural: 40, uncapped: 40, cap: 5, priceCents: 2000 }),
      candidate({ warehouseVariantId: 'b', natural: 40, uncapped: 40, cap: 5, priceCents: 2000 }),
      candidate({ warehouseVariantId: 'c', natural: 40, uncapped: 40, cap: 5, priceCents: 2000 }),
      candidate({ warehouseVariantId: 'd', natural: 40, uncapped: 40, cap: 5000, priceCents: 2500 }),
    ]
    const budget = 25_000 * 100
    const out = fillToBudget(list, budget, cents)
    expect(spent(list, out, cents)).toBeGreaterThanOrEqual(budget * 0.999)
    // The capped lines are at their cap, not above it.
    for (const id of ['a', 'b', 'c']) expect(out.get(id)).toBe(5)
  })

  it('measures the fill in dollars for a revenue budget, not in units', () => {
    // One expensive line and one cheap line with identical demand. A
    // unit-measured fill would stop far short of the dollar target.
    const list = [
      candidate({ warehouseVariantId: 'cheap', natural: 10, uncapped: 10, cap: 10_000, priceCents: 500 }),
      candidate({ warehouseVariantId: 'dear', natural: 10, uncapped: 10, cap: 10_000, priceCents: 20_000 }),
    ]
    const budget = 30_000 * 100
    const out = fillToBudget(list, budget, cents)
    expect(spent(list, out, cents)).toBeCloseTo(budget, -2)
  })

  it('stops at the cap and reports the shortfall honestly when stock runs out', () => {
    const list = [candidate({ warehouseVariantId: 'a', natural: 500, uncapped: 500, cap: 20, priceCents: 1000 })]
    const budget = 25_000 * 100
    const out = fillToBudget(list, budget, cents)
    expect(out.get('a')).toBe(20)
    expect(spent(list, out, cents)).toBeLessThan(budget)
  })

  it('leaves a run alone when the natural allocation already meets the budget', () => {
    const list = [candidate({ warehouseVariantId: 'a', natural: 100, uncapped: 100, cap: 1000, priceCents: 1000 })]
    const out = fillToBudget(list, 50 * 100, cents)
    expect(out.get('a')).toBe(100)
  })
})

describe('balanceToBudget', () => {
  it('closes the gap that pack rounding opens', () => {
    const list = [
      candidate({ warehouseVariantId: 'a', natural: 103, cap: 1000, priceCents: 1000 }),
      candidate({ warehouseVariantId: 'b', natural: 97, cap: 1000, priceCents: 1000 }),
    ]
    const budget = 200 * 1000 // 200 units at $10
    const qty = new Map(list.map((c) => [c.warehouseVariantId, roundPack(c.natural, c.cap, 5, 5)]))
    // Rounding alone lands on 105 + 95 = 200 here, but assert the balance
    // pass never leaves the run under target.
    balanceToBudget({ list, qtyByVariant: qty, budgetValue: budget, unitValue: cents, step: 5, minQty: 5 })
    expect(spent(list, qty, cents)).toBeGreaterThanOrEqual(budget)
  })

  it('tops a rounded-down run back up to a unit target', () => {
    const list = [
      candidate({ warehouseVariantId: 'a', natural: 32, cap: 1000 }),
      candidate({ warehouseVariantId: 'b', natural: 32, cap: 1000 }),
      candidate({ warehouseVariantId: 'c', natural: 32, cap: 1000 }),
    ]
    const qty = new Map(list.map((c) => [c.warehouseVariantId, roundPack(c.natural, c.cap, 5, 5)]))
    expect(spent(list, qty, units)).toBe(90) // 30 + 30 + 30, rounded down
    balanceToBudget({ list, qtyByVariant: qty, budgetValue: 96, unitValue: units, step: 5, minQty: 5 })
    expect(spent(list, qty, units)).toBeGreaterThanOrEqual(96)
  })

  it('never trims a line below the minimum pack, even to hit the budget', () => {
    const list = [candidate({ warehouseVariantId: 'a', natural: 5, cap: 1000 })]
    const qty = new Map([['a', 5]])
    balanceToBudget({ list, qtyByVariant: qty, budgetValue: 1, unitValue: units, step: 5, minQty: 5 })
    expect(qty.get('a')).toBe(5)
  })

  it('does not top up past what the warehouse can supply', () => {
    const list = [candidate({ warehouseVariantId: 'a', natural: 10, cap: 12 })]
    const qty = new Map([['a', 10]])
    balanceToBudget({ list, qtyByVariant: qty, budgetValue: 500, unitValue: units, step: 5, minQty: 5 })
    expect(qty.get('a')).toBe(10) // 15 would exceed the cap of 12
  })
})
