-- Category becomes a self-nesting folder tree (Sortly-style).
-- Drop the flat `name` uniqueness, add `parentId` FK to self, and enforce
-- uniqueness per parent so the same name can exist under different
-- branches (e.g. two "Scarves" folders under different regions).

ALTER TABLE "Category" DROP CONSTRAINT IF EXISTS "Category_name_key";
DROP INDEX IF EXISTS "Category_name_key";

ALTER TABLE "Category" ADD COLUMN "parentId" TEXT;

ALTER TABLE "Category"
  ADD CONSTRAINT "Category_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Category"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Category_parentId_name_key" ON "Category"("parentId", "name");
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");
