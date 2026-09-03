import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type LocationKind } from '@prisma/client'
import { createHash } from 'node:crypto'
import type {
  CatalogBrowseResponse,
  CatalogFolderRow,
  CatalogItemDetail,
  CatalogItemGroupPage,
  CatalogItemRow,
  CatalogSearchHit,
  CatalogSearchResponse,
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
  WarehouseInventoryResponse,
  WarehouseInventoryRow,
  WarehouseVariantSummary,
} from '@winterborn/shared'
import { PrismaService } from '../prisma/prisma.service.js'
import type { CurrentUserPayload } from '../auth/current-user.js'
import { LedgerReadService } from '../ledger/ledger-read.service.js'
import { AuditService } from '../audit/audit.service.js'

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
    private readonly audit: AuditService,
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
    const [rows, allCategories] = await Promise.all([
      this.prisma.variation.findMany({
        include: { itemGroup: { include: { category: true } }, colourFamily: true, sizeOption: true },
        orderBy: [{ itemGroup: { name: 'asc' } }],
      }),
      this.prisma.category.findMany({ select: { id: true, name: true, parentId: true } }),
    ])
    const catById = new Map(allCategories.map((c) => [c.id, c]))
    /// Root-first ancestor chain including the leaf. Walked in-memory
    /// off `catById` so we make one Category fetch total, not one per
    /// variation.
    const pathFor = (leafCategoryId: string): string[] => {
      const chain: string[] = []
      let cursor: string | null = leafCategoryId
      while (cursor) {
        const cat = catById.get(cursor)
        if (!cat) break
        chain.unshift(cat.name)
        cursor = cat.parentId
      }
      return chain
    }
    return rows.map((r) => ({
      id: r.id,
      itemGroupName: r.itemGroup.name,
      categoryName: r.itemGroup.category.name,
      categoryPath: pathFor(r.itemGroup.categoryId),
      colourFamilyName: r.colourFamily.name,
      sizeOptionName: r.sizeOption.name,
    }))
  }

  async listCategories(): Promise<CategoryDto[]> {
    const rows = await this.prisma.category.findMany({ orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parentId }))
  }

  /// Create a Category anywhere in the tree — root when parentId is null,
  /// child of an existing folder otherwise. Idempotent by (parentId, name):
  /// second call with the same tuple returns the existing row instead of
  /// throwing a unique-constraint error. Uses the same helper the
  /// importers use so the shape stays consistent across all creation
  /// paths (Sortly import, xlsx import, web modal).
  async createCategory(input: { parentId: string | null; name: string }): Promise<{ id: string; parentId: string | null; name: string }> {
    if (input.parentId) {
      const parent = await this.prisma.category.findUnique({ where: { id: input.parentId } })
      if (!parent) throw new NotFoundException(`parent folder ${input.parentId} not found`)
    }
    // Root case (parentId=null) is manually resolved because Prisma's
    // compound-unique upsert can't express "null equals null". The
    // Postgres unique index tolerates null-equals-null (it's a real
    // unique index, not the compound key), so a plain findFirst then
    // create is race-safe as long as the caller retries on collision;
    // in practice a single operator can't race themselves.
    if (input.parentId === null) {
      const existing = await this.prisma.category.findFirst({ where: { parentId: null, name: input.name } })
      if (existing) return { id: existing.id, parentId: existing.parentId, name: existing.name }
      const created = await this.prisma.category.create({
        data: { parentId: null, name: input.name, sortlyFolder: input.name },
      })
      await this.audit.recordCreation(null, 'Category', created.id, `root folder "${created.name}"`, {
        source: 'UI',
      })
      return { id: created.id, parentId: created.parentId, name: created.name }
    }
    const preExisting = await this.prisma.category.findUnique({
      where: { parentId_name: { parentId: input.parentId, name: input.name } },
    })
    const row = await this.prisma.category.upsert({
      where: { parentId_name: { parentId: input.parentId, name: input.name } },
      create: { parentId: input.parentId, name: input.name, sortlyFolder: input.name },
      update: {},
    })
    if (!preExisting) {
      await this.audit.recordCreation(null, 'Category', row.id, `folder "${row.name}" under ${input.parentId}`, {
        source: 'UI',
      })
    }
    return { id: row.id, parentId: row.parentId, name: row.name }
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
        photoUrl: colourVariant.photoUrl ?? null,
        // Single-SKU create flow doesn't bind custom axes; existing axes
        // on the item group aren't retroactively attached here.
        axisValues: [],
      }
    })
  }

  async listWarehouseVariants(variationId?: string): Promise<WarehouseVariantSummary[]> {
    const rows = await this.prisma.warehouseVariant.findMany({
      where: variationId ? { variationId } : undefined,
      include: {
        itemGroup: true,
        colourVariant: true,
        sizeOption: true,
        /// Attribute values for the custom axes (Pattern / Style / Fit
        /// / …). Colour and Size have their own fields so the mapper
        /// below strips those to keep axisValues purely additive.
        attributes: {
          include: { productAttributeValue: { include: { productAttribute: true } } },
        },
      },
      orderBy: [{ colourVariant: { name: 'asc' } }],
    })
    return rows.map((r) => ({
      id: r.id,
      variationId: r.variationId,
      itemGroupName: r.itemGroup.name,
      colourVariantName: r.colourVariant.name,
      sizeOptionName: r.sizeOption.name,
      warehouseSku: r.warehouseSku,
      photoUrl: r.photoUrls[0] ?? r.colourVariant.photoUrl ?? null,
      axisValues: extractCustomAxisValues(r.attributes),
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

      const previousFamilyId = variant.colourFamilyId
      const updated = await tx.colourVariant.update({
        where: { id: colourVariantId },
        data: { colourFamilyId, familyAssignmentSource: 'MANUAL', familyConfidence: 1 },
      })

      if (previousFamilyId !== colourFamilyId) {
        await this.audit.record(tx, {
          entity: 'ColourVariant',
          entityId: colourVariantId,
          field: 'colourFamilyId',
          oldValue: previousFamilyId,
          newValue: colourFamilyId,
          source: 'UI',
        })
      }

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

  /// Per-WarehouseVariant on-hand at ONE specific location. The catalog
  /// browser now has a location dropdown (warehouses + markets), so
  /// aggregates are always scoped to whichever one the operator is
  /// viewing — Owner/WM switching a warehouse, MM anchored to their
  /// market. Falls back to an empty map for an unknown location so the
  /// UI still renders (all zeros) instead of throwing.
  private async onHandByVariantAtLocation(locationId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.ledgerEvent.groupBy({
      by: ['warehouseVariantId'],
      _sum: { quantity: true },
      where: {
        warehouseVariantId: { not: null },
        locationId,
      },
    })
    const out = new Map<string, number>()
    for (const r of rows) {
      if (r.warehouseVariantId) out.set(r.warehouseVariantId, r._sum.quantity ?? 0)
    }
    return out
  }

  /// Set of WarehouseVariant ids that "belong to" this market's catalog.
  /// A SKU counts as belonging if either:
  ///   (a) it has EVER had a ledger event at this location (received,
  ///       sold, corrected, etc.), OR
  ///   (b) it is currently in-transit to this market — i.e. it appears
  ///       on a BoxLine of a Box in state DISPATCHED whose destination
  ///       is this location.
  ///
  /// (b) is what makes brand-new SKUs show up in the market catalog as
  /// soon as the warehouse dispatches them, before the market has
  /// physically scanned/received the box. The market's on-hand still
  /// reads 0 until the INTAKE ledger event lands (that side lives in
  /// `onHandByVariantAtLocation`, deliberately untouched here).
  ///
  /// Warehouses skip this filter — they hold the master catalog — so
  /// this helper is only called when scoping to a MARKET location.
  private async variantsSeenAtLocation(locationId: string): Promise<Set<string>> {
    const [ledgerRows, inTransitRows] = await Promise.all([
      this.prisma.ledgerEvent.groupBy({
        by: ['warehouseVariantId'],
        where: {
          warehouseVariantId: { not: null },
          locationId,
        },
      }),
      this.prisma.boxLine.findMany({
        where: {
          box: { state: 'DISPATCHED', destinationLocationId: locationId },
        },
        select: { warehouseVariantId: true },
        distinct: ['warehouseVariantId'],
      }),
    ])
    const out = new Set<string>()
    for (const r of ledgerRows) {
      if (r.warehouseVariantId) out.add(r.warehouseVariantId)
    }
    for (const r of inTransitRows) out.add(r.warehouseVariantId)
    return out
  }

  /// Per-variant quantity currently in-transit to this market — units
  /// packed into boxes whose state is DISPATCHED and destined here.
  /// This is a display-only figure surfaced by browse endpoints so the
  /// market manager sees what's coming; it does NOT feed on-hand.
  private async inTransitByVariantAtLocation(locationId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.boxLine.groupBy({
      by: ['warehouseVariantId'],
      _sum: { quantity: true },
      where: {
        box: { state: 'DISPATCHED', destinationLocationId: locationId },
      },
    })
    const out = new Map<string, number>()
    for (const r of rows) {
      out.set(r.warehouseVariantId, r._sum.quantity ?? 0)
    }
    return out
  }

  /// Resolves the caller-supplied locationId into the location that
  /// should actually be used. Owner/WM: honours the value they picked,
  /// or falls back to the first WAREHOUSE-kind location alphabetically
  /// when they didn't pick anything (deterministic default that matches
  /// the pattern intake + product creation use). MM: forced to their
  /// own market — if they pass a different id, it's a 403 rather than a
  /// silent override so they see a clear boundary. Returns null when no
  /// warehouse exists at all so the caller can short-circuit gracefully.
  private async resolveBrowseLocation(
    actor: CurrentUserPayload,
    requestedLocationId: string | null,
  ): Promise<{ id: string; name: string; kind: LocationKind } | null> {
    if (actor.role === 'MARKET_MANAGER') {
      if (!actor.locationId) {
        throw new ForbiddenException('market manager has no assigned location')
      }
      if (requestedLocationId && requestedLocationId !== actor.locationId) {
        throw new ForbiddenException("cannot browse another location's catalog")
      }
      const loc = await this.prisma.location.findUnique({
        where: { id: actor.locationId },
        select: { id: true, name: true, kind: true },
      })
      if (!loc) throw new NotFoundException(`location ${actor.locationId} not found`)
      return loc
    }

    if (requestedLocationId) {
      const loc = await this.prisma.location.findUnique({
        where: { id: requestedLocationId },
        select: { id: true, name: true, kind: true },
      })
      if (!loc) throw new NotFoundException(`location ${requestedLocationId} not found`)
      return loc
    }

    const fallback = await this.prisma.location.findFirst({
      where: { kind: 'WAREHOUSE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, kind: true },
    })
    return fallback ?? null
  }

  /// First WAREHOUSE-kind location, ordered by name. Used as the default
  /// when a caller doesn't specify one.
  async firstWarehouseLocation(): Promise<{ id: string; name: string } | null> {
    const row = await this.prisma.location.findFirst({
      where: { kind: 'WAREHOUSE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    })
    return row ?? null
  }

  /// Paginated warehouse inventory for the /warehouse screen. Server-side
  /// search + slice so the frontend never has to pull the entire catalog
  /// just to render 50 rows.
  ///
  /// - `total` and `distinctItems` are grand totals across the whole
  ///   warehouse — deliberately unaffected by `q` so the header numbers
  ///   stay stable while the operator narrows the search.
  /// - `filteredCount` reflects how many rows match the current `q`.
  /// - `nextOffset` is null when there are no more pages.
  ///
  /// Sort order matches the previous client-side behaviour: on-hand DESC,
  /// then item-group name ASC for the long "0 stock" tail.
  async warehouseInventory(params: {
    locationId: string
    q?: string
    offset?: number
    limit?: number
  }): Promise<WarehouseInventoryResponse> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
    const offset = Math.max(params.offset ?? 0, 0)
    const query = (params.q ?? '').trim().toLowerCase()

    // The `.replace` guards against SQL LIKE wildcards in operator input
    // so a user typing `%` doesn't accidentally match everything.
    const needle = query.replace(/[\\%_]/g, '')

    // One aggregate for family-level on-hand and one for per-variant
    // on-hand at this warehouse — cheap groupBy queries. Plus the full
    // WarehouseVariant catalog joined to its item-group/colour-family/size
    // metadata so we can render the display row without a second call.
    // Categories load alongside so the search filter below can walk the
    // ancestor chain and match on folder names ("Scarves > Scarves
    // (Peru) > …") — same "deep search" the /catalog view offers.
    const [byFamily, byVariant, variants, allCategories] = await Promise.all([
      this.prisma.ledgerEvent.groupBy({
        by: ['variationId'],
        _sum: { quantity: true },
        where: { locationId: params.locationId },
      }),
      this.prisma.ledgerEvent.groupBy({
        by: ['warehouseVariantId', 'variationId'],
        _sum: { quantity: true },
        where: { locationId: params.locationId, warehouseVariantId: { not: null } },
      }),
      this.prisma.warehouseVariant.findMany({
        include: {
          itemGroup: { select: { name: true, categoryId: true } },
          colourVariant: { select: { name: true, photoUrl: true } },
          sizeOption: { select: { name: true } },
          variation: {
            select: {
              id: true,
              colourFamily: { select: { name: true } },
              sizeOption: { select: { name: true } },
              itemGroup: { select: { name: true, categoryId: true } },
            },
          },
          /// Custom-axis values (Pattern / Style / Fit / …). Included so
          /// the search matches e.g. "Cross" or "Straight" for a product
          /// with a Pattern axis, not just colour + SKU.
          attributes: {
            include: { productAttributeValue: true },
          },
        },
      }),
      this.prisma.category.findMany({ select: { id: true, name: true, parentId: true } }),
    ])
    const catById = new Map(allCategories.map((c) => [c.id, c]))
    /// Build the flattened ancestor-name string for each leaf category
    /// once — small (~20 rows) so an in-memory cache is fine.
    const ancestorNamesForCat = new Map<string, string>()
    for (const c of allCategories) {
      const parts: string[] = []
      let cursor: string | null = c.id
      while (cursor) {
        const node = catById.get(cursor)
        if (!node) break
        parts.unshift(node.name.toLowerCase())
        cursor = node.parentId
      }
      ancestorNamesForCat.set(c.id, parts.join(' > '))
    }

    const onHandByVariation = new Map(byFamily.map((r) => [r.variationId, r._sum.quantity ?? 0]))
    const onHandByVariant = new Map<string, number>()
    for (const r of byVariant) {
      if (r.warehouseVariantId) onHandByVariant.set(r.warehouseVariantId, r._sum.quantity ?? 0)
    }

    // Group WarehouseVariants by variation so each row can carry its
    // per-variant split. Sort variants alphabetically inside each group
    // for a stable display order.
    const variantsByVariation = new Map<string, typeof variants>()
    for (const wv of variants) {
      const bucket = variantsByVariation.get(wv.variationId) ?? []
      bucket.push(wv)
      variantsByVariation.set(wv.variationId, bucket)
    }
    for (const [, list] of variantsByVariation) {
      list.sort((a, b) => a.colourVariant.name.localeCompare(b.colourVariant.name))
    }

    // Placeholder-only rows (single "—" variant used for axis-less
    // products like Bags) don't need the expander in the UI.
    const hasMeaningfulSubVariants = (list: typeof variants) =>
      list.length > 1 || (list.length === 1 && list[0]!.colourVariant.name !== '—')

    // Materialise one row per variation. Rows that never had a variant
    // recorded (fresh product with only family-level history) still show
    // up because we key off variantsByVariation, not the ledger.
    //
    // Per row, we ALSO build a `searchHaystack` string: everything the
    // filter can match on — display metadata (item group, colour family,
    // size), the leaf → root category chain ("scarves > scarves (peru) >
    // …"), every axis value across every variant (Pattern: Cross,
    // Style: Fringed, …), every SKU, and every colour variant name. The
    // filter below then does one lowercase `.includes(needle)` per row
    // instead of many field-by-field checks.
    const allRows: WarehouseInventoryRow[] = []
    const haystackByVariation = new Map<string, string>()
    for (const [variationId, list] of variantsByVariation) {
      const first = list[0]!
      const rowVariants = hasMeaningfulSubVariants(list)
        ? list.map((wv) => ({
            warehouseVariantId: wv.id,
            colourVariantName: wv.colourVariant.name,
            warehouseSku: wv.warehouseSku,
            onHand: onHandByVariant.get(wv.id) ?? 0,
            // Per-variant photo: prefer the SKU's own uploads, fall back
            // to the shared ColourVariant photo (usually a Sortly archive)
            // so a fresh variant with no explicit photo still shows a
            // recognisable colour swatch.
            photoUrl: wv.photoUrls[0] ?? wv.colourVariant.photoUrl ?? null,
          }))
        : []
      const previewPhotoUrl =
        list.find((wv) => wv.photoUrls[0])?.photoUrls[0] ??
        list.find((wv) => wv.colourVariant.photoUrl)?.colourVariant.photoUrl ??
        null
      // Build the searchable haystack for this row. Category chain comes
      // from the item group's leaf category; axis values union across
      // every variant so a match on Cross surfaces the whole row.
      const categoryChain = ancestorNamesForCat.get(first.itemGroup.categoryId) ?? ''
      const axisValues = new Set<string>()
      for (const wv of list) {
        for (const link of wv.attributes) axisValues.add(link.productAttributeValue.value.toLowerCase())
      }
      const skuBag = list.map((wv) => wv.warehouseSku.toLowerCase()).join(' ')
      const colourBag = list.map((wv) => wv.colourVariant.name.toLowerCase()).join(' ')
      const haystack = [
        first.variation.itemGroup.name.toLowerCase(),
        first.variation.colourFamily.name.toLowerCase(),
        first.variation.sizeOption.name.toLowerCase(),
        categoryChain,
        colourBag,
        skuBag,
        [...axisValues].join(' '),
      ].join(' ')
      haystackByVariation.set(variationId, haystack)

      allRows.push({
        variationId,
        itemGroupName: first.variation.itemGroup.name,
        colourFamilyName: first.variation.colourFamily.name,
        sizeOptionName: first.variation.sizeOption.name,
        previewPhotoUrl,
        onHand: onHandByVariation.get(variationId) ?? 0,
        variants: rowVariants,
      })
    }

    // Grand totals — computed BEFORE search, so the header stays stable
    // while the operator narrows the list.
    const total = allRows.reduce((s, r) => s + r.onHand, 0)
    const distinctItems = allRows.length

    // Search filter — server-side ILIKE-esque contains match against
    // the per-row haystack built above (display metadata + category
    // chain + axis values + SKUs + colour names). Same behaviour as the
    // /catalog "deep search" so operators moving between the two views
    // don't have to reset their mental model. Kept case-insensitive;
    // punctuation-sensitive so "S" doesn't match every "Small" plus
    // every "SKU-…".
    const filtered = needle
      ? allRows.filter((r) => (haystackByVariation.get(r.variationId) ?? '').includes(needle))
      : allRows

    // Sort by on-hand DESC then name ASC — matches the pre-server-side
    // client behaviour so the operator sees the same order as before.
    filtered.sort((a, b) => {
      if (b.onHand !== a.onHand) return b.onHand - a.onHand
      return a.itemGroupName.localeCompare(b.itemGroupName)
    })

    const page = filtered.slice(offset, offset + limit)
    const nextOffset = offset + limit < filtered.length ? offset + limit : null

    return {
      rows: page,
      total,
      distinctItems,
      filteredCount: filtered.length,
      nextOffset,
    }
  }

  /// Leaf rows: one WarehouseVariant per card, with warehouse-wide on-hand.
  /// Response also carries the item group's parent Category chain so the
  /// UI renders its breadcrumb from a single call.
  async listItemGroupItems(
    itemGroupId: string,
    actor: CurrentUserPayload,
    requestedLocationId: string | null = null,
  ): Promise<CatalogItemGroupPage> {
    const itemGroup = await this.prisma.itemGroup.findUnique({ where: { id: itemGroupId } })
    if (!itemGroup) throw new NotFoundException(`item group ${itemGroupId} not found`)
    const scopedLocation = await this.resolveBrowseLocation(actor, requestedLocationId)
    const isMarketScope = scopedLocation?.kind === 'MARKET'
    const [variants, onHandMap, categories, inTransitMap] = await Promise.all([
      this.prisma.warehouseVariant.findMany({
        where: { itemGroupId },
        include: {
          itemGroup: { select: { name: true } },
          colourVariant: { select: { name: true, photoUrl: true, colourFamily: { select: { name: true } } } },
          sizeOption: { select: { name: true } },
          variation: { select: { colourFamily: { select: { name: true } } } },
        },
        orderBy: { warehouseSku: 'asc' },
      }),
      scopedLocation ? this.onHandByVariantAtLocation(scopedLocation.id) : Promise.resolve(new Map<string, number>()),
      this.prisma.category.findMany({ select: { id: true, name: true, parentId: true } }),
      isMarketScope
        ? this.inTransitByVariantAtLocation(scopedLocation!.id)
        : Promise.resolve(new Map<string, number>()),
    ])
    const catById = new Map(categories.map((c) => [c.id, c]))
    const breadcrumb: Array<{ id: string; name: string }> = []
    let cursor: string | null = itemGroup.categoryId
    while (cursor) {
      const c = catById.get(cursor)
      if (!c) break
      breadcrumb.unshift({ id: c.id, name: c.name })
      cursor = c.parentId
    }
    // At a market, drop SKUs that this location has never seen AND has
    // nothing incoming for. Same rule as the folder-level filter — the
    // in-transit set folds into `variantsSeenAtLocation` so an inbound
    // brand-new SKU still lands in the market view.
    const seenAtMarket = isMarketScope ? await this.variantsSeenAtLocation(scopedLocation!.id) : null
    const items: CatalogItemRow[] = variants
      .filter((wv) => !seenAtMarket || seenAtMarket.has(wv.id))
      .map((wv) => ({
        warehouseVariantId: wv.id,
        itemGroupId: wv.itemGroupId,
        itemGroupName: wv.itemGroup.name,
        colourVariantName: wv.colourVariant.name,
        colourFamilyName: wv.variation.colourFamily.name,
        sizeOptionName: wv.sizeOption.name,
        warehouseSku: wv.warehouseSku,
        photoUrl: wv.photoUrls[0] ?? wv.colourVariant.photoUrl ?? null,
        onHand: onHandMap.get(wv.id) ?? 0,
        inTransitQty: inTransitMap.get(wv.id) ?? 0,
        unitCostCents: wv.unitCostCents,
      }))
    return {
      itemGroup: { id: itemGroup.id, name: itemGroup.name, categoryId: itemGroup.categoryId },
      breadcrumb,
      items,
      location: scopedLocation
        ? { id: scopedLocation.id, name: scopedLocation.name, kind: scopedLocation.kind }
        : null,
    }
  }

  /// Full detail for one SKU: photos, breadcrumb parts, and a per-warehouse
  /// on-hand breakdown so the "edit count" form knows which location it's
  /// correcting. Only warehouse-kind locations are surfaced — market copies
  /// aren't editable from this screen.
  async getCatalogItemDetail(warehouseVariantId: string): Promise<CatalogItemDetail> {
    const wv = await this.prisma.warehouseVariant.findUnique({
      where: { id: warehouseVariantId },
      include: {
        itemGroup: { include: { category: true } },
        colourVariant: { include: { colourFamily: true } },
        sizeOption: true,
        variation: { include: { colourFamily: true } },
        /// Bring back every axis value bound to this SKU (Style, Pattern,
        /// Fit, custom …). Colour and Size have their own detail rows
        /// so the render layer filters those out of this list.
        attributes: {
          include: { productAttributeValue: { include: { productAttribute: true } } },
        },
      },
    })
    if (!wv) throw new NotFoundException(`warehouse variant ${warehouseVariantId} not found`)
    const [warehouses, allCategories] = await Promise.all([
      this.prisma.location.findMany({ where: { kind: 'WAREHOUSE', isActive: true }, orderBy: { name: 'asc' } }),
      this.prisma.category.findMany({ select: { id: true, name: true, parentId: true } }),
    ])
    const catById = new Map(allCategories.map((c) => [c.id, c]))
    const breadcrumb: Array<{ id: string; name: string }> = []
    let cursor: string | null = wv.itemGroup.category.id
    while (cursor) {
      const c = catById.get(cursor)
      if (!c) break
      breadcrumb.unshift({ id: c.id, name: c.name })
      cursor = c.parentId
    }
    const rows = warehouses.length > 0
      ? await this.prisma.ledgerEvent.groupBy({
          by: ['locationId'],
          _sum: { quantity: true },
          where: {
            warehouseVariantId,
            locationId: { in: warehouses.map((w) => w.id) },
          },
        })
      : []
    const onHandByLoc = new Map(rows.map((r) => [r.locationId, r._sum.quantity ?? 0]))
    const stockByLocation = warehouses.map((w) => ({
      locationId: w.id,
      locationName: w.name,
      onHand: onHandByLoc.get(w.id) ?? 0,
    }))
    const totalOnHand = stockByLocation.reduce((s, r) => s + r.onHand, 0)
    const backfillPhoto = wv.colourVariant.photoUrl
    const photoUrls = wv.photoUrls.length > 0 ? wv.photoUrls : backfillPhoto ? [backfillPhoto] : []
    // Filter out Color/Size — those have dedicated detail rows already
    // — and dedupe by axis name so the render layer just maps 1:1.
    const attributes: Array<{ name: string; value: string }> = []
    const seenAxisNames = new Set<string>()
    for (const link of wv.attributes) {
      const name = link.productAttributeValue.productAttribute.name
      if (name === 'Color' || name === 'Size') continue
      if (seenAxisNames.has(name)) continue
      seenAxisNames.add(name)
      attributes.push({ name, value: link.productAttributeValue.value })
    }
    return {
      warehouseVariantId: wv.id,
      warehouseSku: wv.warehouseSku,
      categoryId: wv.itemGroup.category.id,
      categoryName: wv.itemGroup.category.name,
      itemGroupId: wv.itemGroup.id,
      itemGroupName: wv.itemGroup.name,
      variationId: wv.variationId,
      colourVariantName: wv.colourVariant.name,
      colourFamilyName: wv.variation.colourFamily.name,
      sizeOptionName: wv.sizeOption.name,
      photoUrls,
      unitCostCents: wv.unitCostCents,
      totalOnHand,
      stockByLocation,
      breadcrumb,
      attributes,
    }
  }

  /// Tree-aware browse. Returns the direct children (subfolders and
  /// item-groups) of the folder identified by `folderId`, or of the top
  /// level if no id is given (in which case any root-parent Categories
  /// surface — for Sortly-imported data that's just "BärHaus (IN STOCK)").
  ///
  /// Every subfolder tile carries totals aggregated over its ENTIRE
  /// subtree (item count + warehouse on-hand + value), so the operator
  /// can see "Footwear = 129 items, 12,670 units" without drilling in.
  /// Item-group tiles carry only their own direct SKU totals — they're
  /// leaves.
  async browseFolder(
    folderId: string | null,
    actor: CurrentUserPayload,
    requestedLocationId: string | null = null,
  ): Promise<CatalogBrowseResponse> {
    const scopedLocation = await this.resolveBrowseLocation(actor, requestedLocationId)
    // 1. Fetch every Category once (small, ~20 rows) and build parent/child
    //    lookups. Everything below runs off these in-memory structures so
    //    the response is one Category-level SELECT no matter how deep the
    //    tree is.
    const allCategories = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
    })
    const catById = new Map(allCategories.map((c) => [c.id, c]))
    const childrenOf = new Map<string | null, typeof allCategories>()
    for (const c of allCategories) {
      const bucket = childrenOf.get(c.parentId) ?? []
      bucket.push(c)
      childrenOf.set(c.parentId, bucket)
    }

    // 2. Resolve current folder + breadcrumb (root-first, excluding self).
    const folder = folderId ? catById.get(folderId) ?? null : null
    if (folderId && !folder) throw new NotFoundException(`folder ${folderId} not found`)
    const breadcrumb: Array<{ id: string; name: string }> = []
    if (folder) {
      let cursor = folder.parentId ? catById.get(folder.parentId) : null
      while (cursor) {
        breadcrumb.unshift({ id: cursor.id, name: cursor.name })
        cursor = cursor.parentId ? catById.get(cursor.parentId) : null
      }
    }

    // 3. Aggregate SKU-level metrics (photo, count, on-hand, value) up
    //    the ancestry so every folder in the tree knows its subtree
    //    totals in one pass.
    //
    //    For MARKET locations we also fetch the "seen-here" SKU set so
    //    we can filter the catalog to only what actually flowed through
    //    this market. Warehouses hold the master catalog, so they skip
    //    the filter and show every folder as before.
    const isMarketScope = scopedLocation?.kind === 'MARKET'
    const [allVariants, onHandMap, allItemGroups, seenVariantIds, inTransitMap] = await Promise.all([
      this.prisma.warehouseVariant.findMany({
        include: {
          itemGroup: { select: { id: true, categoryId: true, name: true } },
          colourVariant: { select: { photoUrl: true } },
        },
        orderBy: { warehouseSku: 'asc' },
      }),
      scopedLocation ? this.onHandByVariantAtLocation(scopedLocation.id) : Promise.resolve(new Map<string, number>()),
      this.prisma.itemGroup.findMany({ orderBy: { name: 'asc' } }),
      isMarketScope ? this.variantsSeenAtLocation(scopedLocation!.id) : Promise.resolve(null as Set<string> | null),
      // In-transit counts are only meaningful for a MARKET scope: they
      // reflect DISPATCHED boxes headed there but not yet received. At a
      // warehouse everything either has ledger on-hand or hasn't happened
      // yet, so we skip the query entirely.
      isMarketScope
        ? this.inTransitByVariantAtLocation(scopedLocation!.id)
        : Promise.resolve(new Map<string, number>()),
    ])

    interface Bucket {
      itemCount: number
      totalQty: number
      totalValueCents: number
      inTransitQty: number
      previewPhotoUrl: string | null
    }
    const emptyBucket = (): Bucket => ({
      itemCount: 0,
      totalQty: 0,
      totalValueCents: 0,
      inTransitQty: 0,
      previewPhotoUrl: null,
    })

    /// Per-Category subtree totals (walks descendants), and per-ItemGroup
    /// direct totals. Photo is the deterministic first non-null preview
    /// in warehouseSku order (already ordered by the query above).
    const categoryTotals = new Map<string, Bucket>()
    const itemGroupTotals = new Map<string, Bucket>()
    for (const c of allCategories) categoryTotals.set(c.id, emptyBucket())
    for (const ig of allItemGroups) itemGroupTotals.set(ig.id, emptyBucket())

    /// Walk this WV up the category chain and credit every ancestor.
    const creditAncestors = (
      leafCatId: string,
      itemCount: number,
      qty: number,
      valueCents: number,
      inTransit: number,
      photo: string | null,
    ) => {
      let cursor: string | null = leafCatId
      while (cursor) {
        const bucket = categoryTotals.get(cursor)
        if (!bucket) break
        bucket.itemCount += itemCount
        bucket.totalQty += qty
        bucket.totalValueCents += valueCents
        bucket.inTransitQty += inTransit
        if (bucket.previewPhotoUrl === null && photo) bucket.previewPhotoUrl = photo
        const parent: string | null = catById.get(cursor)?.parentId ?? null
        cursor = parent
      }
    }

    for (const wv of allVariants) {
      // Market scope: skip any SKU this location has never seen AND has
      // no in-transit units for. `variantsSeenAtLocation` already
      // includes the in-transit set so a brand-new SKU on a DISPATCHED
      // box passes the filter and lands in the market catalog.
      if (seenVariantIds && !seenVariantIds.has(wv.id)) continue

      const onHand = onHandMap.get(wv.id) ?? 0
      const inTransit = inTransitMap.get(wv.id) ?? 0
      const valueCents = onHand * (wv.unitCostCents ?? 0)
      const photo = wv.photoUrls[0] ?? wv.colourVariant.photoUrl ?? null

      // Item group leaf totals (direct SKUs only)
      const igBucket = itemGroupTotals.get(wv.itemGroup.id)
      if (igBucket) {
        igBucket.itemCount += 1
        igBucket.totalQty += onHand
        igBucket.totalValueCents += valueCents
        igBucket.inTransitQty += inTransit
        if (igBucket.previewPhotoUrl === null && photo) igBucket.previewPhotoUrl = photo
      }

      // Subtree category totals: every ancestor Category up to root
      creditAncestors(wv.itemGroup.categoryId, 1, onHand, valueCents, inTransit, photo)
    }

    /// Materialise a Category as a folder tile. `subfolderCount` counts
    /// only *visible* direct children — at a market this drops the
    /// sub-folders and item-groups that filtered out to zero seen SKUs
    /// so the badge doesn't advertise phantom folders the user can't
    /// drill into.
    const toFolderRow = (cat: typeof allCategories[number]): CatalogFolderRow => {
      const b = categoryTotals.get(cat.id) ?? emptyBucket()
      const subCategoryChildren = childrenOf.get(cat.id) ?? []
      const itemGroupChildren = allItemGroups.filter((ig) => ig.categoryId === cat.id)
      const visibleSubCategories = isMarketScope
        ? subCategoryChildren.filter((c) => (categoryTotals.get(c.id)?.itemCount ?? 0) > 0)
        : subCategoryChildren
      const visibleItemGroups = isMarketScope
        ? itemGroupChildren.filter((ig) => (itemGroupTotals.get(ig.id)?.itemCount ?? 0) > 0)
        : itemGroupChildren
      return {
        id: cat.id,
        name: cat.name,
        subfolderCount: visibleSubCategories.length + visibleItemGroups.length,
        itemCount: b.itemCount,
        totalQty: b.totalQty,
        totalValueCents: b.totalValueCents,
        inTransitQty: b.inTransitQty,
        previewPhotoUrl: b.previewPhotoUrl,
      }
    }

    /// Materialise an ItemGroup as a "folder" tile — the UI treats it the
    /// same as a subfolder but the client links to /catalog/g/:id when
    /// clicked. subfolderCount is 0 because SKUs aren't folders.
    const toItemGroupRow = (ig: typeof allItemGroups[number]): CatalogFolderRow => {
      const b = itemGroupTotals.get(ig.id) ?? emptyBucket()
      return {
        id: ig.id,
        name: ig.name,
        subfolderCount: 0,
        itemCount: b.itemCount,
        totalQty: b.totalQty,
        totalValueCents: b.totalValueCents,
        inTransitQty: b.inTransitQty,
        previewPhotoUrl: b.previewPhotoUrl,
      }
    }

    /// At a market, hide folders/item-groups that this location has
    /// never received AND has nothing incoming for. In-transit items
    /// count toward visibility so a brand-new SKU on a DISPATCHED box
    /// shows up in the market catalog before it's physically received.
    const keepAtScope = <T extends { itemCount: number }>(rows: T[]): T[] =>
      isMarketScope ? rows.filter((r) => r.itemCount > 0) : rows

    // 4. Pick the level to render.
    //
    // At the root (no folderId), auto-unwrap: if there's exactly one
    // top-level folder (Sortly's "BärHaus (IN STOCK)"), show ITS children
    // rather than a single-tile page containing only itself. The wrapper
    // still exists as a real row (so future roots can co-exist and mapping
    // metadata has somewhere to hang), it's just skipped visually.
    let effectiveFolderId: string | null = folderId
    let effectiveFolder = folder
    if (!folderId) {
      const roots = childrenOf.get(null) ?? []
      if (roots.length === 1 && roots[0]) {
        effectiveFolderId = roots[0].id
        effectiveFolder = roots[0]
      }
    }

    const subCategoryChildren = effectiveFolderId
      ? childrenOf.get(effectiveFolderId) ?? []
      : childrenOf.get(null) ?? []
    const itemGroupChildren = effectiveFolderId
      ? allItemGroups.filter((ig) => ig.categoryId === effectiveFolderId)
      : []

    return {
      folder: effectiveFolder
        ? { id: effectiveFolder.id, name: effectiveFolder.name, parentId: effectiveFolder.parentId }
        : null,
      breadcrumb,
      subfolders: keepAtScope(subCategoryChildren.map(toFolderRow)),
      itemGroups: keepAtScope(itemGroupChildren.map(toItemGroupRow)),
      location: scopedLocation
        ? { id: scopedLocation.id, name: scopedLocation.name, kind: scopedLocation.kind }
        : null,
    }
  }

  /// Deep, tree-wide search. Case-insensitive `includes` match against:
  ///   - Category.name → surfaces as a folder hit
  ///   - ItemGroup.name → surfaces as a product hit
  ///   - WarehouseVariant.warehouseSku → surfaces the parent product
  ///   - ColourVariant.name (e.g. "Dark Gray") → surfaces the parent product
  ///   - SizeOption.name (e.g. "XL") → surfaces the parent product
  /// Each hit carries its ancestor chain (root-first) so the client can
  /// render "in BärHaus › Apparel › Headwear" next to the tile. Empty
  /// query returns zero hits — the client falls back to the browse view.
  ///
  /// Location scoping mirrors browseFolder: MARKET locations only see
  /// folders and item-groups that have actually received SKUs there, so
  /// searching from an Atlanta market page never surfaces phantom
  /// warehouse-only folders.
  async searchCatalog(
    rawQuery: string,
    actor: CurrentUserPayload,
    requestedLocationId: string | null = null,
  ): Promise<CatalogSearchResponse> {
    const scopedLocation = await this.resolveBrowseLocation(actor, requestedLocationId)
    const query = rawQuery.trim()
    if (query.length === 0) {
      return {
        query,
        hits: [],
        location: scopedLocation
          ? { id: scopedLocation.id, name: scopedLocation.name, kind: scopedLocation.kind }
          : null,
      }
    }
    const needle = query.toLowerCase()

    const allCategories = await this.prisma.category.findMany({ orderBy: { name: 'asc' } })
    const catById = new Map(allCategories.map((c) => [c.id, c]))

    const isMarketScope = scopedLocation?.kind === 'MARKET'
    const [allVariants, onHandMap, allItemGroups, seenVariantIds, inTransitMap] = await Promise.all([
      this.prisma.warehouseVariant.findMany({
        include: {
          itemGroup: { select: { id: true, categoryId: true, name: true } },
          /// `colourVariant.name` and `variation.sizeOption.name` are
          /// pulled here (in addition to the aggregation-photo select)
          /// so the search filter can match on the operator-visible
          /// colour ("Dark Gray") and size ("XL") without a second query.
          colourVariant: { select: { photoUrl: true, name: true } },
          variation: { select: { sizeOption: { select: { name: true } } } },
        },
        orderBy: { warehouseSku: 'asc' },
      }),
      scopedLocation ? this.onHandByVariantAtLocation(scopedLocation.id) : Promise.resolve(new Map<string, number>()),
      this.prisma.itemGroup.findMany({ orderBy: { name: 'asc' } }),
      isMarketScope ? this.variantsSeenAtLocation(scopedLocation!.id) : Promise.resolve(null as Set<string> | null),
      isMarketScope
        ? this.inTransitByVariantAtLocation(scopedLocation!.id)
        : Promise.resolve(new Map<string, number>()),
    ])

    interface Bucket {
      itemCount: number
      totalQty: number
      totalValueCents: number
      inTransitQty: number
      previewPhotoUrl: string | null
    }
    const emptyBucket = (): Bucket => ({
      itemCount: 0,
      totalQty: 0,
      totalValueCents: 0,
      inTransitQty: 0,
      previewPhotoUrl: null,
    })
    const categoryTotals = new Map<string, Bucket>()
    const itemGroupTotals = new Map<string, Bucket>()
    for (const c of allCategories) categoryTotals.set(c.id, emptyBucket())
    for (const ig of allItemGroups) itemGroupTotals.set(ig.id, emptyBucket())

    const creditAncestors = (
      leafCatId: string,
      qty: number,
      valueCents: number,
      inTransit: number,
      photo: string | null,
    ) => {
      let cursor: string | null = leafCatId
      while (cursor) {
        const bucket = categoryTotals.get(cursor)
        if (!bucket) break
        bucket.itemCount += 1
        bucket.totalQty += qty
        bucket.totalValueCents += valueCents
        bucket.inTransitQty += inTransit
        if (bucket.previewPhotoUrl === null && photo) bucket.previewPhotoUrl = photo
        cursor = catById.get(cursor)?.parentId ?? null
      }
    }

    /// Item-groups whose leaves match the query on SKU, colour-variant
    /// name, or size name. Built in the same pass that aggregates totals
    /// so we don't iterate variants twice.
    const variantMatchedItemGroupIds = new Set<string>()

    for (const wv of allVariants) {
      if (seenVariantIds && !seenVariantIds.has(wv.id)) continue
      const onHand = onHandMap.get(wv.id) ?? 0
      const inTransit = inTransitMap.get(wv.id) ?? 0
      const valueCents = onHand * (wv.unitCostCents ?? 0)
      const photo = wv.photoUrls[0] ?? wv.colourVariant.photoUrl ?? null
      const igBucket = itemGroupTotals.get(wv.itemGroup.id)
      if (igBucket) {
        igBucket.itemCount += 1
        igBucket.totalQty += onHand
        igBucket.totalValueCents += valueCents
        igBucket.inTransitQty += inTransit
        if (igBucket.previewPhotoUrl === null && photo) igBucket.previewPhotoUrl = photo
      }
      creditAncestors(wv.itemGroup.categoryId, onHand, valueCents, inTransit, photo)

      if (
        wv.warehouseSku.toLowerCase().includes(needle) ||
        wv.colourVariant.name.toLowerCase().includes(needle) ||
        wv.variation.sizeOption.name.toLowerCase().includes(needle)
      ) {
        variantMatchedItemGroupIds.add(wv.itemGroup.id)
      }
    }

    /// Walk ancestors of `categoryId` (root-first, EXCLUDING the category
    /// itself). If `includeSelf` is set, appends the category at the end
    /// — used for item-group hits so the path shows the container folder.
    const buildPath = (categoryId: string | null | undefined, includeSelf: boolean): Array<{ id: string; name: string }> => {
      const chain: Array<{ id: string; name: string }> = []
      let cursor = categoryId ? catById.get(categoryId) ?? null : null
      const seed = cursor
      cursor = cursor?.parentId ? catById.get(cursor.parentId) ?? null : null
      while (cursor) {
        chain.unshift({ id: cursor.id, name: cursor.name })
        cursor = cursor.parentId ? catById.get(cursor.parentId) ?? null : null
      }
      if (includeSelf && seed) chain.push({ id: seed.id, name: seed.name })
      return chain
    }

    const folderHits: CatalogSearchHit[] = []
    for (const cat of allCategories) {
      if (!cat.name.toLowerCase().includes(needle)) continue
      const b = categoryTotals.get(cat.id) ?? emptyBucket()
      if (isMarketScope && b.itemCount === 0) continue
      const row: CatalogFolderRow = {
        id: cat.id,
        name: cat.name,
        subfolderCount:
          (allCategories.filter((c) => c.parentId === cat.id).length +
            allItemGroups.filter((ig) => ig.categoryId === cat.id).length),
        itemCount: b.itemCount,
        totalQty: b.totalQty,
        totalValueCents: b.totalValueCents,
        inTransitQty: b.inTransitQty,
        previewPhotoUrl: b.previewPhotoUrl,
      }
      folderHits.push({ kind: 'folder', row, path: buildPath(cat.id, false) })
    }

    const itemGroupHits: CatalogSearchHit[] = []
    for (const ig of allItemGroups) {
      const nameMatches = ig.name.toLowerCase().includes(needle)
      const variantMatches = variantMatchedItemGroupIds.has(ig.id)
      if (!nameMatches && !variantMatches) continue
      const b = itemGroupTotals.get(ig.id) ?? emptyBucket()
      if (isMarketScope && b.itemCount === 0) continue
      const row: CatalogFolderRow = {
        id: ig.id,
        name: ig.name,
        subfolderCount: 0,
        itemCount: b.itemCount,
        totalQty: b.totalQty,
        totalValueCents: b.totalValueCents,
        inTransitQty: b.inTransitQty,
        previewPhotoUrl: b.previewPhotoUrl,
      }
      itemGroupHits.push({ kind: 'item-group', row, path: buildPath(ig.categoryId, true) })
    }

    /// Leaf-level (SKU) hits: each matching WarehouseVariant emitted as
    /// its own row so operators searching a specific colour ("Melon &
    /// Plum") jump straight to that SKU's detail page instead of drilling
    /// through the parent product. Row shape collapses to a single item:
    /// itemCount=1, totalQty=onHand, totalValueCents=onHand×unitCost.
    const itemHits: CatalogSearchHit[] = []
    for (const wv of allVariants) {
      if (seenVariantIds && !seenVariantIds.has(wv.id)) continue
      const skuMatches = wv.warehouseSku.toLowerCase().includes(needle)
      const colourMatches = wv.colourVariant.name.toLowerCase().includes(needle)
      const sizeMatches = wv.variation.sizeOption.name.toLowerCase().includes(needle)
      if (!skuMatches && !colourMatches && !sizeMatches) continue

      const onHand = onHandMap.get(wv.id) ?? 0
      const valueCents = onHand * (wv.unitCostCents ?? 0)
      const photo = wv.photoUrls[0] ?? wv.colourVariant.photoUrl ?? null
      /// Item hit label: "Colour · Size" so two SKUs from the same
      /// product are distinguishable in the list. The parent product
      /// name goes into the breadcrumb path (buildPath + push item-group)
      /// so the operator sees "in BärHaus › ... › Standard Scarves …".
      const label = `${wv.colourVariant.name} · ${wv.variation.sizeOption.name}`
      const parentIg = allItemGroups.find((ig) => ig.id === wv.itemGroup.id)
      const path = buildPath(wv.itemGroup.categoryId, true)
      if (parentIg) path.push({ id: parentIg.id, name: parentIg.name })
      itemHits.push({
        kind: 'item',
        row: {
          id: wv.id,
          name: label,
          subfolderCount: 0,
          itemCount: 1,
          totalQty: onHand,
          totalValueCents: valueCents,
          inTransitQty: inTransitMap.get(wv.id) ?? 0,
          previewPhotoUrl: photo,
        },
        path,
      })
    }

    return {
      query,
      hits: [...folderHits, ...itemGroupHits, ...itemHits],
      location: scopedLocation
        ? { id: scopedLocation.id, name: scopedLocation.name, kind: scopedLocation.kind }
        : null,
    }
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

/// Flatten `WarehouseVariantAttribute[]` (Prisma-shape after
/// `include: { productAttributeValue: { include: { productAttribute: true } } }`)
/// into just the axis values for custom axes. Colour and Size are
/// already carried by `colourVariantName` / `sizeOptionName`, so we drop
/// those to keep the return array purely additive.
function extractCustomAxisValues(
  links: Array<{
    productAttributeValue: {
      value: string
      productAttribute: { name: string }
    }
  }>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const link of links) {
    const name = link.productAttributeValue.productAttribute.name
    if (name === 'Color' || name === 'Size') continue
    const value = link.productAttributeValue.value
    const key = `${name}::${value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}
