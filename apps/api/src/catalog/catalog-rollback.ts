import type { Square } from 'square'
import { square, assertNoErrors } from './square-client.js'
import type { CatalogPlan } from './catalog-plan.js'
import { buildAllowlist, assertObjectAllowed } from './catalog-plan.js'

/**
 * Build guide guard 5: reverses an applied plan. The migration only ever
 * adds and renames (decision record Decisions 1-2), so a rollback never
 * needs to delete anything -- which is exactly as well, since the "no
 * deletes" guard in `square-client.ts` would refuse it anyway. Two writes
 * per item, both plain upserts:
 *
 *   1. Rename the legacy variation back from `item.legacyLabel`
 *      (`"Unspecified (pre-2026)"`) to `item.originalLegacyName`, and
 *      restore its `sellable`/`stockable` flags -- undoing exactly the
 *      relabel step `applyPlan` performed, using the fields captured in
 *      the plan at build time for precisely this purpose.
 *   2. "Archive" the variations the plan added. `CatalogItemVariation` has
 *      no `isArchived` field -- that flag exists only on `CatalogItem`
 *      (see `square-client.ts`'s delete guard, which forbids setting it) --
 *      so there is no way to archive a single variation without deleting
 *      it. The equivalent that keeps the object alive and reversible is
 *      used instead: `sellable: false`, `presentAtAllLocations: false`,
 *      `presentAtLocationIds: []`. The variation still exists (still
 *      resolvable, still holding whatever it held), it is just hidden and
 *      unsellable everywhere -- nothing is destroyed, so re-applying the
 *      plan again afterward is still possible.
 *
 * New variations are identified by SKU (from `item.newVariations`), not by
 * ID recorded at apply time -- this makes rollback correct even if it's
 * run against a plan whose `.result.json` is missing or stale, since SKU is
 * the one identifier written into the plan file itself and reviewed by a
 * human before either apply or rollback ran.
 */

function isItem(obj: Square.CatalogObject | undefined): obj is Square.CatalogObject.Item {
  return obj?.type === 'ITEM'
}

function isItemVariation(obj: Square.CatalogObject): obj is Square.CatalogObject.ItemVariation {
  return obj.type === 'ITEM_VARIATION'
}

export type RollbackOutcome = {
  itemGroupId: string
  itemGroupName: string
  squareItemId: string
  status: 'rolled-back' | 'already-rolled-back' | 'failed'
  archivedVariationIds?: string[]
  error?: string
}

export async function rollbackPlan(plan: CatalogPlan): Promise<RollbackOutcome[]> {
  const allowlist = buildAllowlist(plan)
  const results: RollbackOutcome[] = []

  for (const item of plan.items) {
    try {
      assertObjectAllowed(item.squareItemId, allowlist, `rollbackPlan (${item.itemGroupName})`)
      assertObjectAllowed(item.legacyVariationId, allowlist, `rollbackPlan (${item.itemGroupName})`)

      const current = await square.catalog.object.get({ objectId: item.squareItemId })
      assertNoErrors(current, `catalog.object.get (rollbackPlan read ${item.itemGroupName})`)
      const obj = current.object
      if (!isItem(obj) || !obj.itemData) {
        throw new Error(`${item.squareItemId} is not a live ITEM`)
      }

      const variations = (obj.itemData.variations ?? []).filter(isItemVariation)
      const legacy = variations.find((v) => v.id === item.legacyVariationId)
      if (!legacy) throw new Error(`legacy variation ${item.legacyVariationId} not found on ${item.squareItemId}`)

      const newSkus = new Set(item.newVariations.map((nv) => nv.sku))
      const added = variations.filter((v) => v.id !== item.legacyVariationId && newSkus.has(v.itemVariationData?.sku ?? ''))
      const untouched = variations.filter((v) => v.id !== item.legacyVariationId && !added.some((a) => a.id === v.id))

      const alreadyRolledBack =
        legacy.itemVariationData?.name === item.originalLegacyName &&
        legacy.itemVariationData?.sellable === item.originalLegacySellable &&
        added.every((v) => v.itemVariationData?.sellable === false)

      if (alreadyRolledBack) {
        results.push({
          itemGroupId: item.itemGroupId,
          itemGroupName: item.itemGroupName,
          squareItemId: item.squareItemId,
          status: 'already-rolled-back',
          archivedVariationIds: added.map((v) => v.id),
        })
        continue
      }

      const restoredLegacy: Square.CatalogObject.ItemVariation = {
        ...legacy,
        itemVariationData: {
          ...legacy.itemVariationData,
          name: item.originalLegacyName,
          sellable: item.originalLegacySellable,
          stockable: item.originalLegacyStockable,
        },
      }

      const archivedNew: Square.CatalogObject.ItemVariation[] = added.map((v) => ({
        ...v,
        itemVariationData: {
          ...v.itemVariationData,
          sellable: false,
          presentAtAllLocations: false,
          presentAtLocationIds: [],
        },
      }))

      const idempotencyKey = `catalog-rollback-${item.squareItemId}-${plan.createdAt}`

      const res = await square.catalog.object.upsert({
        idempotencyKey,
        object: {
          ...obj,
          itemData: {
            ...obj.itemData,
            variations: [restoredLegacy, ...archivedNew, ...untouched],
          },
        },
      })
      assertNoErrors(res, `catalog.object.upsert (rollbackPlan write ${item.itemGroupName})`)

      const saved = res.catalogObject
      if (!isItem(saved) || !saved.itemData) {
        throw new Error(`rollback upsert for ${item.squareItemId} returned no ITEM object`)
      }

      results.push({
        itemGroupId: item.itemGroupId,
        itemGroupName: item.itemGroupName,
        squareItemId: saved.id,
        status: 'rolled-back',
        archivedVariationIds: archivedNew.map((v) => v.id),
      })
    } catch (err) {
      results.push({
        itemGroupId: item.itemGroupId,
        itemGroupName: item.itemGroupName,
        squareItemId: item.squareItemId,
        status: 'failed',
        error: (err as Error).message,
      })
    }
  }

  return results
}
