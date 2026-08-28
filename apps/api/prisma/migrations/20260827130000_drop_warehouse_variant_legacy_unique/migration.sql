-- Legacy unique on (itemGroupId, colourVariantId, sizeOptionId) collapses
-- SKUs when colour is a placeholder ("Unassigned") — the flexible attribute
-- model instead relies on warehouseSku for per-SKU identity and stores
-- colour/size as ProductAttributeValue rows joined via WarehouseVariantAttribute.

-- DropIndex
DROP INDEX "WarehouseVariant_itemGroupId_colourVariantId_sizeOptionId_key";
