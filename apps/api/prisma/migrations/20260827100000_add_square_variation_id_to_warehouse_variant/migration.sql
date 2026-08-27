-- AlterTable
ALTER TABLE "WarehouseVariant" ADD COLUMN "squareVariationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseVariant_squareVariationId_key" ON "WarehouseVariant"("squareVariationId");
