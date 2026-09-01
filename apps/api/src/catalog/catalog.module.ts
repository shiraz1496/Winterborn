import { Injectable, Module } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaModule } from '../prisma/prisma.module.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { parseSortlyCsv, type ParsedSortlyItem, type SkippedRow } from './sortly-parser.js'
import { AuthModule } from '../auth/auth.module.js'
import { LedgerModule } from '../ledger/ledger.module.js'
import { CatalogReadService } from './catalog-read.service.js'
import { CatalogController } from './catalog.controller.js'
import { SquareCatalogSyncService } from './square-catalog-sync.service.js'
import { StockCorrectionService } from './stock-correction.service.js'
import { ProductCreationService } from './product-creation.service.js'
import { ProductUpdateService } from './product-update.service.js'
import { CloudinarySignatureService } from './cloudinary-signature.service.js'
import { upsertSortlyFolderChain, type FolderCache } from './folder-tree.js'

const UNIQUE_VIOLATION = 'P2002'

/// Family assignment is Task 3's job. Every colour variant lands here on
/// import so the catalog is queryable immediately; Task 3 reassigns each
/// ColourVariant to a real ColourFamily and this bucket empties out.
const UNASSIGNED_FAMILY = 'Unassigned'

/// Placeholder for the ~67% of real rows that carry no Size attribute at
/// all. SizeOption is required on WarehouseVariant, so something has to
/// stand in for "this product doesn't come in sizes."
const DEFAULT_SIZE = 'One Size'

export type ImportCounts = {
  categories: number
  colourFamilies: number
  itemGroups: number
  sizeOptions: number
  colourVariants: number
  variations: number
  warehouseVariants: number
  /// INTAKE ledger events written for the initial on-hand stock -- one
  /// per SID with a non-zero Sortly Quantity, keyed idempotently so a
  /// re-run does not double-count.
  intakeEvents: number
  intakeUnits: number
  /// Photo URLs recorded on WarehouseVariant.photoUrls (sum across all
  /// rows). Excludes the ColourVariant.photoUrl backfill.
  photoUrls: number
}

export type ImportSummary = {
  rowsRead: number
  itemsParsed: number
  skipped: SkippedRow[]
  created: ImportCounts
  /// Per-row problems encountered while writing to the database (as
  /// opposed to `skipped`, which is parse-time). Never fatal to the run.
  warnings: string[]
}

