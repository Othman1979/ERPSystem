/**
 * Ledger data check (ADR-014). REPORT ONLY: it reads, prints and never writes.
 *
 *   pnpm --filter api ledger:check
 *
 * Lists existing rows that the 2026-11-13 ledger review rules now refuse, so
 * an accountant can correct them with entries (posted rows are never edited):
 *   1. duplicate reversals: an entry reversed twice (LEDGER-02). The migration
 *      20261113163739_journal_reversal_unique fails while any exist, so run
 *      this BEFORE `prisma migrate deploy`. Exit code 1 when found.
 *   2. a party on a line whose account is not a customers/suppliers control
 *      account (LEDGER-06, decision D-2);
 *   3. template accounts whose nature differs from §8.7 (LEDGER-26: 1202 is a
 *      credit, 4102 and 4103 are debits);
 *   4. account mappings that the new type rules refuse (LEDGER-05);
 *   5. opening entries not dated on their fiscal year's start (LEDGER-16, D-3).
 *
 * Runs across every tenant with one connection from DATABASE_URL: an
 * operator's tool, like the jobs, so each query groups or filters by
 * tenant_id explicitly instead of going through tenantScopedPrisma.
 */
import 'dotenv/config';
import mariadb from 'mariadb';
import { CHART_TEMPLATE, MAPPING_RULES, type AccountMappingKey } from '../src/platform/accounting/chart-template.js';

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const conn = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    bigIntAsNumber: false,
  });
  const report: Record<string, Row[]> = {};
  try {
    report.duplicateReversals = await conn.query(`
      SELECT tenant_id, reversal_of_id, COUNT(*) AS reversals, GROUP_CONCAT(entry_no ORDER BY id) AS entry_nos
      FROM journal_entries
      WHERE reversal_of_id IS NOT NULL
      GROUP BY tenant_id, reversal_of_id
      HAVING COUNT(*) > 1`);

    report.partyOnNonControlAccount = await conn.query(`
      SELECT jl.tenant_id, je.id AS entry_id, je.entry_no, je.status, jl.line_no, a.code AS account_code,
             jl.party_type, jl.party_id, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
      JOIN accounts a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
      WHERE (jl.party_id IS NOT NULL OR jl.party_type IS NOT NULL)
        AND a.is_control = 0
        AND (a.control_type IS NULL OR a.control_type NOT IN ('CUSTOMERS', 'SUPPLIERS'))
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.company_id = a.company_id AND m.account_id = a.id
            AND m.mapping_key IN ('CUSTOMERS_CONTROL', 'SUPPLIERS_CONTROL'))
      ORDER BY jl.tenant_id, je.entry_date, je.id, jl.line_no`);

    const contra = CHART_TEMPLATE.filter(
      (t) => t.normalBalance !== (t.accountType === 'ASSET' || t.accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT'),
    );
    report.templateNatureDiffers = [];
    for (const t of contra) {
      report.templateNatureDiffers.push(
        ...((await conn.query(
          `SELECT tenant_id, company_id, id AS account_id, code, name_ar, normal_balance, ? AS template_nature
           FROM accounts WHERE code = ? AND name_ar = ? AND normal_balance <> ?`,
          [t.normalBalance, t.code, t.nameAr, t.normalBalance],
        )) as Row[]),
      );
    }

    const mappings = (await conn.query(`
      SELECT m.tenant_id, m.company_id, m.mapping_key, a.code AS account_code, a.account_type, a.control_type, a.is_control
      FROM account_mappings m
      JOIN accounts a ON a.tenant_id = m.tenant_id AND a.company_id = m.company_id AND a.id = m.account_id
      ORDER BY m.tenant_id, m.mapping_key`)) as Row[];
    report.mappingBreaksRules = mappings.filter((m) => {
      const rule = MAPPING_RULES[m.mapping_key as AccountMappingKey];
      if (!rule) return false;
      if (!rule.types.includes(m.account_type as never)) return true;
      if (rule.controlType) return m.control_type !== rule.controlType;
      return Boolean(m.is_control) || m.control_type !== null;
    });

    report.openingNotOnYearStart = await conn.query(`
      SELECT je.tenant_id, je.id AS entry_id, je.entry_no, je.entry_date, fy.code AS fiscal_year, fy.start_date
      FROM journal_entries je
      JOIN fiscal_years fy ON fy.tenant_id = je.tenant_id AND fy.company_id = je.company_id
        AND je.entry_date BETWEEN fy.start_date AND fy.end_date
      WHERE je.source_type = 'OPENING_ENTRY' AND je.posting_kind = 'POST' AND je.status = 'POSTED'
        AND je.entry_date <> fy.start_date
      ORDER BY je.tenant_id, je.entry_date`);
  } finally {
    await conn.end();
  }

  const json = (v: unknown) =>
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Date ? x.toISOString().slice(0, 10) : x), 2);
  const summary = Object.fromEntries(Object.entries(report).map(([k, rows]) => [k, rows.length]));
  console.log(json({ job: 'ledger-check', readOnly: true, summary, report }));
  // Only duplicate reversals block anything (the unique index migration).
  if (report.duplicateReversals.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
