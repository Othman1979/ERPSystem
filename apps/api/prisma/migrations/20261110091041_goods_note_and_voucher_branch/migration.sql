-- ADR-003 (phase 6 open items): goods notes carry the branch of their
-- warehouse, and receipt / payment vouchers pass their branch to their
-- journal entries. One-time backfill of rows saved before this change.
-- It only fills empty branch_id columns: amounts, dates and statuses of
-- posted documents are untouched, and a branch already set is never
-- changed. Approved by the owner on 2026-11-10.

-- AlterTable
ALTER TABLE `goods_notes` ADD COLUMN `branch_id` BIGINT UNSIGNED NULL;

-- 1. Goods notes: the warehouse's branch ...
UPDATE goods_notes g
JOIN warehouses w ON w.tenant_id = g.tenant_id AND w.id = g.warehouse_id
SET g.branch_id = w.branch_id
WHERE g.branch_id IS NULL AND w.branch_id IS NOT NULL;

-- ... else the company's main branch (same rule as 20261109185558).
UPDATE goods_notes d
JOIN (
  SELECT tenant_id, company_id,
         COALESCE(MIN(CASE WHEN code = 'MAIN' THEN id END), MIN(id)) AS branch_id
    FROM branches
   GROUP BY tenant_id, company_id
) m ON m.tenant_id = d.tenant_id AND m.company_id = d.company_id
SET d.branch_id = m.branch_id
WHERE d.branch_id IS NULL;

-- 2. Vouchers saved before they had a branch: the company's main branch.
UPDATE receipts d
JOIN (
  SELECT tenant_id, company_id,
         COALESCE(MIN(CASE WHEN code = 'MAIN' THEN id END), MIN(id)) AS branch_id
    FROM branches
   GROUP BY tenant_id, company_id
) m ON m.tenant_id = d.tenant_id AND m.company_id = d.company_id
SET d.branch_id = m.branch_id
WHERE d.branch_id IS NULL;

UPDATE payments d
JOIN (
  SELECT tenant_id, company_id,
         COALESCE(MIN(CASE WHEN code = 'MAIN' THEN id END), MIN(id)) AS branch_id
    FROM branches
   GROUP BY tenant_id, company_id
) m ON m.tenant_id = d.tenant_id AND m.company_id = d.company_id
SET d.branch_id = m.branch_id
WHERE d.branch_id IS NULL;

-- 3. Their journal entries (and voucher reversals) that have no branch yet
--    take the document's branch.
UPDATE journal_entries je
JOIN goods_notes g ON g.tenant_id = je.tenant_id AND g.journal_entry_id = je.id
SET je.branch_id = g.branch_id
WHERE je.branch_id IS NULL;

UPDATE journal_entries je
JOIN receipts r ON r.tenant_id = je.tenant_id AND (r.journal_entry_id = je.id OR r.reversal_entry_id = je.id)
SET je.branch_id = r.branch_id
WHERE je.branch_id IS NULL;

UPDATE journal_entries je
JOIN payments p ON p.tenant_id = je.tenant_id AND (p.journal_entry_id = je.id OR p.reversal_entry_id = je.id)
SET je.branch_id = p.branch_id
WHERE je.branch_id IS NULL;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