/// Order-preserving concat: keep the existing list's order, append any
/// values from the incoming list not already present. Used for merging
/// duplicate-SID photoUrls without clobbering the earlier row's ordering.
function mergeUnique<T>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing)
  const out = [...existing]
  for (const v of incoming) {
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * Combines the raw Color and Style attributes into the identity used for a
 * ColourVariant row. Most real rows carry only one of the two, in which
 * case it is used directly. A minority carry both — e.g. a matched hat /
 * scarf / arm-warmer set that shares one Color across three Style values,
 * or a sock pattern with both a Color and a Style — and there it is the
 * pair together, not either alone, that identifies the physical item.
 * Keying on Color alone collapses those into one row and silently merges
 * distinct warehouse SKUs; verified against the real file, this composition
 * keeps every one of the 517 distinct SIDs mapped to its own identity.
 */
function colourVariantIdentity(item: ParsedSortlyItem): string {
  if (item.colour && item.style) return `${item.colour} (${item.style})`
  return item.colour ?? item.style ?? item.itemGroupName
}

@Injectable()
export class SortlyImportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parses and upserts a Sortly export into the catalog schema, in
   * dependency order: Category, per-category "Unassigned" ColourFamily,
   * ItemGroup, SizeOption, ColourVariant, Variation, WarehouseVariant.
   *
   * Idempotent: every write is a find-or-create keyed on the schema's own
   * unique constraints, so running this twice on the same input creates
   * nothing on the second pass.
   */
  async importCsv(csvText: string): Promise<ImportSummary> {
    const { items, skipped } = parseSortlyCsv(csvText)
    const warnings: string[] = []
    const created: ImportCounts = {
      categories: 0,
      colourFamilies: 0,
      itemGroups: 0,
      sizeOptions: 0,
      colourVariants: 0,
      variations: 0,
      warehouseVariants: 0,
      intakeEvents: 0,
      intakeUnits: 0,
      photoUrls: 0,
    }

    // Warehouse Location is required for INTAKE events (initial on-hand
    // stock from Sortly's Quantity). If none exists yet, the catalog
    // import still succeeds; a warning tells the operator to run
    // cli:seed-locations and re-import (or re-run just to fill stock in).
    // Multiple warehouses: take the first by name -- an intentional
    // ambiguity workflow-owners should make explicit before it happens.
    const warehouse = await this.prisma.location.findFirst({
      where: { kind: 'WAREHOUSE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    })
    if (!warehouse) {
      warnings.push('no WAREHOUSE location found -- Sortly Quantity was not seeded as INTAKE events')
    }

    // In-run caches only: correctness comes from the DB find-or-create
    // below, these just save redundant round-trips within one pass.
    const folderCache: FolderCache = new Map()
    const familyCache = new Map<string, string>()
    const itemGroupCache = new Map<string, string>()
    const sizeOptionCache = new Map<string, string>()
    const colourVariantCache = new Map<string, string>()
    const colourVariantHasPhoto = new Map<string, boolean>()
    const variationCache = new Map<string, string>()

    // Folder counting is done outside the helper so the "created" tally
    // reflects only rows this import actually inserted, not the whole
    // resolved chain (where the same primaryFolder might be shared across
    // 500 rows). Snapshot the cache size before/after each chain call.
    const trackFolderChain = async (item: {
      primaryFolder?: string
      subfolder1?: string
      subfolder2?: string
      subfolder3?: string
      subfolder4?: string
    }): Promise<string> => {
      const before = folderCache.size
      const leafId = await upsertSortlyFolderChain(this.prisma, item, folderCache)
      created.categories += folderCache.size - before
      return leafId
    }

    const getOrCreateUnassignedFamily = async (categoryId: string): Promise<string> => {
      const cached = familyCache.get(categoryId)
      if (cached) return cached
      const existing = await this.prisma.colourFamily.findUnique({
        where: { categoryId_name: { categoryId, name: UNASSIGNED_FAMILY } },
      })
      if (existing) {
        familyCache.set(categoryId, existing.id)
        return existing.id
      }
      const row = await this.prisma.colourFamily.create({
        data: { categoryId, name: UNASSIGNED_FAMILY, displayOrder: 0 },
      })
      created.colourFamilies++
      familyCache.set(categoryId, row.id)
      return row.id
    }

    const getOrCreateItemGroup = async (categoryId: string, name: string): Promise<string> => {
      const key = `${categoryId}::${name}`
      const cached = itemGroupCache.get(key)
      if (cached) return cached
      const existing = await this.prisma.itemGroup.findUnique({
        where: { categoryId_name: { categoryId, name } },
      })
      if (existing) {
        itemGroupCache.set(key, existing.id)
        return existing.id
      }
      const row = await this.prisma.itemGroup.create({ data: { categoryId, name, brand: 'OWN' } })
      created.itemGroups++
      itemGroupCache.set(key, row.id)
      return row.id
    }

    const getOrCreateSizeOption = async (categoryId: string, name: string): Promise<string> => {
      const key = `${categoryId}::${name}`
      const cached = sizeOptionCache.get(key)
      if (cached) return cached
      const existing = await this.prisma.sizeOption.findUnique({
        where: { categoryId_name: { categoryId, name } },
      })
      if (existing) {
        sizeOptionCache.set(key, existing.id)
        return existing.id
      }
      const row = await this.prisma.sizeOption.create({ data: { categoryId, name, displayOrder: 0 } })
      created.sizeOptions++
      sizeOptionCache.set(key, row.id)
      return row.id
    }

    const getOrCreateColourVariant = async (
      familyId: string,
      name: string,
      sortlyName: string | undefined,
      photoUrl: string | undefined,
    ): Promise<string> => {
      const key = `${familyId}::${name}`
      const cachedId = colourVariantCache.get(key)
      if (cachedId) {
        // A ColourVariant can be fed by more than one raw row (same colour
        // name reused across item groups within a category, or a
        // duplicate SID). If the row that happened to create it had no
        // photo but a later one does, backfill rather than leaving it
        // permanently un-photographed — Sortly is being retired and this
        // field is the archive of record. See getOrCreateVariant's cost
        // handling for the same "never lose available data" rationale.
        if (!colourVariantHasPhoto.get(key) && photoUrl) {
          await this.prisma.colourVariant.update({ where: { id: cachedId }, data: { photoUrl } })
          colourVariantHasPhoto.set(key, true)
        }
        return cachedId
      }
      const existing = await this.prisma.colourVariant.findUnique({
        where: { colourFamilyId_name: { colourFamilyId: familyId, name } },
      })
      if (existing) {
        colourVariantCache.set(key, existing.id)
        if (existing.photoUrl) {
          colourVariantHasPhoto.set(key, true)
        } else if (photoUrl) {
          await this.prisma.colourVariant.update({ where: { id: existing.id }, data: { photoUrl } })
          colourVariantHasPhoto.set(key, true)
        }
        return existing.id
      }
      const row = await this.prisma.colourVariant.create({
        data: {
          colourFamilyId: familyId,
          name,
          sortlyName: sortlyName ?? null,
          normalisedName: name.trim().toLowerCase(),
          photoUrl: photoUrl ?? null,
          // No automated assignment has run yet — Task 3 owns that. MANUAL
          // at confidence 0 marks this as an unassigned placeholder rather
          // than implying a lexical/visual match that never happened.
          familyAssignmentSource: 'MANUAL',
          familyConfidence: 0,
        },
      })
      created.colourVariants++
      colourVariantCache.set(key, row.id)
      colourVariantHasPhoto.set(key, Boolean(photoUrl))
      return row.id
    }

    const getOrCreateVariation = async (
      itemGroupId: string,
      familyId: string,
      sizeOptionId: string,
    ): Promise<string> => {
      const key = `${itemGroupId}::${familyId}::${sizeOptionId}`
      const cached = variationCache.get(key)
      if (cached) return cached
      const existing = await this.prisma.variation.findUnique({
        where: {
          itemGroupId_colourFamilyId_sizeOptionId: { itemGroupId, colourFamilyId: familyId, sizeOptionId },
        },
      })
      if (existing) {
        variationCache.set(key, existing.id)
        return existing.id
      }
      const row = await this.prisma.variation.create({
        data: { itemGroupId, colourFamilyId: familyId, sizeOptionId },
      })
      created.variations++
      variationCache.set(key, row.id)
      return row.id
    }

    for (const item of items) {
      try {
        // Sortly's folder chain becomes the Category tree: primaryFolder is
        // the root ("BärHaus (IN STOCK)"), subfolder1..4 nest below. The
        // ItemGroup attaches to the leaf — whichever level this row
        // populates deepest.
        const categoryId = await trackFolderChain(item)
        const familyId = await getOrCreateUnassignedFamily(categoryId)
        const itemGroupId = await getOrCreateItemGroup(categoryId, item.itemGroupName)
        const sizeName = item.size ?? DEFAULT_SIZE
        const sizeOptionId = await getOrCreateSizeOption(categoryId, sizeName)

        const colourName = colourVariantIdentity(item)
        const colourVariantId = await getOrCreateColourVariant(familyId, colourName, item.colour, item.photoUrl)

        const variationId = await getOrCreateVariation(itemGroupId, familyId, sizeOptionId)

        // Composite unique dropped in migration 20260827130000 in favour of
        // warehouseSku as the sole per-SKU identity; findFirst instead of
        // findUnique here. Legacy CSV importer keeps working for the
        // "duplicate SID in the same batch" merge behaviour below.
        const existingWv = await this.prisma.warehouseVariant.findFirst({
          where: { itemGroupId, colourVariantId, sizeOptionId },
        })
        let warehouseVariantId: string
        if (existingWv) {
          // Same physical SKU can appear more than once in the raw export
          // (47 SIDs repeat in the real file, always with the same
          // identity and only the quantity differing -- see the parser
          // report). Collapsing to one WarehouseVariant row is correct:
          // this task writes catalog rows, never a stored quantity. But a
          // "last write wins" merge on unitCostCents is wrong here: 2 of
          // the 6 real priced rows have a duplicate-SID sibling with no
          // price, and if that unpriced sibling is processed second it
          // would blindly null out a real price. A genuine price must
          // never be regressed to null by a blank duplicate.
          warehouseVariantId = existingWv.id
          const nextCost = item.unitCostCents ?? null
          const update: Prisma.WarehouseVariantUpdateInput = {}
          if (existingWv.unitCostCents === null && nextCost !== null) {
            update.unitCostCents = nextCost
          } else if (
            existingWv.unitCostCents !== null &&
            nextCost !== null &&
            existingWv.unitCostCents !== nextCost
          ) {
            warnings.push(
              `conflicting price for duplicate SID ${item.sid} (${item.entryName}): ` +
                `keeping ${existingWv.unitCostCents}, saw ${nextCost}`,
            )
          }
          // Merge photo URLs from the duplicate row rather than dropping
          // them. Order-preserving dedupe: existing first, then any new
          // ones the duplicate happened to carry.
          const mergedPhotos = mergeUnique(existingWv.photoUrls, item.photoUrls)
          if (mergedPhotos.length !== existingWv.photoUrls.length) {
            update.photoUrls = { set: mergedPhotos }
            created.photoUrls += mergedPhotos.length - existingWv.photoUrls.length
          }
          if (Object.keys(update).length > 0) {
            await this.prisma.warehouseVariant.update({ where: { id: existingWv.id }, data: update })
          }
        } else {
          try {
            const wv = await this.prisma.warehouseVariant.create({
              data: {
                itemGroupId,
                colourVariantId,
                sizeOptionId,
                variationId,
                warehouseSku: item.sid,
                unitCostCents: item.unitCostCents ?? null,
                photoUrls: item.photoUrls,
              },
              select: { id: true },
            })
            warehouseVariantId = wv.id
            created.warehouseVariants++
            created.photoUrls += item.photoUrls.length
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
              warnings.push(`warehouseSku collision for SID ${item.sid} (${item.entryName}): ${err.message}`)
              continue
            }
            throw err
          }
        }

        // Initial on-hand stock at the warehouse. INTAKE event keyed
        // `sortly-intake:{sid}` so re-importing the same file is a
        // no-op rather than double-counting.
        if (warehouse && item.quantity > 0) {
          try {
            await this.prisma.ledgerEvent.create({
              data: {
                type: 'INTAKE',
                locationId: warehouse.id,
                variationId,
                warehouseVariantId,
                quantity: item.quantity,
                occurredAt: new Date(),
                source: 'SCRIPT',
                sourceRef: `sortly-import:${item.sid}`,
                idempotencyKey: `sortly-intake:${item.sid}`,
                note: `initial stock from Sortly (${item.entryName})`,
              },
            })
            created.intakeEvents++
            created.intakeUnits += item.quantity
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
              // Prior run already seeded this row; leave that event authoritative.
            } else {
              throw err
            }
          }
        }
      } catch (err) {
        warnings.push(`failed to import SID ${item.sid} (${item.entryName}): ${(err as Error).message}`)
      }
    }

    return {
      rowsRead: items.length + skipped.length,
      itemsParsed: items.length,
      skipped,
      created,
      warnings,
    }
  }
}

@Module({
  imports: [PrismaModule, AuthModule, LedgerModule],
  controllers: [CatalogController],
  providers: [
    SortlyImportService,
    CatalogReadService,
    SquareCatalogSyncService,
    StockCorrectionService,
    ProductCreationService,
    ProductUpdateService,
    CloudinarySignatureService,
  ],
  exports: [SortlyImportService, CatalogReadService, SquareCatalogSyncService],
})
export class CatalogModule {}
