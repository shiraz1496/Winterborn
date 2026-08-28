import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { square, assertNoErrors } from './square-client.js'

export interface SquareCatalogSyncResult {
  itemsSynced: number
  variationsSynced: number
  itemsRemoved: number
  variationsRemoved: number
  pages: number
  syncedAt: Date
}

/**
 * Pages through Square's Catalog API, upserting every ITEM and its nested
 * ITEM_VARIATION rows into the local SquareCatalogItem / SquareCatalogVariation
 * cache. The mapping modal reads from this cache so operators pick a Square
 * product/variation from a dropdown instead of pasting IDs. Runs are safe to
 * re-run: everything upserts by primary key.
 *
 * After the sync, any locally-cached row whose lastSyncedAt is older than the
 * pass timestamp is deleted — that's how removals in Square propagate here.
 * Idempotent enough to safely schedule on a cron.
 */
@Injectable()
export class SquareCatalogSyncService {
  private readonly logger = new Logger(SquareCatalogSyncService.name)

  constructor(private readonly prisma: PrismaService) {}

  async sync(): Promise<SquareCatalogSyncResult> {
    const syncedAt = new Date()
    let itemsSynced = 0
    let variationsSynced = 0
    let pages = 1

    // catalog.list returns a Page<CatalogObject> — an AsyncIterable that
    // walks every page transparently. `types: 'ITEM'` limits to items and
    // includes their nested variations, so we don't need a second call for
    // ITEM_VARIATION rows. camelCase because the SDK translates the wire
    // snake_case fields; priceMoney.amount is a bigint on the type.
    const page = await square.catalog.list({ types: 'ITEM' })

    interface CatalogObjectLike {
      id?: string
      type?: string
      itemData?: {
        name?: string
        variations?: Array<{
          id?: string
          type?: string
          itemVariationData?: {
            name?: string
            priceMoney?: { amount?: bigint | number | null }
          }
        }>
      }
    }

    for await (const raw of page) {
      const obj = raw as CatalogObjectLike
      if (obj.type !== 'ITEM' || !obj.id || !obj.itemData?.name) continue
      const squareItemId = obj.id
      const itemName = obj.itemData.name

      await this.prisma.squareCatalogItem.upsert({
        where: { squareItemId },
        create: { squareItemId, name: itemName, lastSyncedAt: syncedAt },
        update: { name: itemName, lastSyncedAt: syncedAt },
      })
      itemsSynced++

      for (const variation of obj.itemData.variations ?? []) {
        if (variation.type !== 'ITEM_VARIATION' || !variation.id || !variation.itemVariationData?.name) continue
        const squareVariationId = variation.id
        const variationName = variation.itemVariationData.name
        const rawAmount = variation.itemVariationData.priceMoney?.amount
        const priceCents = rawAmount === null || rawAmount === undefined ? null : Number(rawAmount)

        await this.prisma.squareCatalogVariation.upsert({
          where: { squareVariationId },
          create: {
            squareVariationId,
            squareItemId,
            name: variationName,
            priceCents,
            lastSyncedAt: syncedAt,
          },
          update: {
            squareItemId,
            name: variationName,
            priceCents,
            lastSyncedAt: syncedAt,
          },
        })
        variationsSynced++
      }
    }

    // Rows the sync didn't touch this pass are stale — Square removed them.
    // Cascade delete on the item side removes their variations automatically;
    // we still explicitly clean any orphan variations whose parent survived
    // but who themselves were dropped from the item's variations list.
    const removedVariations = await this.prisma.squareCatalogVariation.deleteMany({
      where: { lastSyncedAt: { lt: syncedAt } },
    })
    const removedItems = await this.prisma.squareCatalogItem.deleteMany({
      where: { lastSyncedAt: { lt: syncedAt } },
    })

    this.logger.log(
      `sync complete: ${itemsSynced} items, ${variationsSynced} variations, ` +
        `${removedItems.count} items removed, ${removedVariations.count} variations removed, ` +
        `${pages} pages`,
    )

    return {
      itemsSynced,
      variationsSynced,
      itemsRemoved: removedItems.count,
      variationsRemoved: removedVariations.count,
      pages,
      syncedAt,
    }
  }
}
