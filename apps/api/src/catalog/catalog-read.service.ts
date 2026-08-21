import { Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type {
  ColourFamilyDto,
  LocationDto,
  LowStockRow,
  ThresholdDto,
  UnassignedColourVariant,
  VariationSummary,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'

/// The name catalog-import (Task 2 of the earlier catalog plan) leaves every
/// colour variant in until a human or the lexical pass reassigns it. See
/// catalog.module.ts's SortlyImportService and cli/assign-families.ts.
const UNASSIGNED_FAMILY_NAME = 'Unassigned'

/// The legitimate "this genuinely has no colour" destination (spec §6.3's
/// /admin/colours screen). Distinct from Unassigned: Unassigned means
/// "nobody has looked at this yet", No Colour means "somebody looked and
/// there is no colour to assign" -- both are real, different states.
const NO_COLOUR_FAMILY_NAME = 'No Colour'

/**
 * Read-only query surface for the frontend: locations, catalog metadata
 * flattened to display names, thresholds, and the /admin/colours residual
 * queue. Nothing here writes except `assignColourFamily` and
 * `ensureNoColourFamily`, both idempotent find-or-create/update operations
 * mirroring the pattern already used by SortlyImportService.
 */
@Injectable()
export class CatalogReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerRead: LedgerReadService,
  ) {}

  async listLocations(): Promise<LocationDto[]> {
    const rows = await this.prisma.location.findMany({ orderBy: { name: 'asc' } })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      timezone: r.timezone,
      isActive: r.isActive,
    }))
  }

  async listVariations(): Promise<VariationSummary[]> {
    const rows = await this.prisma.variation.findMany({
      include: { itemGroup: { include: { category: true } }, colourFamily: true, sizeOption: true },
      orderBy: [{ itemGroup: { name: 'asc' } }],
    })
    return rows.map((r) => ({
      id: r.id,
      itemGroupName: r.itemGroup.name,
      categoryName: r.itemGroup.category.name,
      colourFamilyName: r.colourFamily.name,
      sizeOptionName: r.sizeOption.name,
      tillSku: r.tillSku,
    }))
  }

  async listWarehouseVariants(variationId?: string): Promise<WarehouseVariantSummary[]> {
    const rows = await this.prisma.warehouseVariant.findMany({
      where: variationId ? { variationId } : undefined,
      include: { itemGroup: true, colourVariant: true, sizeOption: true },
      orderBy: [{ colourVariant: { name: 'asc' } }],
    })
    return rows.map((r) => ({
      id: r.id,
      variationId: r.variationId,
      itemGroupName: r.itemGroup.name,
      colourVariantName: r.colourVariant.name,
      sizeOptionName: r.sizeOption.name,
      warehouseSku: r.warehouseSku,
    }))
  }

  async listThresholds(locationId?: string): Promise<ThresholdDto[]> {
    const rows = await this.prisma.threshold.findMany({ where: locationId ? { locationId } : undefined })
    return rows.map((r) => ({ id: r.id, variationId: r.variationId, locationId: r.locationId, minLevel: r.minLevel }))
  }

  /// Every family-level stock row at or under its threshold. Two small
  /// queries joined in memory rather than a hand-rolled SQL join: the sets
  /// involved are tiny (thresholds are one row per variation x market) and
  /// this keeps the "on-hand" arithmetic itself entirely inside
  /// LedgerReadService, which is the one place that owns it.
  async lowStock(locationId?: string): Promise<LowStockRow[]> {
    const [stock, thresholds] = await Promise.all([
      this.ledgerRead.onHandByFamily(locationId),
      this.listThresholds(locationId),
    ])
    const byKey = new Map(stock.map((s) => [`${s.variationId}::${s.locationId}`, s.onHand]))
    const out: LowStockRow[] = []
    for (const t of thresholds) {
      const onHand = byKey.get(`${t.variationId}::${t.locationId}`) ?? 0
      if (onHand <= t.minLevel) {
        out.push({ variationId: t.variationId, locationId: t.locationId, onHand, minLevel: t.minLevel })
      }
    }
    return out
  }

  async listUnassignedColourVariants(): Promise<UnassignedColourVariant[]> {
    const rows = await this.prisma.colourVariant.findMany({
      where: { colourFamily: { name: UNASSIGNED_FAMILY_NAME } },
      include: { colourFamily: { include: { category: true } } },
      orderBy: { name: 'asc' },
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sortlyName: r.sortlyName,
      photoUrl: r.photoUrl,
      categoryId: r.colourFamily.categoryId,
      categoryName: r.colourFamily.category.name,
    }))
  }

  /// Real, pickable families for a category -- excludes the Unassigned
  /// bucket (that is a queue, not a destination) and always includes a
  /// "No Colour" option so a warehouse variant that genuinely has no
  /// colour has a legitimate, non-guessed place to go.
  async listColourFamilies(categoryId: string): Promise<ColourFamilyDto[]> {
    await this.ensureNoColourFamily(categoryId)
    const rows = await this.prisma.colourFamily.findMany({
      where: { categoryId, name: { notIn: [UNASSIGNED_FAMILY_NAME] } },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    })
    return rows.map((r) => ({ id: r.id, categoryId: r.categoryId, name: r.name }))
  }

  private async ensureNoColourFamily(categoryId: string): Promise<void> {
    const existing = await this.prisma.colourFamily.findUnique({
      where: { categoryId_name: { categoryId, name: NO_COLOUR_FAMILY_NAME } },
    })
    if (existing) return
    await this.prisma.colourFamily.create({ data: { categoryId, name: NO_COLOUR_FAMILY_NAME, displayOrder: 999 } })
  }

  /// Moves a variant out of the residual queue: MANUAL source, full
  /// confidence, since a human (not the lexicon) made this call.
  ///
  /// WarehouseVariant.variationId is a denormalised roll-up of
  /// ColourVariant.colourFamilyId (schema.prisma's comment on that field is
  /// explicit: "maintained on family reassignment"), so every
  /// WarehouseVariant under this colour variant is repointed at the
  /// (itemGroup x new family x size) Variation, creating it if this is the
  /// first warehouse variant to land there -- the same find-or-create
  /// SortlyImportService uses on initial import.
  async assignColourFamily(colourVariantId: string, colourFamilyId: string) {
    return this.prisma.$transaction(async (tx) => {
      const variant = await tx.colourVariant.findUnique({ where: { id: colourVariantId } })
      if (!variant) throw new NotFoundException(`colour variant ${colourVariantId} not found`)

      const family = await tx.colourFamily.findUnique({ where: { id: colourFamilyId } })
      if (!family) throw new NotFoundException(`colour family ${colourFamilyId} not found`)

      const updated = await tx.colourVariant.update({
        where: { id: colourVariantId },
        data: { colourFamilyId, familyAssignmentSource: 'MANUAL', familyConfidence: 1 },
      })

      const warehouseVariants = await tx.warehouseVariant.findMany({ where: { colourVariantId } })
      const variationCache = new Map<string, string>()
      for (const wv of warehouseVariants) {
        const cacheKey = `${wv.itemGroupId}::${wv.sizeOptionId}`
        let variationId = variationCache.get(cacheKey)
        if (!variationId) {
          const existing = await tx.variation.findUnique({
            where: {
              itemGroupId_colourFamilyId_sizeOptionId: {
                itemGroupId: wv.itemGroupId,
                colourFamilyId,
                sizeOptionId: wv.sizeOptionId,
              },
            },
          })
          if (existing) {
            variationId = existing.id
          } else {
            const seed = `${wv.itemGroupId}-${colourFamilyId}-${wv.sizeOptionId}`
            const tillSku = `${slugify(family.name)}-${shortHash(seed)}`
            const created = await tx.variation.create({
              data: { itemGroupId: wv.itemGroupId, colourFamilyId, sizeOptionId: wv.sizeOptionId, tillSku },
            })
            variationId = created.id
          }
          variationCache.set(cacheKey, variationId)
        }
        if (wv.variationId !== variationId) {
          await tx.warehouseVariant.update({ where: { id: wv.id }, data: { variationId } })
        }
      }

      return updated
    })
  }
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'X'
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8)
}
