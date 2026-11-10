-- ADR-007: mark opening balances so reports show them as the opening
-- position (أول المدة) even when they fall inside the report's date range.
-- Adds two flags with default 0, then marks what already is an opening
-- balance: opening entries, opening stock adjustments and their reversals —
-- only those dated on the first day of the company's first fiscal year (an
-- opening document dated later is ordinary movement of its period).
-- No amount, account, date or status changes.

ALTER TABLE `journal_entries` ADD COLUMN `is_opening` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `stock_movements` ADD COLUMN `is_opening` BOOLEAN NOT NULL DEFAULT false;

-- Opening entries (POST and REVERSAL keep the same source type).
UPDATE journal_entries je
JOIN (SELECT tenant_id, company_id, MIN(start_date) AS opening_date
      FROM fiscal_years GROUP BY tenant_id, company_id) fy
  ON fy.tenant_id = je.tenant_id AND fy.company_id = je.company_id
SET je.is_opening = true
WHERE je.source_type = 'OPENING_ENTRY' AND je.entry_date = fy.opening_date;

-- Journal entries of opening stock adjustments; a reversal adjustment keeps
-- the OPENING type and points at its own reversal entry.
UPDATE journal_entries je
JOIN stock_adjustments sa ON sa.tenant_id = je.tenant_id AND sa.journal_entry_id = je.id
JOIN (SELECT tenant_id, company_id, MIN(start_date) AS opening_date
      FROM fiscal_years GROUP BY tenant_id, company_id) fy
  ON fy.tenant_id = je.tenant_id AND fy.company_id = je.company_id
SET je.is_opening = true
WHERE sa.adjustment_type = 'OPENING' AND je.entry_date = fy.opening_date;

-- Stock movements of the same adjustments.
UPDATE stock_movements sm
JOIN stock_adjustments sa ON sa.tenant_id = sm.tenant_id AND sa.id = sm.source_id
JOIN (SELECT tenant_id, company_id, MIN(start_date) AS opening_date
      FROM fiscal_years GROUP BY tenant_id, company_id) fy
  ON fy.tenant_id = sm.tenant_id AND fy.company_id = sm.company_id
SET sm.is_opening = true
WHERE sm.source_type = 'STOCK_ADJUSTMENT' AND sa.adjustment_type = 'OPENING'
  AND sm.movement_date = fy.opening_date;
