-- CreateEnum
CREATE TYPE "AuditSource" AS ENUM ('UI', 'API', 'CLI', 'MIGRATION', 'WEBHOOK', 'SYSTEM');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorRole" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "source" "AuditSource" NOT NULL DEFAULT 'SYSTEM';

-- CreateIndex
CREATE INDEX "AuditLog_actorId_at_idx" ON "AuditLog"("actorId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
