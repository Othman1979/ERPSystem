-- Opening balances flag (§8.6, ADR-008). Reports show the lines of these
-- entries as the opening balance of a period, not as movements.
-- AlterTable
ALTER TABLE `journal_entries` ADD COLUMN `is_opening` BOOLEAN NOT NULL DEFAULT false;

-- Backfill (flag only: no amount, date, status or number changes).
-- 1. Opening entries and their reversals (a reversal keeps the source type).
UPDATE `journal_entries` SET `is_opening` = true WHERE `source_type` = 'OPENING_ENTRY';

-- 2. Entries of OPENING stock adjustments and of their reversals (a reversal
--    adjustment copies the adjustment type and points at its own entry).
UPDATE `journal_entries` je
JOIN `stock_adjustments` sa ON sa.tenant_id = je.tenant_id AND sa.journal_entry_id = je.id
SET je.is_opening = true
WHERE sa.adjustment_type = 'OPENING';
