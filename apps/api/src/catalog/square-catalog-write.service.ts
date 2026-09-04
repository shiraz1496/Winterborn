import { Injectable, Logger } from '@nestjs/common'
import type { Square } from 'square'
import { PrismaService } from '../prisma/prisma.service.js'
import { AuditService } from '../audit/audit.service.js'
import { square, assertNoErrors, isNotFoundError, isVersionMismatchError, catalogObjectExists } from './square-client.js'

const CURRENCY = 'USD' as Square.Currency
const DEFAULT_SIZE = 'One Size'

export interface SquareSyncResult {
  itemGroupId: string
  squareItemId: string
  variationsSynced: number
  newlyLinked: number
}

/**
 * Pushes local product create/update into Square's catalog — the
 * outward direction of sync. `SquareCatalogSyncService` (a sibling)
 * only ever reads FROM Square into our cache tables; this is the first
 * write-to-Square path reachable from live app code rather than a
 * one-off migration script (see catalog-plan.ts for the only prior
 * precedent, which this mirrors for object shape).
 *
 * Every write goes through the guarded `square` client from
 * square-client.ts, which throws before any HTTP call on a delete or an
 * archiving upsert (itemData.isArchived: true) — this service never
 * attempts either. Removing a colour/size locally does NOT remove or
 * archive it on Square; that stays a deliberate manual action.
 */
@Injectable()
export class SquareCatalogWriteService {
  private readonly logger = new Logger(SquareCatalogWriteService.name)

  /**
   * Per-itemGroupId async mutex. `syncItemGroupToSquare` reads Square's
   * current object version, builds the full object from our DB, then
   * upserts carrying that version forward — read-then-write, not atomic.
   * Two dispatches/arrivals of DIFFERENT colours of the SAME product
   * within moments of each other (plausible: two operators packing at
   * once, or a multi-request shipment dispatching several boxes of one
   * product together) can both read the same version and race, and the
   * loser gets VERSION_MISMATCH. This serialises calls per item group
   * within this process so the second call simply waits and reads the
   * version the first one just wrote, instead of racing it. In-process
   * only (no Redis/DB lock) -- sufficient today since apps/api runs as a
   * single instance; the VERSION_MISMATCH retry below is the second line
   * of defence for a race this mutex can't see (a second process).
   */
  private readonly itemGroupLocks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async withItemGroupLock<T>(itemGroupId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.itemGroupLocks.get(itemGroupId) ?? Promise.resolve()
    const next = prior.then(fn, fn)
    this.itemGroupLocks.set(itemGroupId, next.catch(() => {}))
    return next
  }

