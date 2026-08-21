-- AddForeignKey
-- RESTRICT on both delete and update: a Variation or WarehouseVariant with
-- ledger history must fail as a clean FK violation, never as an UPDATE
-- against LedgerEvent (which would fire the append-only trigger — see the
-- doc comment on LedgerEvent.warehouseVariant in schema.prisma for why
-- Prisma's default SET NULL for this optional relation is unsafe here).
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "Variation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_warehouseVariantId_fkey" FOREIGN KEY ("warehouseVariantId") REFERENCES "WarehouseVariant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
