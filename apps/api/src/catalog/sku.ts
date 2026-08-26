/**
 * Two-level SKU generation (spec §5.3, task-4 brief). `CAT-GROUP-COLOUR-SIZE`.
 * The two levels differ only in what fills the colour segment: the
 * `ColourFamily` for a till SKU (what the cashier taps), the
 * `ColourVariant` for a warehouse SKU (what the warehouse counts).
 *
 * These codes are written into Square and become the permanent join key
 * between the two systems, so determinism is the whole point: the same
 * inputs must produce the same code forever, and `generate-skus.ts` must
 * always process a given scope's inputs in the same fixed (alphabetical)
 * order for that guarantee to hold across runs -- see `abbreviate` below.
 */

export type Brand = 'OWN' | 'FRAAS'

const CATEGORY_CODES: Record<string, string> = {
  Scarves: 'SCF',
  Mittens: 'MIT',
  Footwear: 'FTW',
  Headwear: 'HDW',
  Toys: 'TOY',
  Garments: 'GAR',
  Miscellaneous: 'MSC',
  Supplies: 'SUP',
}

function categoryCode(category: string): string {
  const code = CATEGORY_CODES[category]
  if (!code) throw new Error(`sku: category "${category}" has no fixed 3-letter code`)
  return code
}

/** Uppercase, alphanumerics only. Never empty -- an all-punctuation source falls back to "X". */
function stripToLetters(text: string): string {
  const stripped = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return stripped.length > 0 ? stripped : 'X'
}

/**
 * The segment after the last "|" when present, else the whole string.
 * This alone is what keeps "Standard Scarves | Stripes" and "Standard
 * Scarves | Single Color" apart -- both share the "Standard Scarves"
 * prefix, but "Stripes" and "Single Color" diverge at the first letter
 * once the shared prefix is dropped. A naive first-three-letters-of-the-
 * whole-name scheme would collapse both to "STA".
 */
function afterLastPipe(text: string): string {
  const i = text.lastIndexOf('|')
  return i === -1 ? text : text.slice(i + 1)
}

/**
 * scopeKey -> (code -> the one source text that owns it). Module-level and
 * deliberately mutable: this is what lets `abbreviate` grow a code past
 * its minimum length only when it is actually needed to disambiguate two
 * different source texts within the same scope (e.g. two group names in
 * the same category, or two colours in the same group) -- see spec'd rule
 * "extended to 4 or 5 only as needed to break a tie". A real example from
 * the client's export: "Sport Socks | Standard" and "Sport Socks | Star
 * Pattern" both abbreviate to "STA" at 3 characters; the second one grows
 * to "STAR".
 */
const registries = new Map<string, Map<string, string>>()

function registryFor(scopeKey: string): Map<string, string> {
  let registry = registries.get(scopeKey)
  if (!registry) {
    registry = new Map()
    registries.set(scopeKey, registry)
  }
  return registry
}

/**
 * Deterministic, collision-avoiding abbreviation. Starts at `minLen`
 * characters of the (pipe-stripped, alphanumeric-only) source text. If
 * that code is already owned by a *different* source text in the same
 * scope, grows one character at a time until it finds a free code or its
 * own already-owned one. The same source text therefore always resolves
 * back to whatever code it previously claimed in that scope, which is
 * what makes repeated calls with the same arguments stable.
 *
 * Determinism across runs (not just within one process) depends on the
 * caller always processing a scope's distinct source texts in the same
 * order -- generate-skus.ts sorts every query alphabetically by name for
 * exactly this reason. A genuine leftover collision (the growth exhausted
 * without a free slot) is not silently resolved here; it falls back to a
 * scope-unique suffix so the pipeline terminates, and `checkCollisions`
 * downstream is the actual hard stop on any resulting duplicate SKU.
 */
function abbreviate(scopeKey: string, sourceText: string, minLen: number): string {
  const registry = registryFor(scopeKey)
  const base = stripToLetters(afterLastPipe(sourceText))
  const cap = Math.max(minLen, base.length) + 4

  for (let len = minLen; len <= cap; len++) {
    const candidate = base.slice(0, len)
    const owner = registry.get(candidate)
    if (owner === undefined) {
      registry.set(candidate, sourceText)
      return candidate
    }
    if (owner === sourceText) return candidate
  }

  const fallback = `${base}${registry.size}`
  registry.set(fallback, sourceText)
  return fallback
}

function groupCode(category: string, group: string): string {
  return abbreviate(`group::${category}`, group, 3)
}

function sizeCode(category: string, group: string, size: string): string {
  return abbreviate(`size::${category}::${group}`, size, 1)
}

function variantCode(category: string, group: string, variant: string): string {
  return abbreviate(`wh-colour::${category}::${group}`, variant, 3)
}

/** `FRAAS` inserts an `FR` segment after the category code; `OWN` inserts nothing. */
function brandSegment(brand: Brand): string | null {
  return brand === 'FRAAS' ? 'FR' : null
}

/**
 * Warehouse-level SKU: `CAT-GROUP-VARIANT-SIZE`, or `CAT-FR-GROUP-VARIANT-SIZE`
 * for `[Fraas]` resale. Uses the `ColourVariant`, not the `ColourFamily`,
 * in the colour segment -- warehouse detail, not till-level grouping.
 */
export function warehouseSku(
  category: string,
  group: string,
  variant: string,
  size: string,
  brand: Brand,
): string {
  const segments = [categoryCode(category)]
  const brandSeg = brandSegment(brand)
  if (brandSeg) segments.push(brandSeg)
  segments.push(groupCode(category, group), variantCode(category, group, variant), sizeCode(category, group, size))
  return segments.join('-')
}

/**
 * Reports every SKU that appears more than once, with its count. Empty
 * when every SKU is unique. Collisions here are a hard stop for
 * `generate-skus.ts` -- these codes go into Square and become the
 * permanent join key between two systems.
 */
export function checkCollisions(skus: string[]): Array<{ sku: string; count: number }> {
  const counts = new Map<string, number>()
  for (const sku of skus) counts.set(sku, (counts.get(sku) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([sku, count]) => ({ sku, count }))
}
