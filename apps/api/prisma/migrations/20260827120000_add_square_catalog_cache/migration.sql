-- CreateTable
CREATE TABLE "SquareCatalogItem" (
    "squareItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryName" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquareCatalogItem_pkey" PRIMARY KEY ("squareItemId")
);

-- CreateTable
CREATE TABLE "SquareCatalogVariation" (
    "squareVariationId" TEXT NOT NULL,
    "squareItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquareCatalogVariation_pkey" PRIMARY KEY ("squareVariationId")
);

-- CreateIndex
CREATE INDEX "SquareCatalogItem_name_idx" ON "SquareCatalogItem"("name");

-- CreateIndex
CREATE INDEX "SquareCatalogVariation_squareItemId_idx" ON "SquareCatalogVariation"("squareItemId");

-- CreateIndex
CREATE INDEX "SquareCatalogVariation_name_idx" ON "SquareCatalogVariation"("name");

-- AddForeignKey
ALTER TABLE "SquareCatalogVariation" ADD CONSTRAINT "SquareCatalogVariation_squareItemId_fkey" FOREIGN KEY ("squareItemId") REFERENCES "SquareCatalogItem"("squareItemId") ON DELETE CASCADE ON UPDATE CASCADE;
