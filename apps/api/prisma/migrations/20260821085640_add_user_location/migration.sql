-- DropForeignKey
ALTER TABLE "RestockRequestLine" DROP CONSTRAINT "RestockRequestLine_variationId_fkey";

-- DropForeignKey
ALTER TABLE "RestockRequestLine" DROP CONSTRAINT "RestockRequestLine_warehouseVariantId_fkey";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locationId" TEXT;

-- AddForeignKey
ALTER TABLE "RestockRequestLine" ADD CONSTRAINT "RestockRequestLine_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "Variation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RestockRequestLine" ADD CONSTRAINT "RestockRequestLine_warehouseVariantId_fkey" FOREIGN KEY ("warehouseVariantId") REFERENCES "WarehouseVariant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
