-- Wave 3E review (LEDGER-19, ADR-022 §4; S1). Generated with `prisma migrate dev
-- --create-only`, then split so it runs on a table that already has rows:
-- add the column NULL, backfill it, then make it NOT NULL.
-- No amount, status or date changes; branch_id is filled only where it is NULL.
-- Deployment: run in the maintenance window (docs/runbooks/deploy.md, wave 3E).

-- 1. journal_lines.entry_date: a copy of the entry's date (posted lines never
--    change, a draft's date is fixed at creation). INSTANT on MariaDB 10.11+.
-- AlterTable
ALTER TABLE `journal_lines` ADD COLUMN `entry_date` DATE NULL;

-- Backfill: one statement, row locks on every journal line until it commits.
UPDATE `journal_lines` l
  JOIN `journal_entries` e ON e.`tenant_id` = l.`tenant_id` AND e.`id` = l.`journal_entry_id`
   SET l.`entry_date` = e.`entry_date`
 WHERE l.`entry_date` IS NULL;

-- NULL -> NOT NULL rebuilds the table in place (concurrent DML allowed).
ALTER TABLE `journal_lines` MODIFY `entry_date` DATE NOT NULL;

-- 2. Statement pages seek in statement order (entry date, entry id, line no).
-- CreateIndex
CREATE INDEX `journal_lines_account_seek_idx` ON `journal_lines`(`tenant_id`, `account_id`, `entry_date`, `journal_entry_id`, `line_no`);

-- CreateIndex
CREATE INDEX `journal_lines_party_seek_idx` ON `journal_lines`(`tenant_id`, `party_type`, `party_id`, `entry_date`, `journal_entry_id`, `line_no`);

-- 3. S1: stock adjustment (and stock count) entries were posted without a
--    branch. Give them their warehouse's branch, entry and lines, where the
--    branch is still NULL (ADR-003: an existing branch is never changed).
--    These rows are POSTED: this is a one-time exception to "no update on
--    POSTED", approved by the owner on 2026-11-14 and recorded in ADR-003 §17.
--    Only a missing branch_id is filled; amounts, dates, accounts and statuses
--    are untouched. Not a precedent.
UPDATE `journal_entries` e
  JOIN `stock_adjustments` a ON a.`tenant_id` = e.`tenant_id` AND a.`id` = e.`source_id`
  JOIN `warehouses` w ON w.`tenant_id` = a.`tenant_id` AND w.`id` = a.`warehouse_id`
   SET e.`branch_id` = w.`branch_id`
 WHERE e.`source_type` = 'STOCK_ADJUSTMENT' AND e.`branch_id` IS NULL AND w.`branch_id` IS NOT NULL;
UPDATE `journal_lines` l
  JOIN `journal_entries` e ON e.`tenant_id` = l.`tenant_id` AND e.`id` = l.`journal_entry_id`
   SET l.`branch_id` = e.`branch_id`
 WHERE e.`source_type` = 'STOCK_ADJUSTMENT' AND l.`branch_id` IS NULL AND e.`branch_id` IS NOT NULL;
