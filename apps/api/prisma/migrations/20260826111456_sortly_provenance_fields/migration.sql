-- Every Sortly photo URL for this warehouse variant, in file order.
-- Default [] rather than NULL so consumers never null-check "how many
-- photos". See cli:archive-photos for the local copy that survives
-- Sortly's signed-URL expiration.
ALTER TABLE "WarehouseVariant"
  ADD COLUMN "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
