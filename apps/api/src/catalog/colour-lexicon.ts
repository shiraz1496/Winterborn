/**
 * The controlled colour vocabulary for family assignment. Spec §6.3/§6.4:
 * colour is never free-typed downstream, and this is the single reviewable
 * table that decides what a raw Sortly `Color` value means.
 *
 * Two tables, nothing else:
 *
 * - `PALETTE` — single-word colour tokens mapped to the till family they
 *   belong to. Base colours plus the trade vocabulary the real export
 *   actually uses (almond, camel, taupe, mulberry, …).
 * - `SYNONYMS` — whole normalised phrases that carry an obvious family
 *   despite containing no colour word at all ("Traditional Pattern" →
 *   `Multi`).
 *
 * Deliberately generic. This file must never grow a list of the client's
 * actual design names (see task-3 brief) — every key here is either a
 * standard English colour word/plural, a colour trade term, or one of the
 * handful of non-colour phrases the spec itself calls out as needing an
 * explicit mapping. A phrase that isn't in either table is meant to fall
 * through to the residual queue, not be guessed at.
 */

export type Family =
  | 'Black'
  | 'White'
  | 'Gray'
  | 'Brown'
  | 'Cream'
  | 'Red'
  | 'Pink'
  | 'Orange'
  | 'Yellow'
  | 'Green'
  | 'Blue'
  | 'Purple'
  | 'Multi'

/**
 * Keys are lower-case single words, checked at every token position in
 * order of appearance — see `family-assigner.ts` for the scan.
 */
export const PALETTE: Record<string, Family> = {
  // --- base colours ---
  // Deliberately singular only, no plural forms ("blues", "browns", …) and
  // no dessert/flavour words that double as design names in the real data
  // ("mint", "chocolate" — see "Mint Chocolate Chip" in the task brief).
  // Widening this list is how the residual silently shrinks below its real
  // floor; every addition here was checked against the real 248 values for
  // exactly that risk.
  black: 'Black',
  white: 'White',
  gray: 'Gray',
  grey: 'Gray',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  // The one plural kept: every real occurrence of "blues" in the export is
  // an unambiguous colour reference ("Assorted Blues", "Midnight Blues
  // (Assorted)"), unlike the food-flavour words above.
  blues: 'Blue',
  navy: 'Blue',
  aqua: 'Blue',
  teal: 'Blue',
  purple: 'Purple',
  violet: 'Purple',
  pink: 'Pink',
  brown: 'Brown',
  cream: 'Cream',

  // --- trade vocabulary actually present in the export (spec §6.3) ---
  almond: 'Cream',
  camel: 'Brown',
  taupe: 'Brown',
  champagne: 'Cream',
  coco: 'Brown',
  sand: 'Cream',
  wheat: 'Cream',
  honey: 'Cream',
  oatmeal: 'Cream',
  ivory: 'Cream',
  beige: 'Cream',
  natural: 'Cream',
  neutral: 'Cream',
  tan: 'Brown',
  bourbon: 'Brown',
  mulberry: 'Purple',
  amethyst: 'Purple',
  eggplant: 'Purple',
  plum: 'Purple',
  lilac: 'Purple',
  lavender: 'Purple',
  berry: 'Purple',
  ruby: 'Red',
  crimson: 'Red',
  burgundy: 'Red',
  wine: 'Red',
  maroon: 'Red',
  raspberry: 'Pink',
  clementine: 'Orange',
  pumpkin: 'Orange',
  rust: 'Orange',
  emerald: 'Green',
  olive: 'Green',
  moss: 'Green',
  sage: 'Green',
  seafoam: 'Green',
  sapphire: 'Blue',
  periwinkle: 'Blue',
  denim: 'Blue',
  charcoal: 'Gray',
  ash: 'Gray',
  slate: 'Gray',
  silver: 'Gray',
  multi: 'Multi',
}

/**
 * Whole-phrase matches, checked only after the lexical pass finds no colour
 * token anywhere in the string. Each key is the normalised form of a phrase
 * spec §6.3 calls out explicitly as carrying an obvious family despite
 * having no colour word.
 */
export const SYNONYMS: Record<string, Family> = {
  multiple: 'Multi',
  multicolor: 'Multi',
  multicolour: 'Multi',
  'traditional pattern': 'Multi',
  spotted: 'Multi',
  houndstooth: 'Multi',
  'cool tones': 'Multi',
  'warm tones': 'Multi',
  'candy corn stripes': 'Multi',
  'wild stripes': 'Multi',
  grayscale: 'Gray',
  '4 shade browns': 'Brown',
  'assorted beiges and browns': 'Brown',
}
