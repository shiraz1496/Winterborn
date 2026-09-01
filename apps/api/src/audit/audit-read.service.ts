import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'

/// Read side of the audit trail. Unifies AuditLog (state + config changes)
/// and LedgerEvent (inventory movements) into one chronological stream so
/// the owner's audit viewer shows a complete "who did what where when why
/// how" record without switching tabs.
///
/// Response is paginated by `cursor` (an ISO timestamp) rather than page
/// number so a busy audit trail can keep loading older entries even while
/// new ones land at the top.

export interface AuditEntry {
  id: string
  at: string
  source: string
  actorId: string | null
  actorName: string | null
  actorRole: string | null
  locationId: string | null
  locationName: string | null
  entity: string
  entityId: string
  /// Human-readable label for the affected entity (product name, user
  /// name, box label…). Best-effort — resolves to null if the entity was
  /// deleted after the audit was written. The frontend falls back to the
  /// entity id when this is null.
  entityDisplayName: string | null
  field: string
  oldValue: string | null
  newValue: string | null
  /// When `oldValue`/`newValue` are foreign-key ids (locationId,
  /// categoryId, colourFamilyId, sizeOptionId, colourVariantId), we
  /// resolve them to the referenced row's display name so the frontend
  /// never has to render an opaque cuid. Null otherwise.
  oldValueDisplay: string | null
  newValueDisplay: string | null
  reason: string | null
  origin: 'AUDIT_LOG' | 'LEDGER_EVENT'
}

export interface AuditListParams {
  cursor?: string
  limit?: number
  entity?: string
  actorId?: string
  origin?: 'AUDIT_LOG' | 'LEDGER_EVENT'
  from?: string
  to?: string
  source?: string
}

