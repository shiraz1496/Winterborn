import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type {
  CategoryDto,
  ColourFamilyDto,
  CreateWarehouseVariantInput,
  LocationDto,
  LowStockRow,
  SizeOptionDto,
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

  async listCategories(): Promise<CategoryDto[]> {
    const rows = await this.prisma.category.findMany({ orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, name: r.name }))
  }

  async listSizeOptions(categoryId?: string): Promise<SizeOptionDto[]> {
    const rows = await this.prisma.sizeOption.findMany({
      where: categoryId ? { categoryId } : undefined,
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    })
    return rows.map((r) => ({ id: r.id, categoryId: r.categoryId, name: r.name }))
  }

  /// Doc 3 §3.1's "authorised user creates the missing product" branch of
  /// intake. Category, family, and size are picked from the controlled
  /// vocabulary (existing rows). Item group and colour variant reuse an
  /// existing row if one already matches on the schema's unique keys,
  /// otherwise a new row is created -- the same find-or-create pattern the
  /// Sortly importer uses. Warehouse SKU is generated server-side so a
  /// Sunday operator never invents a colliding one by hand.
  async createWarehouseVariant(input: CreateWarehouseVariantInput): Promise<WarehouseVariantSummary> {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findUnique({ where: { id: input.categoryId } })
      if (!category) throw new NotFoundException(`category ${input.categoryId} not found`)

      const colourFamily = await tx.colourFamily.findUnique({ where: { id: input.colourFamilyId } })
      if (!colourFamily) throw new NotFoundException(`colour family ${input.colourFamilyId} not found`)
      if (colourFamily.categoryId !== category.id) {
        throw new BadRequestException(`colour family belongs to a different category`)
      }

      const sizeOption = await tx.sizeOption.findUnique({ where: { id: input.sizeOptionId } })
      if (!sizeOption) throw new NotFoundException(`size option ${input.sizeOptionId} not found`)
      if (sizeOption.categoryId !== category.id) {
        throw new BadRequestException(`size option belongs to a different category`)
      }

      const itemGroupName = input.itemGroupName.trim()
      const colourVariantName = input.colourVariantName.trim()

      const itemGroup = await upsertByUnique(
        () => tx.itemGroup.findUnique({ where: { categoryId_name: { categoryId: category.id, name: itemGroupName } } }),
        () => tx.itemGroup.create({ data: { categoryId: category.id, name: itemGroupName, brand: 'OWN' } }),
      )

      const colourVariant = await upsertByUnique(
        () =>
          tx.colourVariant.findUnique({
            where: { colourFamilyId_name: { colourFamilyId: colourFamily.id, name: colourVariantName } },
          }),
        () =>
          tx.colourVariant.create({
            data: {
              colourFamilyId: colourFamily.id,
              name: colourVariantName,
              normalisedName: colourVariantName.toLowerCase(),
              familyAssignmentSource: 'MANUAL',
              familyConfidence: 1,
            },
          }),
      )

      const variationSeed = `${category.name}-${itemGroupName}-${colourFamily.name}-${sizeOption.name}`
      const variation = await upsertByUnique(
        () =>
          tx.variation.findUnique({
            where: {
              itemGroupId_colourFamilyId_sizeOptionId: {
                itemGroupId: itemGroup.id,
                colourFamilyId: colourFamily.id,
                sizeOptionId: sizeOption.id,
              },
            },
          }),
        () =>
          tx.variation.create({
            data: {
              itemGroupId: itemGroup.id,
              colourFamilyId: colourFamily.id,
              sizeOptionId: sizeOption.id,
              tillSku: `${slugify(colourFamily.name)}-${shortHash(variationSeed)}`,
            },
          }),
      )

      const existingWv = await tx.warehouseVariant.findUnique({
        where: {
          itemGroupId_colourVariantId_sizeOptionId: {
            itemGroupId: itemGroup.id,
            colourVariantId: colourVariant.id,
            sizeOptionId: sizeOption.id,
          },
        },
      })
      if (existingWv) {
        throw new BadRequestException(
          `this product already exists (warehouse SKU ${existingWv.warehouseSku}) -- search for it instead`,
        )
      }

      const warehouseSkuSeed = `${itemGroup.id}-${colourVariant.id}-${sizeOption.id}`
      const warehouseSku = `WV-${slugify(colourVariantName)}-${shortHash(warehouseSkuSeed)}`
      const created = await tx.warehouseVariant.create({
        data: {
          itemGroupId: itemGroup.id,
          colourVariantId: colourVariant.id,
          sizeOptionId: sizeOption.id,
          variationId: variation.id,
          warehouseSku,
        },
      })

      return {
        id: created.id,
        variationId: variation.id,
        itemGroupName: itemGroup.name,
        colourVariantName: colourVariant.name,
        sizeOptionName: sizeOption.name,
        warehouseSku: created.warehouseSku,
      }
    })
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

async function upsertByUnique<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find()
  if (existing) return existing
  return create()
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
