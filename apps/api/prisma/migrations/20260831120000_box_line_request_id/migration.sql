-- BoxLine.requestId: makes a Box able to fulfil multiple RestockRequests
-- (one physical box, one QR label). Previously Box.requestId carried the
-- 1:1 relationship. That column is kept in place for the common single-
-- request case and for backwards compat; new multi-request boxes leave
-- Box.requestId NULL and record the mapping per line here.

ALTER TABLE "BoxLine" ADD COLUMN "requestId" TEXT;

-- Backfill so every existing BoxLine points at the same request its Box
-- pointed at. Multi-request boxes did not exist before this migration,
-- so no line-vs-box mismatch is possible.
UPDATE "BoxLine" bl
SET    "requestId" = b."requestId"
FROM   "Box" b
WHERE  bl."boxId" = b.id
  AND  b."requestId" IS NOT NULL;

-- RESTRICT (not the Prisma default SET NULL) — see the same comment on
-- RestockRequestLine.warehouseVariantId. A ledger-anchored RestockRequest
-- must not be silently deletable, and SET NULL fires the append-only
-- trigger via UPDATE which raises for reasons unrelated to intent.
ALTER TABLE "BoxLine"
  ADD CONSTRAINT "BoxLine_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "RestockRequest"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "BoxLine_requestId_idx" ON "BoxLine"("requestId");
