'use client'

import { useMemo } from 'react'
import type { LocationDto } from '@winterborn/shared'
import { SearchableSelect, type SearchableOption } from './SearchableSelect'

/// Location dropdown for the catalog browser. Uses the app-wide
/// SearchableSelect so behaviour matches every other dropdown (search,
/// keyboard nav, hover highlight). Warehouses come first, then markets;
/// each option is prefixed with its kind so the two groups stay
/// distinguishable in the flat list SearchableSelect renders.
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
  const options = useMemo<SearchableOption[]>(() => {
    const w: SearchableOption[] = []
    const m: SearchableOption[] = []
    for (const loc of locations) {
      if (!loc.isActive) continue
      if (loc.kind === 'WAREHOUSE') {
        w.push({ id: loc.id, label: `Warehouse · ${loc.name}` })
      } else {
        m.push({ id: loc.id, label: `Market · ${loc.name}` })
      }
    }
    w.sort((a, b) => a.label.localeCompare(b.label))
    m.sort((a, b) => a.label.localeCompare(b.label))
    return [...w, ...m]
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
        minWidth: 260,
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <SearchableSelect
          value={value}
          options={options}
          placeholder="— pick a location —"
          onChange={(id) => id && onChange(id)}
          size="sm"
          showId={false}
          allowClear={false}
        />
      </div>
    </label>
  )
}
