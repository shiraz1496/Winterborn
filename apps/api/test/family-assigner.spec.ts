import { describe, it, expect } from 'vitest'
import { assignFamily } from '../src/catalog/family-assigner.js'

describe('lexical pass', () => {
  it('extracts a base colour word', () => {
    expect(assignFamily('Blue')?.family).toBe('Blue')
    expect(assignFamily('Dark Blue Stripes (2024)')?.family).toBe('Blue')
    expect(assignFamily('French Gray')?.family).toBe('Gray')
  })

  it('knows the trade vocabulary actually present in the export', () => {
    // These are real values from the client's warehouse. A base-colour-only
    // palette misses every one of them.
    expect(assignFamily('Almond')?.family).toBe('Cream')
    expect(assignFamily('Camel')?.family).toBe('Brown')
    expect(assignFamily('Taupe')?.family).toBe('Brown')
    expect(assignFamily('Champagne')?.family).toBe('Cream')
    expect(assignFamily('Mulberry Sheen')?.family).toBe('Purple')
    expect(assignFamily('Clementine')?.family).toBe('Orange')
    expect(assignFamily('Wheat & Honey')?.family).toBe('Cream')
  })

  it('resolves a compound by its first colour token, not its last', () => {
    // "Blue w/ Black" is a blue mitten with black trim, not a black one.
    expect(assignFamily('Blue w/ Black')?.family).toBe('Blue')
    expect(assignFamily('Pink w/ White')?.family).toBe('Pink')
  })
})

describe('synonym pass', () => {
  it('maps non-colour phrases that nonetheless have an obvious family', () => {
    expect(assignFamily('Multiple')?.family).toBe('Multi')
    expect(assignFamily('Multicolor')?.family).toBe('Multi')
    expect(assignFamily('Traditional Pattern')?.family).toBe('Multi')
    expect(assignFamily('Grayscale')?.family).toBe('Gray')
    expect(assignFamily('4-Shade Browns')?.family).toBe('Brown')
    expect(assignFamily('Assorted Beiges & Browns')?.family).toBe('Brown')
  })

  it('marks synonym matches with a lower confidence than lexical ones', () => {
    const lexical = assignFamily('Navy')
    const synonym = assignFamily('Traditional Pattern')
    expect(lexical?.source).toBe('LEXICAL')
    expect(synonym?.source).toBe('SYNONYM')
    expect(synonym!.confidence).toBeLessThan(lexical!.confidence)
  })
})

describe('residual', () => {
  it('returns null for a design name with no colour signal', () => {
    // These need a human looking at the photo. Guessing here would produce
    // confidently wrong data, which is worse than an honest gap.
    expect(assignFamily('Pirate Pants (2024)')).toBeNull()
    expect(assignFamily('Ecuadorian Airlines (2024)')).toBeNull()
    expect(assignFamily('On the Waterfront')).toBeNull()
    expect(assignFamily('"The Classic" v. 2')).toBeNull()
    expect(assignFamily('Shady Grove')).toBeNull()
  })
})

describe('determinism', () => {
  it('returns the same answer every time for the same input', () => {
    const runs = Array.from({ length: 5 }, () => assignFamily('Seafoam/Blue/Grey (2024)'))
    expect(new Set(runs.map((r) => r?.family)).size).toBe(1)
  })
})
