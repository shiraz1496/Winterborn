-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "squareImageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Category_squareImageId_key" ON "Category"("squareImageId");
