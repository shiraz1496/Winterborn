import { describe, it, expect } from 'vitest'
import { roundPack } from '../src/requests/packing-list-suggestion.service.js'

/// Pack shaping is the part of the suggestion engine the operators actually
/// see and judge: "21" and "1" on a picking sheet are what made the old
/// output look untrustworthy. These lock in the rules behind those numbers.
describe('roundPack', () => {
  const STEP = 5
  const MIN = 5

  it('rounds to the nearest step so no line ends in an odd number', () => {
    expect(roundPack(21, 2209, STEP, MIN)).toBe(20)
    expect(roundPack(108, 2209, STEP, MIN)).toBe(110)
    expect(roundPack(42.4, 2209, STEP, MIN)).toBe(40)
  })

  it('never ships a token single unit — a sub-pack ask is dropped, not bumped', () => {
    // 0.3 units of demand is a rounding artefact from splitting a small
    // style across many colours. Bumping it to the minimum would ship 5.
    expect(roundPack(0.3, 500, STEP, MIN)).toBe(0)
    expect(roundPack(1, 500, STEP, MIN)).toBe(0)
  })

  it('raises real-but-short demand up to a whole minimum pack', () => {
    expect(roundPack(3, 500, STEP, MIN)).toBe(5)
    expect(roundPack(4, 500, STEP, MIN)).toBe(5)
  })

  it('honours a larger minimum than the rounding step', () => {
    expect(roundPack(6, 500, 5, 10)).toBe(10)
  })

  it('never exceeds what the warehouse can supply, and rounds down to fit', () => {
    expect(roundPack(200, 47, STEP, MIN)).toBe(45)
    expect(roundPack(200, 12, STEP, MIN)).toBe(10)
  })

  it('drops the line when stock cannot cover even one minimum pack', () => {
    expect(roundPack(50, 3, STEP, MIN)).toBe(0)
    expect(roundPack(50, 0, STEP, MIN)).toBe(0)
  })

  it('still returns the minimum when stock covers it but the step overshoots', () => {
    // cap 6, step 5 → floor to 5, which is below a minimum of 6; the
    // warehouse can cover 6, so ship exactly that rather than nothing.
    expect(roundPack(50, 6, 5, 6)).toBe(6)
  })

  it('treats a step of 1 as "no rounding" without changing the minimum rule', () => {
    expect(roundPack(21, 500, 1, 1)).toBe(21)
    expect(roundPack(0.4, 500, 1, 1)).toBe(0)
  })
})
