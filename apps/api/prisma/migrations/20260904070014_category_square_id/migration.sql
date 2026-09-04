-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "squareCategoryId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Category_squareCategoryId_key" ON "Category"("squareCategoryId");
