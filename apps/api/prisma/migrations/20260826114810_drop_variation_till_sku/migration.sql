-- Drop `Variation.tillSku` and its unique index. Till-facing SKUs are
-- now derived on the fly by `catalog-plan.ts` when a Square catalog
-- push is prepared, rather than stored per row. See NewVariationPlan.sku
-- in catalog-plan.ts for the replacement derivation.
DROP INDEX IF EXISTS "Variation_tillSku_key";
ALTER TABLE "Variation" DROP COLUMN IF EXISTS "tillSku";
