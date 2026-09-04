-- squareImageId is NOT a 1:1 mapping the way squareVariationId/squareCategoryId
-- are: Square's CatalogImage objects are shareable, and Square can (confirmed
-- live, sandbox) return the SAME image id for two separate uploads to two
-- different catalog objects. A hard unique constraint here was a wrong
-- assumption and broke the sync the moment that happened.
DROP INDEX "Category_squareImageId_key";
DROP INDEX "ItemGroup_squareImageId_key";
DROP INDEX "WarehouseVariant_squareImageId_key";