@Injectable()
export class AuditReadService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: AuditListParams): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
    const cursorAt = params.cursor ? new Date(params.cursor) : null
    const fromAt = params.from ? new Date(params.from) : null
    const toAt = params.to ? new Date(params.to) : null

    // Pull `limit + 1` from each side so the merged, sliced result is at
    // least `limit` long even when one side clusters around the same
    // timestamp — we detect "there's more" by whether we got that overshoot.
    const overFetch = limit + 1

    const auditWhere: Prisma.AuditLogWhereInput = {}
    const ledgerWhere: Prisma.LedgerEventWhereInput = {}

    if (cursorAt) {
      auditWhere.at = { lt: cursorAt }
      ledgerWhere.recordedAt = { lt: cursorAt }
    }
    if (fromAt) {
      auditWhere.at = { ...(auditWhere.at as object), gte: fromAt }
      ledgerWhere.recordedAt = { ...(ledgerWhere.recordedAt as object), gte: fromAt }
    }
    if (toAt) {
      auditWhere.at = { ...(auditWhere.at as object), lte: toAt }
      ledgerWhere.recordedAt = { ...(ledgerWhere.recordedAt as object), lte: toAt }
    }
    if (params.actorId) {
      auditWhere.actorId = params.actorId
      ledgerWhere.actorId = params.actorId
    }
    if (params.entity) {
      auditWhere.entity = params.entity
    }
    // Source filtering is enum-aware: AuditSource and LedgerSource are two
    // separate Prisma enums with an overlap ({UI, WEBHOOK}) plus values
    // unique to each side ({API, CLI, MIGRATION, SYSTEM} for audits,
    // {POLL, SCRIPT} for ledger). A blind assignment to both sides throws
    // a Prisma runtime error the moment the operator picks a value that's
    // only valid on one side (e.g. selecting "Migration" would 500 the
    // whole page). Instead: only apply the filter to the side where the
    // value is legal, and skip the other side entirely so we don't drown
    // the "MIGRATION rows" query in unrelated ledger events.
    const AUDIT_SOURCES = new Set(['UI', 'API', 'CLI', 'MIGRATION', 'WEBHOOK', 'SYSTEM'])
    const LEDGER_SOURCES = new Set(['UI', 'WEBHOOK', 'POLL', 'SCRIPT'])
    const sourceIsAudit = params.source ? AUDIT_SOURCES.has(params.source) : false
    const sourceIsLedger = params.source ? LEDGER_SOURCES.has(params.source) : false
    if (params.source && sourceIsAudit) {
      auditWhere.source = params.source as Prisma.EnumAuditSourceFilter['equals']
    }
    if (params.source && sourceIsLedger) {
      ledgerWhere.source = params.source as Prisma.EnumLedgerSourceFilter['equals']
    }

    // If a source was picked, exclude the side where it's not valid — the
    // owner asked "show me MIGRATION things", they don't want ledger noise
    // in the response even though ledger has no MIGRATION rows to skip.
    const sourceExcludesAudit = !!params.source && !sourceIsAudit
    const sourceExcludesLedger = !!params.source && !sourceIsLedger

    const fetchAudit = params.origin !== 'LEDGER_EVENT' && !sourceExcludesAudit
    const fetchLedger = params.origin !== 'AUDIT_LOG' && !params.entity && !sourceExcludesLedger

    const [auditRows, ledgerRows] = await Promise.all([
      fetchAudit
        ? this.prisma.auditLog.findMany({
            where: auditWhere,
            orderBy: { at: 'desc' },
            take: overFetch,
          })
        : Promise.resolve([]),
      fetchLedger
        ? this.prisma.ledgerEvent.findMany({
            where: ledgerWhere,
            orderBy: { recordedAt: 'desc' },
            take: overFetch,
            include: { location: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ])

    // Enrich actor names in one bulk fetch — cheaper than N per-row lookups
    // and safe even if a user has been deleted (name resolves to null).
    const actorIds = new Set<string>()
    for (const r of auditRows) if (r.actorId) actorIds.add(r.actorId)
    for (const r of ledgerRows) if (r.actorId) actorIds.add(r.actorId)

    const locationIds = new Set<string>()
    for (const r of auditRows) if (r.locationId) locationIds.add(r.locationId)

    const [actors, extraLocations] = await Promise.all([
      actorIds.size > 0
        ? this.prisma.user.findMany({
            where: { id: { in: [...actorIds] } },
            select: { id: true, name: true, role: true },
          })
        : Promise.resolve([]),
      locationIds.size > 0
        ? this.prisma.location.findMany({
            where: { id: { in: [...locationIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ])

    const actorById = new Map(actors.map((u) => [u.id, u]))
    const locationById = new Map(extraLocations.map((l) => [l.id, l.name]))

    // Bulk-resolve entity display names, keyed by (entity type + id). Any
    // ID we can't find (row deleted after the audit was written) resolves
    // to null; the frontend falls back to the raw id.
    const idsByEntity = new Map<string, Set<string>>()
    for (const row of auditRows) {
      const set = idsByEntity.get(row.entity) ?? new Set()
      set.add(row.entityId)
      idsByEntity.set(row.entity, set)
    }
    for (const row of ledgerRows) {
      const type = row.warehouseVariantId ? 'WarehouseVariant' : 'Variation'
      const id = row.warehouseVariantId ?? row.variationId
      const set = idsByEntity.get(type) ?? new Set()
      set.add(id)
      idsByEntity.set(type, set)
    }
    const displayNames = await this.resolveEntityNames(idsByEntity, actorById, locationById)
    const fkDisplays = await this.resolveForeignKeyValues(auditRows, locationById)

    const resolveValue = (field: string, value: string | null): string | null => {
      if (!value) return null
      return fkDisplays.get(`${field}:${value}`) ?? null
    }

    const auditEntries: AuditEntry[] = auditRows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      source: r.source,
      actorId: r.actorId,
      actorName: r.actorId ? actorById.get(r.actorId)?.name ?? null : null,
      actorRole: r.actorRole ?? (r.actorId ? actorById.get(r.actorId)?.role ?? null : null),
      locationId: r.locationId,
      locationName: r.locationId ? locationById.get(r.locationId) ?? null : null,
      entity: r.entity,
      entityId: r.entityId,
      entityDisplayName: displayNames.get(`${r.entity}:${r.entityId}`) ?? null,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      oldValueDisplay: resolveValue(r.field, r.oldValue),
      newValueDisplay: resolveValue(r.field, r.newValue),
      reason: r.reason,
      origin: 'AUDIT_LOG',
    }))

    const ledgerEntries: AuditEntry[] = ledgerRows.map((r) => ({
      id: r.id,
      at: r.recordedAt.toISOString(),
      source: r.source,
      actorId: r.actorId,
      actorName: r.actorId ? actorById.get(r.actorId)?.name ?? null : null,
      actorRole: r.actorId ? actorById.get(r.actorId)?.role ?? null : null,
      locationId: r.locationId,
      locationName: r.location?.name ?? null,
      entity: r.warehouseVariantId ? 'WarehouseVariant' : 'Variation',
      entityId: r.warehouseVariantId ?? r.variationId,
      entityDisplayName:
        displayNames.get(`${r.warehouseVariantId ? 'WarehouseVariant' : 'Variation'}:${r.warehouseVariantId ?? r.variationId}`) ??
        null,
      field: r.type,
      oldValue: null,
      newValue: String(r.quantity),
      oldValueDisplay: null,
      newValueDisplay: null,
      reason: r.reason ?? r.note ?? null,
      origin: 'LEDGER_EVENT',
    }))

    // Merge sort by timestamp desc, then take the requested limit.
    const merged = [...auditEntries, ...ledgerEntries].sort((a, b) => b.at.localeCompare(a.at))
    const page = merged.slice(0, limit)
    const nextCursor = merged.length > limit ? page[page.length - 1]?.at ?? null : null

    return { entries: page, nextCursor }
  }

  /// Bulk-resolve display names for every (entity, id) pair the current
  /// audit page references. One Prisma call per entity type — total is
  /// O(distinct entity types on the page), never O(rows). Callers key
  /// into the returned map with `${entity}:${entityId}`.
  private async resolveEntityNames(
    idsByEntity: Map<string, Set<string>>,
    actorById: Map<string, { id: string; name: string; role: string }>,
    locationById: Map<string, string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>()

    const wvIds = [...(idsByEntity.get('WarehouseVariant') ?? [])]
    if (wvIds.length > 0) {
      const rows = await this.prisma.warehouseVariant.findMany({
        where: { id: { in: wvIds } },
        select: {
          id: true,
          warehouseSku: true,
          itemGroup: { select: { name: true } },
          colourVariant: { select: { name: true } },
          sizeOption: { select: { name: true } },
        },
      })
      for (const r of rows) {
        const parts = [r.itemGroup.name, r.colourVariant.name, r.sizeOption.name].filter(Boolean)
        // Drop the SKU string — it's a technical identifier, not something
        // an owner reading the log wants to see inline. The expanded panel
        // still has entity/id if a support engineer needs to look it up.
        out.set(`WarehouseVariant:${r.id}`, parts.join(' · '))
      }
    }

    const variationIds = [...(idsByEntity.get('Variation') ?? [])]
    if (variationIds.length > 0) {
      const rows = await this.prisma.variation.findMany({
        where: { id: { in: variationIds } },
        select: {
          id: true,
          itemGroup: { select: { name: true } },
          colourFamily: { select: { name: true } },
          sizeOption: { select: { name: true } },
        },
      })
      for (const r of rows) {
        out.set(
          `Variation:${r.id}`,
          `${r.itemGroup.name} · ${r.colourFamily.name} · ${r.sizeOption.name}`,
        )
      }
    }

    const igIds = [...(idsByEntity.get('ItemGroup') ?? [])]
    if (igIds.length > 0) {
      const rows = await this.prisma.itemGroup.findMany({
        where: { id: { in: igIds } },
        select: { id: true, name: true },
      })
      for (const r of rows) out.set(`ItemGroup:${r.id}`, r.name)
    }

    const cvIds = [...(idsByEntity.get('ColourVariant') ?? [])]
    if (cvIds.length > 0) {
      const rows = await this.prisma.colourVariant.findMany({
        where: { id: { in: cvIds } },
        select: { id: true, name: true },
      })
      for (const r of rows) out.set(`ColourVariant:${r.id}`, r.name)
    }

    const categoryIds = [...(idsByEntity.get('Category') ?? [])]
    if (categoryIds.length > 0) {
      const rows = await this.prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true },
      })
      for (const r of rows) out.set(`Category:${r.id}`, r.name)
    }

    const userIds = [...(idsByEntity.get('User') ?? [])]
    if (userIds.length > 0) {
      // Just the name — raw role enums like "WAREHOUSE_MANAGER" would
      // leak into the row otherwise. Frontend already renders a friendly
      // role label alongside the actor pill; adding it again on the
      // target reads as "JZ (WAREHOUSE_MANAGER)" which is exactly what
      // the owner complained about.
      const missing = userIds.filter((id) => !actorById.has(id))
      for (const id of userIds) {
        const a = actorById.get(id)
        if (a) out.set(`User:${id}`, a.name)
      }
      if (missing.length > 0) {
        const rows = await this.prisma.user.findMany({
          where: { id: { in: missing } },
          select: { id: true, name: true },
        })
        for (const r of rows) out.set(`User:${r.id}`, r.name)
      }
    }

    const boxIds = [...(idsByEntity.get('Box') ?? [])]
    if (boxIds.length > 0) {
      const rows = await this.prisma.box.findMany({
        where: { id: { in: boxIds } },
        select: {
          id: true,
          qrToken: true,
          destinationLocation: { select: { name: true } },
          _count: { select: { lines: true } },
        },
      })
      for (const r of rows) {
        out.set(
          `Box:${r.id}`,
          `Box → ${r.destinationLocation.name} (${r._count.lines} line${r._count.lines === 1 ? '' : 's'})`,
        )
      }
    }

    const loadIds = [...(idsByEntity.get('Load') ?? [])]
    if (loadIds.length > 0) {
      const rows = await this.prisma.load.findMany({
        where: { id: { in: loadIds } },
        select: { id: true, vehicleLabel: true, destinationLocation: { select: { name: true } } },
      })
      for (const r of rows) out.set(`Load:${r.id}`, `${r.vehicleLabel} → ${r.destinationLocation.name}`)
    }

    const requestIds = [...(idsByEntity.get('RestockRequest') ?? [])]
    if (requestIds.length > 0) {
      const rows = await this.prisma.restockRequest.findMany({
        where: { id: { in: requestIds } },
        select: {
          id: true,
          state: true,
          location: { select: { name: true } },
          _count: { select: { lines: true } },
        },
      })
      for (const r of rows) {
        out.set(
          `RestockRequest:${r.id}`,
          `Request for ${r.location.name} — ${r._count.lines} line${r._count.lines === 1 ? '' : 's'}`,
        )
      }
    }

    // Threshold — one row references (variation, location); show both.
    const thresholdIds = [...(idsByEntity.get('Threshold') ?? [])]
    if (thresholdIds.length > 0) {
      const rows = await this.prisma.threshold.findMany({
        where: { id: { in: thresholdIds } },
        select: {
          id: true,
          minLevel: true,
          location: { select: { name: true } },
          variation: {
            select: {
              itemGroup: { select: { name: true } },
              colourFamily: { select: { name: true } },
              sizeOption: { select: { name: true } },
            },
          },
        },
      })
      for (const r of rows) {
        out.set(
          `Threshold:${r.id}`,
          `${r.variation.itemGroup.name} · ${r.variation.colourFamily.name} · ${r.variation.sizeOption.name} @ ${r.location.name}`,
        )
      }
    }

    // Fall back to location names for any location-shaped entity we
    // recognise (Load, Box, RestockRequest above already resolved theirs;
    // a bare Location edit would land here).
    const locIds = [...(idsByEntity.get('Location') ?? [])]
    if (locIds.length > 0) {
      const rows = await this.prisma.location.findMany({
        where: { id: { in: locIds } },
        select: { id: true, name: true, kind: true },
      })
      for (const r of rows) out.set(`Location:${r.id}`, `${r.name} (${r.kind})`)
    }

    // Silence lint about the unused actorById fallback map — kept as a
    // parameter so future entity types (e.g. Session) can look up owner
    // names without re-fetching.
    void locationById

    return out
  }

  /// Resolve foreign-key ids stored in `oldValue`/`newValue` to human
  /// names. Keyed by `${field}:${id}` so the caller can look up either
  /// side of a change without ambiguity.
  private async resolveForeignKeyValues(
    rows: Array<{ field: string; oldValue: string | null; newValue: string | null }>,
    locationById: Map<string, string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>()

    const locationIds = new Set<string>()
    const categoryIds = new Set<string>()
    const familyIds = new Set<string>()
    const sizeIds = new Set<string>()
    const colourVariantIds = new Set<string>()

    for (const r of rows) {
      const collect = (val: string | null, set: Set<string>) => {
        if (val) set.add(val)
      }
      if (r.field === 'locationId') {
        collect(r.oldValue, locationIds)
        collect(r.newValue, locationIds)
      } else if (r.field === 'categoryId') {
        collect(r.oldValue, categoryIds)
        collect(r.newValue, categoryIds)
      } else if (r.field === 'colourFamilyId') {
        collect(r.oldValue, familyIds)
        collect(r.newValue, familyIds)
      } else if (r.field === 'sizeOptionId') {
        collect(r.oldValue, sizeIds)
        collect(r.newValue, sizeIds)
      } else if (r.field === 'colourVariantId') {
        collect(r.oldValue, colourVariantIds)
        collect(r.newValue, colourVariantIds)
      }
    }

    // Locations we can serve straight from the cache built for the audit
    // location column; only extras need a fetch.
    const missingLocationIds = [...locationIds].filter((id) => !locationById.has(id))
    for (const id of locationIds) {
      const name = locationById.get(id)
      if (name) out.set(`locationId:${id}`, name)
    }
    if (missingLocationIds.length > 0) {
      const extra = await this.prisma.location.findMany({
        where: { id: { in: missingLocationIds } },
        select: { id: true, name: true },
      })
      for (const l of extra) out.set(`locationId:${l.id}`, l.name)
    }

    if (categoryIds.size > 0) {
      const rows = await this.prisma.category.findMany({
        where: { id: { in: [...categoryIds] } },
        select: { id: true, name: true },
      })
      for (const c of rows) out.set(`categoryId:${c.id}`, c.name)
    }

    if (familyIds.size > 0) {
      const rows = await this.prisma.colourFamily.findMany({
        where: { id: { in: [...familyIds] } },
        select: { id: true, name: true },
      })
      for (const f of rows) out.set(`colourFamilyId:${f.id}`, f.name)
    }

    if (sizeIds.size > 0) {
      const rows = await this.prisma.sizeOption.findMany({
        where: { id: { in: [...sizeIds] } },
        select: { id: true, name: true },
      })
      for (const s of rows) out.set(`sizeOptionId:${s.id}`, s.name)
    }

    if (colourVariantIds.size > 0) {
      const rows = await this.prisma.colourVariant.findMany({
        where: { id: { in: [...colourVariantIds] } },
        select: { id: true, name: true },
      })
      for (const cv of rows) out.set(`colourVariantId:${cv.id}`, cv.name)
    }

    return out
  }
}
