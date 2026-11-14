-- Owner decision 2026-11-14 (ADR-016 §5): a return of a service-only purchase
-- invoice (no warehouse) has no warehouse either; it moves no stock and posts
-- only the financial side. Stock invoices' returns keep their invoice's
-- warehouse (enforced in PurchaseReturnsService).
-- Widening only: existing rows keep their warehouse, the composite FK
-- (tenant_id, warehouse_id) -> warehouses stays and is not checked for NULL.

-- AlterTable
ALTER TABLE `purchase_returns` MODIFY `warehouse_id` BIGINT UNSIGNED NULL;
