import { isMultiFamily, swatchFor } from '../lib/colours'

/// The recurring visual signature: a family or variant is shown as its
/// actual colour, not just a text label. `familyName` undefined/null (or
/// explicitly "No Colour") renders the dashed empty swatch -- a deliberate,
/// legitimate answer, not a missing-data warning.
export function Swatch({
  familyName,
  size = 'md',
}: {
  familyName: string | null | undefined
  size?: 'md' | 'lg'
}) {
  const sizeClass = size === 'lg' ? 'swatch swatch-lg' : 'swatch'

  if (!familyName || familyName === 'No Colour') {
    return <span className={`${sizeClass} swatch-none`} aria-label="No colour" />
  }
  if (isMultiFamily(familyName)) {
    return <span className={`${sizeClass} swatch-multi`} aria-label="Multi" />
  }
  const hex = swatchFor(familyName)
  if (!hex) {
    return <span className={`${sizeClass} swatch-none`} aria-label={familyName} />
  }
  return <span className={sizeClass} style={{ background: hex }} aria-label={familyName} />
}
