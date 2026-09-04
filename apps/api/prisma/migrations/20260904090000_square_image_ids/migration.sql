-- AlterTable
ALTER TABLE "ItemGroup" ADD COLUMN     "squareImageId" TEXT;

-- AlterTable
ALTER TABLE "WarehouseVariant" ADD COLUMN     "squareImageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ItemGroup_squareImageId_key" ON "ItemGroup"("squareImageId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseVariant_squareImageId_key" ON "WarehouseVariant"("squareImageId");
