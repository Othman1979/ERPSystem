-- ADR-003: every document belongs to a branch.
-- One-time backfill of documents saved before BranchGuard existed: set
-- branch_id to the company's main branch (code 'MAIN', created at
-- registration), falling back to the company's lowest-id branch.
-- This only fills an empty column; amounts, dates and statuses of posted
-- documents are untouched. Approved by the owner on 2026-11-09.

UPDATE sales_invoices d
JOIN (
  SELECT tenant_id, company_id,
         COALESCE(MIN(CASE WHEN code = 'MAIN' THEN id END), MIN(id)) AS branch_id
    FROM branches
   GROUP BY tenant_id, company_id
) m ON m.tenant_id = d.tenant_id AND m.company_id = d.company_id
SET d.branch_id = m.branch_id
WHERE d.branch_id IS NULL;

UPDATE purchase_invoices d
JOIN (
  SELECT tenant_id, company_id,
         COALESCE(MIN(CASE WHEN code = 'MAIN' THEN id END), MIN(id)) AS branch_id
    FROM branches
   GROUP BY tenant_id, company_id
) m ON m.tenant_id = d.tenant_id AND m.company_id = d.company_id
SET d.branch_id = m.branch_id
WHERE d.branch_id IS NULL;

UPDATE journal_entries d
JOIN (
  SELECT tenant_id, company_id,
         COALESCE(MIN(CASE WHEN code = 'MAIN' THEN id END), MIN(id)) AS branch_id
    FROM branches
   GROUP BY tenant_id, company_id
) m ON m.tenant_id = d.tenant_id AND m.company_id = d.company_id
SET d.branch_id = m.branch_id
WHERE d.branch_id IS NULL;
