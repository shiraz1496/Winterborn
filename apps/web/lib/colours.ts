/**
 * Maps a till-facing colour family name to the actual swatch colour shown
 * next to it everywhere in the app -- dashboard stock rows, request lines,
 * pack sheets, the admin queue. This is the app's one recurring visual
 * signature: the thing a packer is resolving ("60 gray" -> concrete
 * variants) is quite literally a colour, so the UI shows it as one rather
 * than making everything read the family name as plain text.
 *
 * Deliberately a fixed palette, not a hash-of-string generator: these are
 * real merchandising families (spec §6.1 targets 6-12 per category) and
 * they should look like the actual colours a buyer chose, not whatever a
 * hash function lands on.
 */
const SWATCHES: Record<string, string> = {
  Black: '#1c1c1a',
  White: '#f2efe6',
  Gray: '#8b8d8a',
  Grey: '#8b8d8a',
  Blue: '#3b5a80',
  Brown: '#6b4a35',
  Red: '#a13d2c',
  Purple: '#5b4a7a',
  Green: '#4a6b4a',
  Pink: '#c98a9e',
  Cream: '#e4d7b6',
  Orange: '#c97a3a',
}

export const NO_COLOUR_FAMILY_NAME = 'No Colour'
export const UNASSIGNED_FAMILY_NAME = 'Unassigned'

export function swatchFor(familyName: string): string | null {
  return SWATCHES[familyName] ?? null
}

export function isMultiFamily(familyName: string): boolean {
  return familyName.toLowerCase() === 'multi'
}
