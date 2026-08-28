import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import type {
  CategoryDto,
  ColourFamilyDto,
  CreateWarehouseVariantInput,
  LocationDto,
  LowStockRow,
  SizeOptionDto,
  SquareMappingRow,
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
            },
          }),
      )

      // Legacy composite unique on (itemGroup, colourVariant, sizeOption) was
      // dropped when the flexible attribute model took over — see the
      // 20260827130000 migration. Fall back to findFirst against those three
      // columns for the "duplicate SKU" pre-check.
      const existingWv = await tx.warehouseVariant.findFirst({
        where: {
          itemGroupId: itemGroup.id,
          colourVariantId: colourVariant.id,
          sizeOptionId: sizeOption.id,
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
            const created = await tx.variation.create({
              data: { itemGroupId: wv.itemGroupId, colourFamilyId, sizeOptionId: wv.sizeOptionId },
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

  /// One row per Variation with the two Square IDs the sales-webhook path
  /// depends on. The ItemGroup ID is denormalised in so a paste on the
  /// item-level field can hit the right row without a second lookup, and
  /// the item-level squareItemId is bubbled up from ItemGroup so the whole
  /// row shows current state after either PATCH.
  async listSquareMapping(): Promise<SquareMappingRow[]> {
    const rows = await this.prisma.variation.findMany({
      include: {
        itemGroup: { include: { category: true } },
        colourFamily: true,
        sizeOption: true,
        // The warehouse variants nested under each Variation are the real
        // per-colour SKUs that Square sells; the operator maps
        // squareVariationId here to get variant-level SALE decrements. Sorted
        // alphabetically by colour variant so the UI renders in a stable order.
        warehouseVariants: {
          include: { colourVariant: true, sizeOption: true },
          orderBy: [{ colourVariant: { name: 'asc' } }, { sizeOption: { name: 'asc' } }],
        },
      },
      orderBy: [{ itemGroup: { name: 'asc' } }, { colourFamily: { name: 'asc' } }, { sizeOption: { name: 'asc' } }],
    })
    return rows.map((r) => ({
      variationId: r.id,
      itemGroupId: r.itemGroupId,
      itemGroupName: r.itemGroup.name,
      categoryName: r.itemGroup.category.name,
      colourFamilyName: r.colourFamily.name,
      sizeOptionName: r.sizeOption.name,
      squareItemId: r.itemGroup.squareItemId,
      squareVariationId: r.squareVariationId,
      warehouseVariants: r.warehouseVariants.map((wv) => ({
        warehouseVariantId: wv.id,
        colourVariantName: wv.colourVariant.name,
        sizeOptionName: wv.sizeOption.name,
        warehouseSku: wv.warehouseSku,
        squareVariationId: wv.squareVariationId,
      })),
    }))
  }

  /// Set or clear ItemGroup.squareItemId. Uniqueness collisions on the
  /// column surface as ConflictException so the UI can render "already
  /// assigned to <other item>" instead of a raw 500.
  async setItemGroupSquareId(itemGroupId: string, squareId: string | null) {
    const existing = await this.prisma.itemGroup.findUnique({ where: { id: itemGroupId } })
    if (!existing) throw new NotFoundException(`item group ${itemGroupId} not found`)
    try {
      return await this.prisma.itemGroup.update({
        where: { id: itemGroupId },
        data: { squareItemId: squareId },
        select: { id: true, name: true, squareItemId: true },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`squareItemId "${squareId}" is already assigned to another item group`)
      }
      throw err
    }
  }

  /// Set or clear Variation.squareVariationId. Same P2002 handling as
  /// setItemGroupSquareId -- a single Square variation can only feed one
  /// local Variation, otherwise a sale of 1 would decrement N rows.
  async setVariationSquareId(variationId: string, squareId: string | null) {
    const existing = await this.prisma.variation.findUnique({ where: { id: variationId } })
    if (!existing) throw new NotFoundException(`variation ${variationId} not found`)
    try {
      return await this.prisma.variation.update({
        where: { id: variationId },
        data: { squareVariationId: squareId },
        select: { id: true, squareVariationId: true },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`squareVariationId "${squareId}" is already assigned to another variation`)
      }
      throw err
    }
  }

  /// Set or clear WarehouseVariant.squareVariationId. This is the per-SKU
  /// mapping the mapper checks first (variant-grain resolution); Variation
  /// squareVariationId remains a family-level fallback for single-variant
  /// items. P2002 handling identical to the family-level setter — the same
  /// Square catalog object can never resolve to two different WarehouseVariants.
  async setWarehouseVariantSquareId(warehouseVariantId: string, squareId: string | null) {
    const existing = await this.prisma.warehouseVariant.findUnique({ where: { id: warehouseVariantId } })
    if (!existing) throw new NotFoundException(`warehouse variant ${warehouseVariantId} not found`)
    try {
      return await this.prisma.warehouseVariant.update({
        where: { id: warehouseVariantId },
        data: { squareVariationId: squareId },
        select: { id: true, squareVariationId: true },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`squareVariationId "${squareId}" is already assigned to another warehouse variant`)
      }
      throw err
    }
  }

  /// Every cached Square item, alphabetical by name. `variationCount` lets the
  /// sync page show "42 items · 187 variations" summary rows without a second
  /// round-trip.
  async listSquareCatalogItems() {
    const rows = await this.prisma.squareCatalogItem.findMany({
      include: { _count: { select: { variations: true } } },
      orderBy: { name: 'asc' },
    })
    return rows.map((r) => ({
      squareItemId: r.squareItemId,
      name: r.name,
      categoryName: r.categoryName,
      variationCount: r._count.variations,
      lastSyncedAt: r.lastSyncedAt.toISOString(),
    }))
  }

  /// Variations under one item — feeds the SKU dropdown in the mapping modal.
  async listSquareCatalogVariations(squareItemId: string) {
    const rows = await this.prisma.squareCatalogVariation.findMany({
      where: { squareItemId },
      orderBy: { name: 'asc' },
    })
    return rows.map((r) => ({
      squareVariationId: r.squareVariationId,
      squareItemId: r.squareItemId,
      name: r.name,
      priceCents: r.priceCents,
    }))
  }

  /// Product-list rows for the mapping page. One per ItemGroup, with
  /// mapping-progress counts computed off WarehouseVariant.squareVariationId.
  async listItemGroupMappingProgress() {
    const rows = await this.prisma.itemGroup.findMany({
      include: {
        category: true,
        warehouseVariants: { select: { id: true, squareVariationId: true } },
        _count: { select: { productAttributes: true } },
      },
      orderBy: { name: 'asc' },
    })
    return rows.map((r) => ({
      itemGroupId: r.id,
      itemGroupName: r.name,
      categoryName: r.category.name,
      squareItemId: r.squareItemId,
      totalSkus: r.warehouseVariants.length,
      mappedSkus: r.warehouseVariants.filter((wv) => wv.squareVariationId !== null).length,
      attributeCount: r._count.productAttributes,
    }))
  }

  /// Everything the mapping modal needs for one product. Attributes with
  /// their allowed values, SKUs with their attribute value IDs, plus the
  /// pre-cached Square candidates so the dropdown works offline of Square.
  /// If the item has a squareItemId set, variation candidates are filtered
  /// to that item; otherwise all cached variations are returned (letting the
  /// operator pick an item first and then see its variations).
  async getItemGroupDetail(itemGroupId: string) {
    const ig = await this.prisma.itemGroup.findUnique({
      where: { id: itemGroupId },
      include: {
        category: true,
        productAttributes: {
          include: { values: { orderBy: [{ displayOrder: 'asc' }, { value: 'asc' }] } },
          orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        },
        warehouseVariants: {
          include: {
            colourVariant: true,
            sizeOption: true,
            attributes: { select: { productAttributeValueId: true } },
          },
          orderBy: [{ colourVariant: { name: 'asc' } }, { sizeOption: { name: 'asc' } }],
        },
      },
    })
    if (!ig) throw new NotFoundException(`item group ${itemGroupId} not found`)

    // Fetch every currently-bound squareItemId / squareVariationId across the
    // catalog EXCEPT those belonging to this ItemGroup — so the modal can
    // mark them as "already used" and keep the DB's unique constraints from
    // ever biting the operator at save time.
    const [squareItems, squareVariations, boundItemsElsewhere, boundVariationsElsewhere, boundVariationsAtFamily] = await Promise.all([
      this.prisma.squareCatalogItem.findMany({
        orderBy: { name: 'asc' },
        select: { squareItemId: true, name: true },
      }),
      ig.squareItemId
        ? this.prisma.squareCatalogVariation.findMany({
            where: { squareItemId: ig.squareItemId },
            orderBy: { name: 'asc' },
            select: { squareVariationId: true, squareItemId: true, name: true },
          })
        : this.prisma.squareCatalogVariation.findMany({
            orderBy: [{ squareItemId: 'asc' }, { name: 'asc' }],
            select: { squareVariationId: true, squareItemId: true, name: true },
          }),
      this.prisma.itemGroup.findMany({
        where: { squareItemId: { not: null }, id: { not: itemGroupId } },
        select: { squareItemId: true },
      }),
      this.prisma.warehouseVariant.findMany({
        where: { squareVariationId: { not: null }, itemGroupId: { not: itemGroupId } },
        select: { squareVariationId: true },
      }),
      this.prisma.variation.findMany({
        where: { squareVariationId: { not: null }, itemGroupId: { not: itemGroupId } },
        select: { squareVariationId: true },
      }),
    ])

    const boundItemIds = new Set(boundItemsElsewhere.map((r) => r.squareItemId).filter((v): v is string => v !== null))
    const boundVariationIds = new Set([
      ...boundVariationsElsewhere.map((r) => r.squareVariationId).filter((v): v is string => v !== null),
      ...boundVariationsAtFamily.map((r) => r.squareVariationId).filter((v): v is string => v !== null),
    ])

    return {
      itemGroupId: ig.id,
      itemGroupName: ig.name,
      categoryName: ig.category.name,
      squareItemId: ig.squareItemId,
      attributes: ig.productAttributes.map((a) => ({
        id: a.id,
        name: a.name,
        displayOrder: a.displayOrder,
        values: a.values.map((v) => ({ id: v.id, value: v.value, displayOrder: v.displayOrder })),
      })),
      skus: ig.warehouseVariants.map((wv) => ({
        warehouseVariantId: wv.id,
        warehouseSku: wv.warehouseSku,
        colourVariantName: wv.colourVariant.name,
        sizeOptionName: wv.sizeOption.name,
        squareVariationId: wv.squareVariationId,
        attributeValueIds: wv.attributes.map((a) => a.productAttributeValueId),
      })),
      squareItemCandidates: squareItems.map((si) => ({
        ...si,
        isBoundElsewhere: boundItemIds.has(si.squareItemId),
      })),
      squareVariationCandidates: squareVariations.map((sv) => ({
        ...sv,
        isBoundElsewhere: boundVariationIds.has(sv.squareVariationId),
      })),
    }
  }

  /// Create a new ProductAttribute (axis) on an ItemGroup. Empty-name is
  /// rejected upstream by the Zod schema; here we surface a P2002 unique
  /// collision as Conflict so the UI can render "this axis already exists".
  /// displayOrder defaults to the current max + 1 so new axes append.
  async createProductAttribute(itemGroupId: string, name: string, displayOrder?: number) {
    const ig = await this.prisma.itemGroup.findUnique({ where: { id: itemGroupId } })
    if (!ig) throw new NotFoundException(`item group ${itemGroupId} not found`)
    let order = displayOrder
    if (order === undefined) {
      const max = await this.prisma.productAttribute.aggregate({
        where: { itemGroupId },
        _max: { displayOrder: true },
      })
      order = (max._max.displayOrder ?? -1) + 1
    }
    try {
      return await this.prisma.productAttribute.create({
        data: { itemGroupId, name, displayOrder: order },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`attribute "${name}" already exists on this item group`)
      }
      throw err
    }
  }

  /// Add a new allowed value under an existing ProductAttribute.
  async createProductAttributeValue(productAttributeId: string, value: string, displayOrder?: number) {
    const attr = await this.prisma.productAttribute.findUnique({ where: { id: productAttributeId } })
    if (!attr) throw new NotFoundException(`attribute ${productAttributeId} not found`)
    let order = displayOrder
    if (order === undefined) {
      const max = await this.prisma.productAttributeValue.aggregate({
        where: { productAttributeId },
        _max: { displayOrder: true },
      })
      order = (max._max.displayOrder ?? -1) + 1
    }
    try {
      return await this.prisma.productAttributeValue.create({
        data: { productAttributeId, value, displayOrder: order },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`value "${value}" already exists on this axis`)
      }
      throw err
    }
  }

  /// Batch save for the mapping modal. Everything happens in one transaction
  /// so a partial UI submit doesn't leave the product half-mapped. Passing an
  /// undefined key means "don't touch"; passing null clears the link.
  async updateItemGroupMapping(
    itemGroupId: string,
    input: { squareItemId?: string | null; skus?: Array<{ warehouseVariantId: string; squareVariationId: string | null }> },
  ) {
    const ig = await this.prisma.itemGroup.findUnique({ where: { id: itemGroupId } })
    if (!ig) throw new NotFoundException(`item group ${itemGroupId} not found`)

    return this.prisma.$transaction(async (tx) => {
      if (input.squareItemId !== undefined) {
        try {
          await tx.itemGroup.update({
            where: { id: itemGroupId },
            data: { squareItemId: input.squareItemId === '' ? null : input.squareItemId },
          })
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw new ConflictException(`squareItemId "${input.squareItemId}" is already assigned to another item group`)
          }
          throw err
        }
      }
      if (input.skus) {
        for (const sku of input.skus) {
          try {
            await tx.warehouseVariant.update({
              where: { id: sku.warehouseVariantId },
              data: { squareVariationId: sku.squareVariationId === '' ? null : sku.squareVariationId },
            })
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              throw new ConflictException(
                `squareVariationId "${sku.squareVariationId}" is already assigned to another warehouse variant`,
              )
            }
            throw err
          }
        }
      }
      return { itemGroupId, ok: true }
    })
  }

  /// Both directions of orphan surfacing. `squareOnly` = items synced from
  /// Square but not linked to any Winterborn ItemGroup via squareItemId.
  /// `winterbornOnly` = ItemGroups that have never had a Square link set.
  /// Neither list is fatal — they're prompts for the operator to bind.
  async listMappingOrphans() {
    const [squareItems, itemGroups] = await Promise.all([
      this.prisma.squareCatalogItem.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.itemGroup.findMany({
        include: { category: true },
        orderBy: { name: 'asc' },
      }),
    ])
    const linkedItemIds = new Set(itemGroups.map((ig) => ig.squareItemId).filter((v): v is string => v !== null))
    const linkedGroupSquareIds = new Set(itemGroups.map((ig) => ig.squareItemId))
    const squareOnly = squareItems
      .filter((si) => !linkedItemIds.has(si.squareItemId))
      .map((si) => ({ squareItemId: si.squareItemId, name: si.name }))
    const winterbornOnly = itemGroups
      .filter((ig) => ig.squareItemId === null || !linkedGroupSquareIds.has(ig.squareItemId))
      .map((ig) => ({ itemGroupId: ig.id, name: ig.name, categoryName: ig.category.name }))
    return { squareOnly, winterbornOnly }
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
