-- LEDGER-19 (wave 3E): covering index for the per-account sums of the trial
-- balance, income statement, balance sheet and statements. Dated reports drive
-- from journal_entries(tenant_id, company_id, status, entry_date) and read the
-- lines' account, debit and credit from this index only. Additive: no data change.
-- CreateIndex
CREATE INDEX `journal_lines_entry_cover_idx` ON `journal_lines`(`tenant_id`, `journal_entry_id`, `account_id`, `debit`, `credit`);
