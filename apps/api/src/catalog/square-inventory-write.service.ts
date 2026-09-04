import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { AuditService } from '../audit/audit.service.js'
import { square, assertNoErrors } from './square-client.js'

/**
 * Pushes REAL per-market stock counts to Square's Inventory API, so a
 * market's Square POS reflects actual accurate availability instead of
 * one global "sellable" flag shared identically across every location
 * (the gap in catalog-only sync: Square's catalog objects are shared
 * across the whole merchant account by default, so a catalog-only push
 * makes an item look available everywhere the instant it exists
 * anywhere — this service is what makes "in stock at Denver, out of
 * stock at Atlanta" actually true on Square's side, not just in ours).
 *
 * One direction only: local ledger → Square. Real sales rung up at
 * Square POS decrement Square's own count automatically from there —
 * this service does not read Square's count back, and nothing in
 * apps/api/src/square/ (the SALE-ingestion pipeline) writes inventory to
 * Square either, so there's no risk of two paths fighting over the same
 * number.
 */
@Injectable()
export class SquareInventoryWriteService {
  private readonly logger = new Logger(SquareInventoryWriteService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sets the ABSOLUTE stock count for one SKU at one market on Square
   * (a PHYSICAL_COUNT change, not a delta) — always the true current
   * number, never an increment, so repeated calls (e.g. two arrivals of
   * the same SKU at the same market over time) always converge on
   * reality regardless of what Square previously held.
   *
   * Best-effort, never throws: this always runs alongside a real stock
   * movement (dispatch/arrival) in BoxesService that must complete
   * regardless of Square's state. Two specific gaps are expected and
   * silently skipped rather than failing the caller:
   *   - The SKU has no squareVariationId yet (catalog sync hasn't
   *     linked it — should be rare since this is always called right
   *     after a catalog sync, but a prior sync failure is possible).
   *   - The market has no squareLocationId (not yet linked to Square —
   *     see admin-locations.service.ts; an operator must run that link
   *     step before per-market inventory can flow for that market).
   */
  async pushCountBestEffort(warehouseVariantId: string, locationId: string, quantity: number): Promise<void> {
    try {
      const [wv, location] = await Promise.all([
        this.prisma.warehouseVariant.findUnique({
          where: { id: warehouseVariantId },
          select: { squareVariationId: true, warehouseSku: true },
        }),
        this.prisma.location.findUnique({
          where: { id: locationId },
          select: { squareLocationId: true, name: true },
        }),
      ])
      if (!wv?.squareVariationId) {
        this.logger.warn(
          `skipping Square inventory push for warehouse variant ${warehouseVariantId} — ` +
            `not yet linked to a Square catalog variation`,
        )
        await this.audit.record(null, {
          entity: 'WarehouseVariant',
          entityId: warehouseVariantId,
          field: 'squareInventorySync',
          oldValue: null,
          newValue: 'skipped — not linked to a Square catalog variation',
          source: 'SYSTEM',
          locationId,
        })
        return
      }
      if (!location?.squareLocationId) {
        this.logger.warn(
          `skipping Square inventory push for "${location?.name ?? locationId}" — ` +
            `this location isn't linked to a Square location yet`,
        )
        await this.audit.record(null, {
          entity: 'Location',
          entityId: locationId,
          field: 'squareInventorySync',
          oldValue: null,
          newValue: 'skipped — location has no squareLocationId',
          source: 'SYSTEM',
          reason: `stock push for ${wv.warehouseSku} could not reach Square`,
        })
        return
      }

      const idempotencyKey = `inventory-${warehouseVariantId}-${locationId}-${Date.now()}`
      const res = await square.inventory.batchCreateChanges({
        idempotencyKey,
        changes: [
          {
            type: 'PHYSICAL_COUNT',
            physicalCount: {
              catalogObjectId: wv.squareVariationId,
              locationId: location.squareLocationId,
              state: 'IN_STOCK',
              quantity: String(Math.max(0, Math.round(quantity))),
              occurredAt: new Date().toISOString(),
            },
          },
        ],
      })
      assertNoErrors(res, `inventory.batchCreateChanges (${wv.warehouseSku} @ ${location.name})`)
      this.logger.log(`pushed Square inventory: ${wv.warehouseSku} = ${quantity} at ${location.name}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(
        `Square inventory push failed for warehouse variant ${warehouseVariantId} @ location ${locationId}: ` +
          message,
      )
      // Same rationale as SquareCatalogWriteService's failure audit: this
      // is best-effort by design, so without an in-app trace a failed
      // push is invisible — Square's count silently goes stale (still
      // showing the PREVIOUS pushed value) and nobody notices.
      await this.audit.record(null, {
        entity: 'WarehouseVariant',
        entityId: warehouseVariantId,
        field: 'squareInventorySyncFailed',
        oldValue: null,
        newValue: message,
        source: 'SYSTEM',
        locationId,
      })
    }
  }
}
