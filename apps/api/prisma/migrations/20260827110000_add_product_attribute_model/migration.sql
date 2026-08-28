-- CreateTable
CREATE TABLE "ProductAttribute" (
    "id" TEXT NOT NULL,
    "itemGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAttributeValue" (
    "id" TEXT NOT NULL,
    "productAttributeId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductAttributeValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseVariantAttribute" (
    "warehouseVariantId" TEXT NOT NULL,
    "productAttributeValueId" TEXT NOT NULL,

    CONSTRAINT "WarehouseVariantAttribute_pkey" PRIMARY KEY ("warehouseVariantId","productAttributeValueId")
);

-- CreateIndex
CREATE INDEX "ProductAttribute_itemGroupId_idx" ON "ProductAttribute"("itemGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAttribute_itemGroupId_name_key" ON "ProductAttribute"("itemGroupId", "name");

-- CreateIndex
CREATE INDEX "ProductAttributeValue_productAttributeId_idx" ON "ProductAttributeValue"("productAttributeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAttributeValue_productAttributeId_value_key" ON "ProductAttributeValue"("productAttributeId", "value");

-- CreateIndex
CREATE INDEX "WarehouseVariantAttribute_productAttributeValueId_idx" ON "WarehouseVariantAttribute"("productAttributeValueId");

-- AddForeignKey
ALTER TABLE "ProductAttribute" ADD CONSTRAINT "ProductAttribute_itemGroupId_fkey" FOREIGN KEY ("itemGroupId") REFERENCES "ItemGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAttributeValue" ADD CONSTRAINT "ProductAttributeValue_productAttributeId_fkey" FOREIGN KEY ("productAttributeId") REFERENCES "ProductAttribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseVariantAttribute" ADD CONSTRAINT "WarehouseVariantAttribute_warehouseVariantId_fkey" FOREIGN KEY ("warehouseVariantId") REFERENCES "WarehouseVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseVariantAttribute" ADD CONSTRAINT "WarehouseVariantAttribute_productAttributeValueId_fkey" FOREIGN KEY ("productAttributeValueId") REFERENCES "ProductAttributeValue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
