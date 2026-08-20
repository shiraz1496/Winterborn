-- CreateEnum
CREATE TYPE "Brand" AS ENUM ('OWN', 'FRAAS');

-- CreateEnum
CREATE TYPE "FamilyAssignmentSource" AS ENUM ('LEXICAL', 'SYNONYM', 'VISUAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('MARKET', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "LedgerEventType" AS ENUM ('INTAKE', 'DISPATCH', 'SALE', 'WRITE_OFF', 'RETURN', 'CORRECTION');

-- CreateEnum
CREATE TYPE "LedgerSource" AS ENUM ('WEBHOOK', 'POLL', 'UI', 'SCRIPT');

-- CreateEnum
CREATE TYPE "WriteOffReason" AS ENUM ('DAMAGE', 'GIFT', 'SAMPLE');

-- CreateEnum
CREATE TYPE "RequestState" AS ENUM ('DRAFT', 'OPEN', 'PACKING', 'DISPATCHED', 'ARRIVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RequestOrigin" AS ENUM ('THRESHOLD', 'REVIEW', 'MANUAL');

-- CreateEnum
CREATE TYPE "BoxState" AS ENUM ('PACKING', 'DISPATCHED', 'ARRIVED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ThresholdSource" AS ENUM ('SEEDED', 'MANUAL');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'WAREHOUSE', 'MARKET_MANAGER', 'OPERATOR');

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortlyFolder" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemGroup" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "squareItemId" TEXT,
    "brand" "Brand" NOT NULL DEFAULT 'OWN',

    CONSTRAINT "ItemGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColourFamily" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ColourFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColourVariant" (
    "id" TEXT NOT NULL,
    "colourFamilyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortlyName" TEXT,
    "normalisedName" TEXT NOT NULL,
    "photoUrl" TEXT,
    "familyAssignmentSource" "FamilyAssignmentSource" NOT NULL,
    "familyConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "ColourVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeOption" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SizeOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variation" (
    "id" TEXT NOT NULL,
    "itemGroupId" TEXT NOT NULL,
    "colourFamilyId" TEXT NOT NULL,
    "sizeOptionId" TEXT NOT NULL,
    "squareVariationId" TEXT,
    "tillSku" TEXT NOT NULL,
    "isSellable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Variation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseVariant" (
    "id" TEXT NOT NULL,
    "itemGroupId" TEXT NOT NULL,
    "colourVariantId" TEXT NOT NULL,
    "sizeOptionId" TEXT NOT NULL,
    "variationId" TEXT NOT NULL,
    "warehouseSku" TEXT NOT NULL,
    "unitCostCents" INTEGER,
    "isSaleItem" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WarehouseVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "squareLocationId" TEXT,
    "timezone" TEXT NOT NULL,
    "seasonStart" TIMESTAMP(3),
    "seasonEnd" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEvent" (
    "id" TEXT NOT NULL,
    "type" "LedgerEventType" NOT NULL,
    "locationId" TEXT NOT NULL,
    "variationId" TEXT NOT NULL,
    "warehouseVariantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "LedgerSource" NOT NULL,
    "sourceRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "actorId" TEXT,
    "transferId" TEXT,
    "reason" "WriteOffReason",
    "note" TEXT,

    CONSTRAINT "LedgerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestockRequest" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "state" "RequestState" NOT NULL DEFAULT 'DRAFT',
    "createdFrom" "RequestOrigin" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "RestockRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestockRequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "variationId" TEXT NOT NULL,
    "warehouseVariantId" TEXT,
    "qtyRequested" INTEGER NOT NULL,

    CONSTRAINT "RestockRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Box" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "destinationLocationId" TEXT NOT NULL,
    "state" "BoxState" NOT NULL DEFAULT 'PACKING',
    "qrToken" TEXT NOT NULL,
    "packedById" TEXT,
    "packedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),

    CONSTRAINT "Box_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoxLine" (
    "id" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "warehouseVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "BoxLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Load" (
    "id" TEXT NOT NULL,
    "vehicleLabel" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "Load_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoadBox" (
    "loadId" TEXT NOT NULL,
    "boxId" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoadBox_pkey" PRIMARY KEY ("loadId","boxId")
);

-- CreateTable
CREATE TABLE "Threshold" (
    "id" TEXT NOT NULL,
    "variationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "minLevel" INTEGER NOT NULL,
    "source" "ThresholdSource" NOT NULL DEFAULT 'SEEDED',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Threshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquareInboxEvent" (
    "id" TEXT NOT NULL,
    "squareEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "SquareInboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquareSyncCursor" (
    "locationId" TEXT NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "cursor" TEXT,

    CONSTRAINT "SquareSyncCursor_pkey" PRIMARY KEY ("locationId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLinkToken" (
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ItemGroup_squareItemId_key" ON "ItemGroup"("squareItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemGroup_categoryId_name_key" ON "ItemGroup"("categoryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ColourFamily_categoryId_name_key" ON "ColourFamily"("categoryId", "name");

-- CreateIndex
CREATE INDEX "ColourVariant_normalisedName_idx" ON "ColourVariant"("normalisedName");

-- CreateIndex
CREATE UNIQUE INDEX "ColourVariant_colourFamilyId_name_key" ON "ColourVariant"("colourFamilyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SizeOption_categoryId_name_key" ON "SizeOption"("categoryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Variation_squareVariationId_key" ON "Variation"("squareVariationId");

-- CreateIndex
CREATE UNIQUE INDEX "Variation_tillSku_key" ON "Variation"("tillSku");

-- CreateIndex
CREATE UNIQUE INDEX "Variation_itemGroupId_colourFamilyId_sizeOptionId_key" ON "Variation"("itemGroupId", "colourFamilyId", "sizeOptionId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseVariant_warehouseSku_key" ON "WarehouseVariant"("warehouseSku");

-- CreateIndex
CREATE INDEX "WarehouseVariant_variationId_idx" ON "WarehouseVariant"("variationId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseVariant_itemGroupId_colourVariantId_sizeOptionId_key" ON "WarehouseVariant"("itemGroupId", "colourVariantId", "sizeOptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Location_name_key" ON "Location"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Location_squareLocationId_key" ON "Location"("squareLocationId");

-- CreateIndex
CREATE INDEX "Location_kind_idx" ON "Location"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEvent_idempotencyKey_key" ON "LedgerEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEvent_variationId_locationId_idx" ON "LedgerEvent"("variationId", "locationId");

-- CreateIndex
CREATE INDEX "LedgerEvent_warehouseVariantId_locationId_idx" ON "LedgerEvent"("warehouseVariantId", "locationId");

-- CreateIndex
CREATE INDEX "LedgerEvent_locationId_occurredAt_idx" ON "LedgerEvent"("locationId", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerEvent_transferId_idx" ON "LedgerEvent"("transferId");

-- CreateIndex
CREATE INDEX "RestockRequest_locationId_state_idx" ON "RestockRequest"("locationId", "state");

-- CreateIndex
CREATE INDEX "RestockRequestLine_requestId_idx" ON "RestockRequestLine"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Box_qrToken_key" ON "Box"("qrToken");

-- CreateIndex
CREATE INDEX "Box_destinationLocationId_state_idx" ON "Box"("destinationLocationId", "state");

-- CreateIndex
CREATE INDEX "BoxLine_boxId_idx" ON "BoxLine"("boxId");

-- CreateIndex
CREATE UNIQUE INDEX "Threshold_variationId_locationId_key" ON "Threshold"("variationId", "locationId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "SquareInboxEvent_squareEventId_key" ON "SquareInboxEvent"("squareEventId");

-- CreateIndex
CREATE INDEX "SquareInboxEvent_processedAt_idx" ON "SquareInboxEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "MagicLinkToken_email_idx" ON "MagicLinkToken"("email");

-- AddForeignKey
ALTER TABLE "ItemGroup" ADD CONSTRAINT "ItemGroup_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColourFamily" ADD CONSTRAINT "ColourFamily_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ColourVariant" ADD CONSTRAINT "ColourVariant_colourFamilyId_fkey" FOREIGN KEY ("colourFamilyId") REFERENCES "ColourFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SizeOption" ADD CONSTRAINT "SizeOption_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variation" ADD CONSTRAINT "Variation_itemGroupId_fkey" FOREIGN KEY ("itemGroupId") REFERENCES "ItemGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variation" ADD CONSTRAINT "Variation_colourFamilyId_fkey" FOREIGN KEY ("colourFamilyId") REFERENCES "ColourFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variation" ADD CONSTRAINT "Variation_sizeOptionId_fkey" FOREIGN KEY ("sizeOptionId") REFERENCES "SizeOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseVariant" ADD CONSTRAINT "WarehouseVariant_itemGroupId_fkey" FOREIGN KEY ("itemGroupId") REFERENCES "ItemGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseVariant" ADD CONSTRAINT "WarehouseVariant_colourVariantId_fkey" FOREIGN KEY ("colourVariantId") REFERENCES "ColourVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseVariant" ADD CONSTRAINT "WarehouseVariant_sizeOptionId_fkey" FOREIGN KEY ("sizeOptionId") REFERENCES "SizeOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseVariant" ADD CONSTRAINT "WarehouseVariant_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "Variation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockRequest" ADD CONSTRAINT "RestockRequest_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockRequestLine" ADD CONSTRAINT "RestockRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RestockRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockRequestLine" ADD CONSTRAINT "RestockRequestLine_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "Variation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockRequestLine" ADD CONSTRAINT "RestockRequestLine_warehouseVariantId_fkey" FOREIGN KEY ("warehouseVariantId") REFERENCES "WarehouseVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Box" ADD CONSTRAINT "Box_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RestockRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Box" ADD CONSTRAINT "Box_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxLine" ADD CONSTRAINT "BoxLine_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxLine" ADD CONSTRAINT "BoxLine_warehouseVariantId_fkey" FOREIGN KEY ("warehouseVariantId") REFERENCES "WarehouseVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Load" ADD CONSTRAINT "Load_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadBox" ADD CONSTRAINT "LoadBox_loadId_fkey" FOREIGN KEY ("loadId") REFERENCES "Load"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoadBox" ADD CONSTRAINT "LoadBox_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Threshold" ADD CONSTRAINT "Threshold_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "Variation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Threshold" ADD CONSTRAINT "Threshold_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquareSyncCursor" ADD CONSTRAINT "SquareSyncCursor_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
