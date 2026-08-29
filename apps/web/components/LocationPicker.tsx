'use client'

import { useMemo } from 'react'
import type { LocationDto } from '@winterborn/shared'

/// Location dropdown for the catalog browser. Splits options into
/// "Warehouses" and "Markets" groups (via <optgroup>) so the two kinds
/// stay visually separated. Value is the current location id — parent
/// state, usually driven by a URL query param.
///
/// Hidden entirely for market managers: they're pinned server-side to
/// their own market and have nothing to switch to. Callers still render
/// the picker in the same slot so the surrounding layout stays stable;
/// this component just returns null when the user isn't allowed to
/// switch.
export function LocationPicker({
  value,
  onChange,
  locations,
  canSwitch,
}: {
  value: string | null
  onChange: (locationId: string) => void
  locations: LocationDto[]
  canSwitch: boolean
}) {
  const { warehouses, markets } = useMemo(() => {
    const w: LocationDto[] = []
    const m: LocationDto[] = []
    for (const loc of locations) {
      if (!loc.isActive) continue
      if (loc.kind === 'WAREHOUSE') w.push(loc)
      else m.push(loc)
    }
    w.sort((a, b) => a.name.localeCompare(b.name))
    m.sort((a, b) => a.name.localeCompare(b.name))
    return { warehouses: w, markets: m }
  }, [locations])

  if (!canSwitch) return null

  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: '0.82rem',
        color: 'var(--text-dim)',
      }}
    >
      <span style={{ fontWeight: 600 }}>Location:</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '6px 10px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--line)',
          background: 'var(--surface)',
          fontSize: '0.85rem',
          minWidth: 200,
        }}
      >
        {warehouses.length > 0 && (
          <optgroup label="Warehouses">
            {warehouses.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </optgroup>
        )}
        {markets.length > 0 && (
          <optgroup label="Markets">
            {markets.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  )
}
