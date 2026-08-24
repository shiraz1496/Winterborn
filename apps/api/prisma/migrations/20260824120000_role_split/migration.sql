-- Split WAREHOUSE role into manager/operator tiers, add sales-only role.
-- Doc 3 §3.6.
--
-- Rename WAREHOUSE -> WAREHOUSE_MANAGER (keeps every permission the old
-- WAREHOUSE role had: create shipments, adjust stock, approve requests).
-- Rename OPERATOR -> WAREHOUSE_OPERATOR (receive, pack; catalog is now off
-- limits at the role level). Add SALES for staff who only need Square,
-- never the app.
--
-- This file records history; the change was applied by an earlier
-- environment on a shared docker volume and is already present in the
-- target database.

ALTER TYPE "UserRole" RENAME VALUE 'WAREHOUSE' TO 'WAREHOUSE_MANAGER';
ALTER TYPE "UserRole" RENAME VALUE 'OPERATOR' TO 'WAREHOUSE_OPERATOR';
ALTER TYPE "UserRole" ADD VALUE 'SALES';