  /**
   * Resolves a local Category to a Square CATEGORY object id, creating
   * one on Square (and every un-synced ancestor above it) if none exists
   * yet. Never blocks on a missing mapping — that's the whole point: an
   * operator can map a Category to an existing Square category by hand
   * via PATCH catalog/categories/:id/square-id first if they want to
   * reuse one, but if nobody has, this creates a fresh Square category
   * automatically rather than leaving the product uncategorised.
   *
   * Walks up the parent chain first so a child category's Square object
   * always references a real, already-created parent id — Square has no
   * "create the whole chain in one call" for categories the way an ITEM
   * can carry brand-new nested variations.
   *
   * Skips the lone meta-root ("BärHaus (IN STOCK)") — it's the warehouse/
   * brand name, not a real merchandising category, and must never itself
   * become (or head) a Square category. Its direct children become the
   * effective top-level Square categories instead. Same "single root,
   * promote children" rule the /requests/suggest category picker already
   * applies client-side (pickableCategories) — mirrored here so a
   * category synced automatically lands exactly where an operator
   * manually picking from that same picker would expect it.
   */
  async resolveSquareCategoryId(categoryId: string): Promise<string> {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } })
    if (!category) throw new Error(`category ${categoryId} not found`)
    if (category.squareCategoryId) {
      // Verify the cached id still resolves before trusting it — a
      // sandbox reset (or a category deleted by hand on the Square side)
      // otherwise leaves us referencing a dead id forever, which Square
      // rejects at ITEM-upsert time with a confusing "does not exist"
      // error that doesn't even name the category. Same "stale id ->
      // treat as unlinked, recreate" pattern as syncItemGroupToSquare's
      // 404 handling for squareItemId.
      if (await catalogObjectExists(category.squareCategoryId)) {
        await this.ensureCategoryImage(category.id, category.squareCategoryId, category.squareImageId)
        // Ancestors only get resolved (and therefore only get their
        // image checked) on the "not yet linked" branch below, via
        // effectiveParentSquareCategoryId -- a category that's ALREADY
        // linked (the common case once a season is underway) hits this
        // early return and skips that walk entirely. Without this, a
        // parent category with no products directly in it (everything
        // lives one level down, in a child) never gets its image
        // ensured, because nothing ever calls resolveSquareCategoryId
        // on it directly. Confirmed live: "Scarves" stayed imageless
        // while its child "Scarves (Peru)" (the one with actual SKUs)
        // correctly got one.
        await this.ensureAncestorCategoryImages(category.parentId)
        return category.squareCategoryId
      }
      this.logger.warn(
        `Square category ${category.squareCategoryId} for "${category.name}" no longer exists on ` +
          `Square — recreating.`,
      )
    }

    if (category.parentId === null && (await this.isLoneMetaRoot(categoryId))) {
      throw new Error(
        `refusing to create a Square category for "${category.name}" — it's the lone top-level ` +
          `folder (warehouse/brand name), not a real category. Products must live in one of its ` +
          `children, not directly in it.`,
      )
    }

    const parentSquareCategoryId = category.parentId
      ? await this.effectiveParentSquareCategoryId(category.parentId)
      : undefined

    const idempotencyKey = `category-sync-${categoryId}-${Date.now()}`
    const res = await square.catalog.object.upsert({
      idempotencyKey,
      object: {
        type: 'CATEGORY',
        id: '#category',
        categoryData: {
          name: category.name,
          categoryType: 'REGULAR_CATEGORY',
          parentCategory: parentSquareCategoryId ? { id: parentSquareCategoryId } : undefined,
        },
      },
    })
    assertNoErrors(res, `catalog.object.upsert (resolveSquareCategoryId ${category.name})`)

    const saved = res.catalogObject
    if (!saved || saved.type !== 'CATEGORY' || !saved.id) {
      throw new Error(`upsert for category ${categoryId} ("${category.name}") returned no CATEGORY object`)
    }

    await this.prisma.category.update({ where: { id: categoryId }, data: { squareCategoryId: saved.id } })
    this.logger.log(`created Square category "${category.name}" (${saved.id})`)
    await this.audit.record(null, {
      entity: 'Category',
      entityId: categoryId,
      field: 'squareCategoryId',
      oldValue: null,
      newValue: saved.id,
      source: 'SYSTEM',
      reason: 'auto-created on Square — no manual mapping existed for this category',
    })
    await this.ensureCategoryImage(categoryId, saved.id, null)
    return saved.id
  }

  /**
   * Uploads this category's Square image if it doesn't have one yet —
   * the SAME preview photo the catalog browse UI already shows for this
   * folder tile (first non-null photo among its descendant SKUs, in
   * warehouseSku order — see CatalogReadService.browseFolder's
   * `toFolderRow`, which this mirrors so the two stay visually
   * consistent). No-op once `squareImageId` is set, so this never
   * re-uploads on every routine category resolve.
   */
  private async ensureCategoryImage(
    categoryId: string,
    squareCategoryId: string,
    currentSquareImageId: string | null,
  ): Promise<void> {
    if (currentSquareImageId !== null) return
    const photoUrl = await this.resolveCategoryPreviewPhotoUrl(categoryId)
    if (!photoUrl) return
    const imageId = await this.uploadSquareImageBestEffort(squareCategoryId, photoUrl, 'Category', categoryId)
    if (imageId) {
      await this.prisma.category.update({ where: { id: categoryId }, data: { squareImageId: imageId } })
    }
  }

  /**
   * Walks up from `categoryId` ensuring every already-linked ancestor
   * (up to, but excluding, the lone meta-root) gets its image checked
   * too. Only meaningful for ancestors that already have a
   * squareCategoryId — an unlinked one gets created (and image-ensured)
   * the normal way the first time something actually needs it, so
   * there's nothing to do here for that case, not an error.
   */
  private async ensureAncestorCategoryImages(categoryId: string | null): Promise<void> {
    if (!categoryId) return
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } })
    if (!category) return
    if (category.parentId === null && (await this.isLoneMetaRoot(categoryId))) return
    if (category.squareCategoryId && (await catalogObjectExists(category.squareCategoryId))) {
      await this.ensureCategoryImage(category.id, category.squareCategoryId, category.squareImageId)
    }
    await this.ensureAncestorCategoryImages(category.parentId)
  }

  /**
   * The same preview photo `CatalogReadService.browseFolder` computes
   * for this category's folder tile: the first non-null photo among
   * every WarehouseVariant anywhere in this category's subtree (self +
   * every descendant category), in deterministic warehouseSku order.
   */
  private async resolveCategoryPreviewPhotoUrl(categoryId: string): Promise<string | null> {
    const allCategories = await this.prisma.category.findMany({ select: { id: true, parentId: true } })
    const childrenOf = new Map<string, string[]>()
    for (const c of allCategories) {
      if (c.parentId) childrenOf.set(c.parentId, [...(childrenOf.get(c.parentId) ?? []), c.id])
    }
    const subtreeIds: string[] = []
    const stack = [categoryId]
    while (stack.length > 0) {
      const id = stack.pop()!
      subtreeIds.push(id)
      for (const childId of childrenOf.get(id) ?? []) stack.push(childId)
    }

    const variants = await this.prisma.warehouseVariant.findMany({
      where: { itemGroup: { categoryId: { in: subtreeIds } } },
      select: { photoUrls: true, colourVariant: { select: { photoUrl: true } } },
      orderBy: { warehouseSku: 'asc' },
    })
    for (const wv of variants) {
      const photo = wv.photoUrls[0] ?? wv.colourVariant.photoUrl
      if (photo) return photo
    }
    return null
  }

  /**
   * The Square parentCategory id a category's Square object should
   * reference, given its LOCAL parentId — `undefined` (no parent link,
   * i.e. top-level on Square) when that parent is the lone meta-root,
   * otherwise the parent's own resolved Square category id.
   */
  private async effectiveParentSquareCategoryId(parentId: string): Promise<string | undefined> {
    const parent = await this.prisma.category.findUnique({ where: { id: parentId } })
    if (!parent) throw new Error(`category ${parentId} not found`)
    if (parent.parentId === null && (await this.isLoneMetaRoot(parentId))) {
      return undefined
    }
    return this.resolveSquareCategoryId(parentId)
  }

  /**
   * True when `categoryId` is the SOLE top-level category in the whole
   * tree — the "BärHaus (IN STOCK)" meta-root case. If there is ever
   * more than one true root category, none of them are treated as a
   * meta-root to skip; each becomes a real top-level Square category on
   * its own, since "skip the root" only makes sense when there's a
   * single, unambiguous brand/warehouse-name wrapper around everything.
   */
  private async isLoneMetaRoot(categoryId: string): Promise<boolean> {
    const rootCount = await this.prisma.category.count({ where: { parentId: null } })
    if (rootCount !== 1) return false
    const root = await this.prisma.category.findFirst({ where: { parentId: null }, select: { id: true } })
    return root?.id === categoryId
  }

  /**
   * Pushes the FULL current state of one product (ItemGroup + every one
   * of its live WarehouseVariants) to Square. Creates the Square ITEM on
   * first sync (ItemGroup.squareItemId is still null); updates it on
   * every later call.
   *
   * Always rebuilds the complete variations list from our own DB, never
   * a partial one. Square's object-upsert REPLACES an ITEM's `variations`
   * array wholesale — confirmed by the existing migration precedent in
   * catalog-plan.ts, which has to read-modify-write the current object
   * for exactly this reason. Sending only the WarehouseVariant that
   * just changed would silently drop every sibling colour from Square.
   * Our local DB is already the source of truth for a product's full SKU
   * list, so reconstructing it here on every sync is simpler and safer
   * than diffing against whatever Square currently holds.
   *
   * Idempotent per SKU: a WarehouseVariant that already has a
   * `squareVariationId` is upserted onto that same Square object instead
   * of creating a duplicate. A brand-new SKU gets a client temp id
   * (`#wv-<id>`); Square resolves it to a real id in the response, which
   * we match back to our rows by `sku` (the reliable correlation key —
   * Square's own id is opaque until this call returns) and persist onto
   * both `ItemGroup.squareItemId` and `WarehouseVariant.squareVariationId`
   * immediately, so the link is automatic instead of a manual follow-up
   * step through the admin mapping screen.
   */
  /**
   * Square location ids EACH warehouse variant should currently be
   * PRESENT at on Square — every market that has ever had a DISPATCHED
   * or ARRIVED box carrying THAT SPECIFIC SKU, mapped to that market's
   * squareLocationId (markets with no Square link yet are silently
   * dropped — nothing to restrict to). Grows over time as more markets
   * receive it; never shrinks (a market that received stock once stays
   * present even if fully sold through — "no longer stocked here right
   * now" is an inventory-count question, "was this ever sold here" is a
   * presence question, and Square already answers the former via
   * trackInventory + the counts SquareInventoryWriteService pushes).
   *
   * Deliberately PER-VARIANT, not per item group: a family-wide "any
   * colour ever reached this market" list applied uniformly to every
   * colour would leak presence sideways — e.g. Blue dispatched to Denver
   * and Red dispatched to Atlanta would each incorrectly show as present
   * at BOTH markets, because the shared list is the union of both.
   * Confirmed live: exactly this happened before this fix. The ITEM
   * itself still gets the union (an item is "at" a market if any of its
   * colours are), computed here as a byproduct.
   */
  private async presentSquareLocationIdsByVariant(
    warehouseVariantIds: string[],
  ): Promise<{ byVariant: Map<string, string[]>; itemUnion: string[] }> {
    if (warehouseVariantIds.length === 0) return { byVariant: new Map(), itemUnion: [] }

    const lines = await this.prisma.boxLine.findMany({
      where: {
        warehouseVariantId: { in: warehouseVariantIds },
        box: { state: { in: ['DISPATCHED', 'ARRIVED'] } },
      },
      select: { warehouseVariantId: true, box: { select: { destinationLocationId: true } } },
    })

    const localLocationIdsByVariant = new Map<string, Set<string>>()
    const allLocalLocationIds = new Set<string>()
    for (const line of lines) {
      const set = localLocationIdsByVariant.get(line.warehouseVariantId) ?? new Set<string>()
      set.add(line.box.destinationLocationId)
      localLocationIdsByVariant.set(line.warehouseVariantId, set)
      allLocalLocationIds.add(line.box.destinationLocationId)
    }
    if (allLocalLocationIds.size === 0) return { byVariant: new Map(), itemUnion: [] }

    const locations = await this.prisma.location.findMany({
      where: { id: { in: [...allLocalLocationIds] }, squareLocationId: { not: null } },
      select: { id: true, squareLocationId: true },
    })
    const squareIdByLocationId = new Map(locations.map((l) => [l.id, l.squareLocationId!]))

    const byVariant = new Map<string, string[]>()
    const itemUnionSet = new Set<string>()
    for (const [wvId, localIds] of localLocationIdsByVariant) {
      const squareIds = [...localIds].map((id) => squareIdByLocationId.get(id)).filter((id): id is string => !!id)
      byVariant.set(wvId, squareIds)
      for (const id of squareIds) itemUnionSet.add(id)
    }
    return { byVariant, itemUnion: [...itemUnionSet] }
  }

  /**
   * Serialised per item group (see itemGroupLocks above) and retried once
   * on VERSION_MISMATCH — the two lines of defence against a concurrent
   * dispatch/arrival/edit of a sibling colour racing this same product.
   */
  async syncItemGroupToSquare(itemGroupId: string): Promise<SquareSyncResult> {
    return this.withItemGroupLock(itemGroupId, async () => {
      try {
        return await this.syncItemGroupToSquareOnce(itemGroupId)
      } catch (err) {
        if (!isVersionMismatchError(err)) throw err
        this.logger.warn(
          `VERSION_MISMATCH syncing item group ${itemGroupId} — another update landed between our ` +
            `read and write. Re-reading the current version and retrying once.`,
        )
        return this.syncItemGroupToSquareOnce(itemGroupId)
      }
    })
  }

  private async syncItemGroupToSquareOnce(itemGroupId: string): Promise<SquareSyncResult> {
    const itemGroup = await this.prisma.itemGroup.findUnique({ where: { id: itemGroupId } })
    if (!itemGroup) throw new Error(`item group ${itemGroupId} not found`)

    // Only colours actually proven real by shipping somewhere — same
    // "not until dispatch" rule already applied to the whole item (see
    // product-creation.service.ts), scoped down to each individual SKU.
    // Without this, syncing ANY one dispatched colour pushed the item
    // group's ENTIRE local catalog breadth to Square — every colour
    // ever catalogued for this product, most with zero stock or market
    // history anywhere — because Square's upsert requires the complete
    // variations list and we were building it from every WarehouseVariant
    // under the item group instead of just the ones actually shipped.
    const variants = await this.prisma.warehouseVariant.findMany({
      where: {
        itemGroupId,
        boxLines: { some: { box: { state: { in: ['DISPATCHED', 'ARRIVED'] } } } },
      },
      include: { colourVariant: true, sizeOption: true },
      orderBy: { warehouseSku: 'asc' },
    })
    if (variants.length === 0) {
      throw new Error(
        `item group ${itemGroupId} ("${itemGroup.name}") has no dispatched warehouse variants to sync`,
      )
    }

    // Square's optimistic concurrency control: every catalog object (the
    // ITEM and each of its ITEM_VARIATIONs) carries a `version`, and an
    // upsert whose `version` doesn't match what Square currently has
    // stored is rejected with VERSION_MISMATCH. We build our objects
    // fresh from our own DB (see the class doc for why), so on every
    // update we first re-read the live object from Square purely to
    // carry its current version(s) forward — content still comes from
    // our DB, only the version fields are borrowed. First sync (no
    // squareItemId yet) skips this: there is nothing to read.
    //
    // A stored squareItemId that 404s on Square (object deleted by hand
    // on the Square side since our last sync) is treated as "not linked
    // yet" — falls through to creating a fresh item rather than failing
    // the whole update.
    let itemVersion: bigint | undefined
    const existingVariationVersions = new Map<string, bigint>()
    let squareItemId = itemGroup.squareItemId
    if (squareItemId) {
      try {
        const current = await square.catalog.object.get({ objectId: squareItemId })
        assertNoErrors(current, `catalog.object.get (syncItemGroupToSquare ${itemGroup.name})`)
        const obj = current.object
        if (obj && obj.type === 'ITEM') {
          itemVersion = obj.version
          for (const v of obj.itemData?.variations ?? []) {
            if (v.type === 'ITEM_VARIATION' && v.id && v.version != null) {
              existingVariationVersions.set(v.id, v.version)
            }
          }
        }
      } catch (err) {
        if (!isNotFoundError(err)) throw err
        this.logger.warn(
          `Square item ${squareItemId} for "${itemGroup.name}" no longer exists on Square — creating fresh.`,
        )
        squareItemId = null
      }
    }

    const itemTempId = squareItemId ?? '#item'
    const squareCategoryId = await this.resolveSquareCategoryId(itemGroup.categoryId)
    const { byVariant: presentLocationIdsByVariant, itemUnion: presentLocationIdsForItem } =
      await this.presentSquareLocationIdsByVariant(variants.map((wv) => wv.id))

    const variationObjects: Square.CatalogObject.Request[] = variants.map((wv) => {
      const hasPrice = wv.unitCostCents != null
      const squareVariationId = squareItemId ? wv.squareVariationId : null
      return {
        type: 'ITEM_VARIATION',
        id: squareVariationId ?? `#wv-${wv.id}`,
        version: squareVariationId ? existingVariationVersions.get(squareVariationId) : undefined,
        // Restrict to markets that have actually received THIS SKU — see
        // presentSquareLocationIdsByVariant. Without this a colour shows
        // as orderable at every market any sibling colour ever reached,
        // not just the ones it was itself dispatched to.
        presentAtAllLocations: false,
        presentAtLocationIds: presentLocationIdsByVariant.get(wv.id) ?? [],
        itemVariationData: {
          itemId: itemTempId,
          name: composeVariationName(wv.colourVariant.name, wv.sizeOption.name),
          sku: wv.warehouseSku,
          // VARIABLE_PRICING when we have no unitCostCents yet — Square
          // rejects FIXED_PRICING without a priceMoney. Re-synced
          // automatically to FIXED once a price is set (product update,
          // or the cli:assign-catalog-prices script).
          pricingType: hasPrice ? 'FIXED_PRICING' : 'VARIABLE_PRICING',
          priceMoney: hasPrice ? { amount: BigInt(wv.unitCostCents!), currency: CURRENCY } : undefined,
          sellable: wv.isSaleItem,
          stockable: true,
          // Without this, the per-location counts SquareInventoryWriteService
          // pushes are silently ignored by the Dashboard/POS (shows "-"
          // instead of a real number) and the variation never
          // auto-flips to "out of stock" at 0 — confirmed live: pushing
          // a 0 count with trackInventory unset left the item reading
          // "Available" with no stock number at all.
          trackInventory: true,
        },
      }
    })

    const idempotencyKey = `product-sync-${itemGroupId}-${Date.now()}`
    const res = await square.catalog.object.upsert({
      idempotencyKey,
      object: {
        type: 'ITEM',
        id: itemTempId,
        version: itemVersion,
        presentAtAllLocations: false,
        presentAtLocationIds: presentLocationIdsForItem,
        itemData: {
          name: itemGroup.name,
          variations: variationObjects,
          // categories/reportingCategory only — NOT the deprecated
          // categoryId field. Confirmed by a live 400 from Square:
          // categoryId rejects a NESTED category ("does not exist" even
          // though it's a real, valid CATEGORY object) — that legacy
          // field appears to only accept top-level categories. Since
          // most of this catalog's real categories are nested one level
          // deep, categoryId would fail for exactly the common case.
          // categories[]/reportingCategory are the modern, actually
          // Square-recommended fields and handle nesting correctly.
          categories: [{ id: squareCategoryId }],
          reportingCategory: { id: squareCategoryId },
        },
      },
    })
    assertNoErrors(res, `catalog.object.upsert (syncItemGroupToSquare ${itemGroup.name})`)

    const saved = res.catalogObject
    if (!saved || saved.type !== 'ITEM' || !saved.itemData || !saved.id) {
      throw new Error(`upsert for item group ${itemGroupId} ("${itemGroup.name}") returned no ITEM object`)
    }

    const isFirstLink = itemGroup.squareItemId === null
    if (itemGroup.squareItemId !== saved.id) {
      await this.prisma.itemGroup.update({ where: { id: itemGroupId }, data: { squareItemId: saved.id } })
      await this.audit.record(null, {
        entity: 'ItemGroup',
        entityId: itemGroupId,
        field: 'squareItemId',
        oldValue: itemGroup.squareItemId,
        newValue: saved.id,
        source: 'SYSTEM',
        reason: isFirstLink
          ? 'created on Square (first sync — see BoxesService.dispatch)'
          : 'Square item id changed — previous one no longer existed on Square, recreated',
      })
    }

    const savedIdBySku = new Map<string, string>()
    for (const v of saved.itemData.variations ?? []) {
      if (v.type !== 'ITEM_VARIATION' || !v.id) continue
      const sku = v.itemVariationData?.sku
      if (sku) savedIdBySku.set(sku, v.id)
    }

    let newlyLinked = 0
    for (const wv of variants) {
      const savedId = savedIdBySku.get(wv.warehouseSku)
      if (savedId && savedId !== wv.squareVariationId) {
        await this.prisma.warehouseVariant.update({
          where: { id: wv.id },
          data: { squareVariationId: savedId },
        })
        // Only the FIRST link per SKU is audit-worthy as a distinct fact;
        // re-running sync afterward keeps re-verifying the same id and
        // shouldn't spam the log. isFirstLink above already covers the
        // "whole product just created" case — this covers a colour added
        // to an EXISTING product later.
        if (wv.squareVariationId === null) {
          await this.audit.record(null, {
            entity: 'WarehouseVariant',
            entityId: wv.id,
            field: 'squareVariationId',
            oldValue: null,
            newValue: savedId,
            source: 'SYSTEM',
            reason: 'linked to Square during catalog sync',
          })
        }
        newlyLinked++
      }
    }

    this.logger.log(
      `synced "${itemGroup.name}" to Square (${saved.id}) — ${variants.length} variation(s), ${newlyLinked} newly linked`,
    )

    // Images — best-effort, after the catalog objects above so we have
    // real (non-temp) Square ids to attach to. Each variant with a photo
    // and no squareImageId yet gets its own primary image uploaded to its
    // ITEM_VARIATION; the parent ITEM gets the first photographed
    // variant's picture as ITS primary image too (ItemGroup carries no
    // photo of its own — see product-update.service.ts's photo field,
    // which lives on WarehouseVariant, not ItemGroup). Only uploads once
    // per object: re-syncing a product that already has an image never
    // re-uploads it, so this doesn't burn a Square API call on every
    // routine catalog resync.
    let itemImageDone = itemGroup.squareImageId !== null
    for (const wv of variants) {
      const photoUrl = wv.photoUrls[0]
      const savedVariationId = savedIdBySku.get(wv.warehouseSku)
      if (!photoUrl || !savedVariationId) continue

      if (wv.squareImageId === null) {
        const imageId = await this.uploadSquareImageBestEffort(savedVariationId, photoUrl, 'WarehouseVariant', wv.id)
        if (imageId) {
          await this.prisma.warehouseVariant.update({ where: { id: wv.id }, data: { squareImageId: imageId } })
        }
      }
      if (!itemImageDone) {
        const imageId = await this.uploadSquareImageBestEffort(saved.id, photoUrl, 'ItemGroup', itemGroupId)
        if (imageId) {
          await this.prisma.itemGroup.update({ where: { id: itemGroupId }, data: { squareImageId: imageId } })
        }
        itemImageDone = true
      }
    }

    return { itemGroupId, squareItemId: saved.id, variationsSynced: variants.length, newlyLinked }
  }

  /**
   * Uploads one photo (fetched server-side from its Cloudinary URL — the
   * Catalog API has no "create image from a URL" option, only multipart
   * bytes) as the primary CatalogImage for `objectId` (an ITEM or
   * ITEM_VARIATION's real Square id). Best-effort: a failed image upload
   * must never break the catalog sync that carries price/stock/category,
   * which matter far more than the picture. Returns the new CatalogImage
   * id, or null on any failure (fetch, non-2xx, or a Square-side error).
   */
  private async uploadSquareImageBestEffort(
    objectId: string,
    photoUrl: string,
    entity: 'WarehouseVariant' | 'ItemGroup' | 'Category',
    entityId: string,
  ): Promise<string | null> {
    try {
      const photoRes = await fetch(photoUrl)
      if (!photoRes.ok) throw new Error(`fetching photo ${photoUrl} returned ${photoRes.status}`)
      const bytes = Buffer.from(await photoRes.arrayBuffer())
      // Sortly's photo CDN serves every file as `binary/octet-stream`
      // regardless of the actual image format — confirmed live: Square
      // rejects that verbatim with INVALID_CONTENT_TYPE, since it only
      // accepts jpeg/png/gif. Sniff the real format from the file's
      // magic bytes instead of trusting the source's header.
      const contentType = sniffImageContentType(bytes)

      const idempotencyKey = `image-${objectId}-${Date.now()}`
      const res = await square.catalog.images.create({
        request: {
          idempotencyKey,
          objectId,
          isPrimary: true,
          image: {
            type: 'IMAGE',
            id: '#image',
            imageData: { name: `${objectId}-photo` },
          },
        },
        imageFile: new Blob([bytes], { type: contentType }),
      })
      assertNoErrors(res, `catalog.images.create (${objectId})`)
      const imageId = res.image?.id
      if (!imageId) throw new Error('Square returned no image id')
      this.logger.log(`uploaded Square image ${imageId} for ${objectId}`)
      return imageId
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(`Square image upload failed for ${objectId} (${photoUrl}): ${message}`)
      await this.audit.record(null, {
        entity,
        entityId,
        field: 'squareImageSyncFailed',
        oldValue: null,
        newValue: message,
        source: 'SYSTEM',
      })
      return null
    }
  }

  /**
   * Fire-and-log wrapper for the create/update hooks: Square must never
   * be a single point of failure for a local catalog write. The DB
   * transaction has already committed by the time this runs, so a
   * Square-side failure (network, rate limit, transient auth issue)
   * only means the product stays un-synced (ItemGroup.squareItemId is
   * still null, or unchanged) — it is logged clearly and can be retried
   * via `POST catalog/item-groups/:id/sync-square` without redoing the
   * local edit.
   */
  async syncItemGroupToSquareBestEffort(itemGroupId: string): Promise<void> {
    try {
      await this.syncItemGroupToSquare(itemGroupId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(
        `Square sync failed for item group ${itemGroupId} — product saved locally, ` +
          `NOT yet reflected on Square. Retry via POST catalog/item-groups/${itemGroupId}/sync-square. ` +
          `Cause: ${message}`,
      )
      // Server logs roll over and nobody watches them by default — this
      // is the ONLY in-app trace that a sync silently failed, since the
      // hooks that call this (dispatch/arrival/product edits) never
      // surface the failure to the person who triggered it either.
      await this.audit.record(null, {
        entity: 'ItemGroup',
        entityId: itemGroupId,
        field: 'squareSyncFailed',
        oldValue: null,
        newValue: message,
        source: 'SYSTEM',
        reason: `retry via POST catalog/item-groups/${itemGroupId}/sync-square`,
      })
    }
  }

  /**
   * Same as syncItemGroupToSquareBestEffort, but does nothing if this
   * product has never been pushed to Square yet (no squareItemId). Used
   * by product-field edits: a product isn't created on Square until a
   * box carrying it is actually DISPATCHED to a market (see BoxesService
   * .dispatch) — editing a not-yet-dispatched product must not be the
   * thing that creates it on Square early. Once it HAS been dispatched
   * and has a squareItemId, edits go on propagating live as normal.
   */
  async syncItemGroupToSquareIfLinkedBestEffort(itemGroupId: string): Promise<void> {
    const itemGroup = await this.prisma.itemGroup.findUnique({
      where: { id: itemGroupId },
      select: { squareItemId: true },
    })
    if (!itemGroup?.squareItemId) return
    await this.syncItemGroupToSquareBestEffort(itemGroupId)
  }
}

function composeVariationName(colourName: string, sizeName: string): string {
  if (sizeName === DEFAULT_SIZE || sizeName.trim().length === 0) return colourName
  return `${colourName} - ${sizeName}`
}

/**
 * Identifies an image's real format from its magic bytes — Square's
 * CreateCatalogImage only accepts jpeg/png/gif and validates the
 * multipart Content-Type strictly, but the source CDN (Sortly) serves
 * every photo as `binary/octet-stream` regardless of format, which
 * Square rejects outright. Falls back to jpeg (the overwhelming majority
 * of this catalog's archived photos) if the bytes don't match a known
 * signature rather than sending an unsupported type Square will reject
 * anyway.
 */
function sniffImageContentType(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') {
    return 'image/gif'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  return 'image/jpeg'
}
