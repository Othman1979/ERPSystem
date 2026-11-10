-- ADR-003: a journal line carries its entry's branch (PostingService copies
-- it on every new entry). The branch backfills 20261109185558 and
-- 20261110091041 filled journal_entries only, so the lines of those entries
-- still have none. Fill empty line branches from their entry; nothing else
-- changes (amounts, accounts, dates and any branch already set stay as they
-- are). Same one-time rule the owner approved on 2026-11-10.

UPDATE journal_lines jl
JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
SET jl.branch_id = je.branch_id
WHERE jl.branch_id IS NULL AND je.branch_id IS NOT NULL;
