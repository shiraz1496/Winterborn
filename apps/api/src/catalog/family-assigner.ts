import { PALETTE, SYNONYMS, type Family } from './colour-lexicon.js'

/**
 * The outcome of assigning one warehouse colour value to a till family.
 * `source` records which pass produced it: `LEXICAL`/`SYNONYM` come from
 * `assignFamily` below, `VISUAL`/`MANUAL` are written later by a human
 * looking at the archived photo (see task-3 brief step 4 and spec §6.3's
 * `/admin/colours` screen — not built by this module).
 */
export type FamilyAssignment = {
  variantName: string
  family: string
  source: 'LEXICAL' | 'SYNONYM' | 'VISUAL' | 'MANUAL'
  confidence: number
}

/**
 * Confidence exists only to sort the human review queue worst-first. It is
 * not a probability and nothing downstream should treat it as one.
 */
const LEXICAL_CONFIDENCE = 0.9
const SYNONYM_CONFIDENCE = 0.6

const MAX_PHRASE_LENGTH = Math.max(...Object.keys(PALETTE).map((key) => key.split(' ').length))

/**
 * Lowercases, expands the two abbreviations the export actually uses (`&`,
 * `w/`), strips a parenthetical exclusion clause like "(NOT Ruby Sheen or
 * Dark Mulberry)" so a negated colour can never be picked up as if it were
 * the item's own, then reduces every other punctuation mark and any bare
 * four-digit year (a season tag like "2024") to whitespace.
 *
 * Deliberately does NOT stem or fuzzy-match words — "Creamsicle" must never
 * collapse to "Cream". Matching below is always whole-word/whole-phrase.
 */
function normalise(raw: string): string {
  let s = raw.toLowerCase()
  s = s.replace(/\([^)]*\bnot\b[^)]*\)/g, ' ')
  s = s.replace(/&/g, ' and ')
  s = s.replace(/\bw\//g, ' with ')
  s = s.replace(/[^a-z0-9\s]/g, ' ')
  s = s.replace(/\b(19|20)\d{2}\b/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

function tokenise(normalised: string): string[] {
  return normalised.length > 0 ? normalised.split(' ') : []
}

/**
 * Scans left to right, and at every position tries the longest palette
 * phrase first — the table today is single words only, but a future
 * multi-word entry (e.g. a two-word trade term) would automatically
 * outrank the bare word that would otherwise be found at the same spot —
 * returning the family of the first token or phrase found. This is what
 * makes "Blue w/ Black" resolve to Blue: the scan never even reaches
 * "black".
 */
function findPaletteMatch(tokens: string[]): Family | null {
  for (let i = 0; i < tokens.length; i++) {
    for (let len = Math.min(MAX_PHRASE_LENGTH, tokens.length - i); len >= 1; len--) {
      const phrase = tokens.slice(i, i + len).join(' ')
      const family = PALETTE[phrase]
      if (family) return family
    }
  }
  return null
}

/**
 * Three-pass colour family derivation (spec §6.3, task-3 brief). Pass 1
 * (lexical) and pass 2 (synonym) are implemented here and run in that
 * order — a real colour word anywhere in the string always wins over a
 * whole-phrase synonym match, because a value with genuine colour signal
 * should never fall back to a coarser rule.
 *
 * Returns `null` for the residual: pass 3 is a human looking at the
 * archived photo, not a guess. A design name with no colour token — "Pirate
 * Pants", "Ecuadorian Airlines", "\"The Classic\" v. 2" — is *supposed* to
 * come back null. Do not add vocabulary here to shrink that number; a
 * residual that comes out far below the ~40 measured against the real
 * export means the lexicon is inventing colours for design names, which is
 * the failure mode, not under-coverage.
 */
export function assignFamily(variantName: string): FamilyAssignment | null {
  const normalised = normalise(variantName)
  const tokens = tokenise(normalised)

  const lexicalFamily = findPaletteMatch(tokens)
  if (lexicalFamily) {
    return { variantName, family: lexicalFamily, source: 'LEXICAL', confidence: LEXICAL_CONFIDENCE }
  }

  const synonymFamily = SYNONYMS[normalised]
  if (synonymFamily) {
    return { variantName, family: synonymFamily, source: 'SYNONYM', confidence: SYNONYM_CONFIDENCE }
  }

  return null
}
