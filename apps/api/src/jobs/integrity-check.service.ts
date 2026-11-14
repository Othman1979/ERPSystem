import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** One check of the report. `ok` is `count === 0`. */
export interface IntegrityCheck {
  name: string;
  ok: boolean;
  /** Offending rows (or, for the collation check, offending objects). */
  count: number;
  /** Up to 10 offending names, only when the check fails. */
  detail?: string;
}

export interface IntegrityCheckResult {
  ok: boolean;
  /** The tenant the check was limited to; null for every tenant. */
  tenantId: string | null;
  checks: IntegrityCheck[];
}

type CountRow = { n: bigint }[];

/** The collation every table and text column must use (DB-18). */
const TARGET_COLLATION = 'utf8mb4_unicode_ci';

/** Upper bound of tenant_id (BIGINT UNSIGNED), for a run over every tenant. */
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

/** Detail lines shown for a failed collation check. */
const DETAIL_LIMIT = 10;

/**
 * Integrity of the data a restore or an old migration may have broken (a job,
 * so it uses the systemPrisma client on purpose: cross-tenant by design).
 *
 * Polymorphic references (a document type plus an id, a source type plus a
 * source id) have no foreign key in the database, so nothing stops them from
 * pointing at nothing (DB-15). This job counts those orphans, and rows whose
 * party or branch reference is incomplete or missing. It also checks that the
 * database, its tables and its text columns use utf8mb4_unicode_ci (DB-18).
 *
 * Read-only: every statement is a SELECT. Run it monthly and after every restore:
 *   pnpm --filter api job:integrity-check [--tenant <id>]
 * `--tenant <id>` limits the orphan checks to one tenant (the collation check is
 * database-wide). Exit code 1 when any check fails.
 */
@Injectable()
export class IntegrityCheckService {
  constructor(private readonly prisma: PrismaService) {}

  async run(tenantId?: bigint): Promise<IntegrityCheckResult> {
    // systemPrisma: a job that reads every tenant's rows (or one, when asked).
    const db = this.prisma.client;
    // One tenant, or all of them: a range keeps the tenant_id index usable
    // (an `? IS NULL OR` filter would scan every tenant on a --tenant run).
    const lo = tenantId ?? 0n;
    const hi = tenantId ?? MAX_UNSIGNED_BIGINT;
    // A mistyped id must not pass as "clean".
    if (tenantId !== undefined && (await db.tenant.count({ where: { id: tenantId } })) === 0) {
      throw new Error(`Unknown tenant ${tenantId.toString()}`);
    }
    const checks: IntegrityCheck[] = [];
    const orphans = async (name: string, query: PromiseLike<CountRow>) => {
      checks.push(orphanCheck(name, await count(query)));
    };

    await orphans(
      'journal_lines.party_id',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM journal_lines x
        WHERE x.party_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.tenant_id = x.tenant_id AND p.id = x.party_id) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'journal_lines.party_type',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM journal_lines x
        WHERE (x.party_id IS NULL) <> (x.party_type IS NULL) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'journal_lines.branch_id',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM journal_lines x
        WHERE x.branch_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.tenant_id = x.tenant_id AND b.id = x.branch_id) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    // LEDGER-19: journal_lines.entry_date is a copy of its entry's date; the
    // statements order and page by it, so a drifted copy would misplace lines.
    await orphans(
      'journal_lines.entry_date',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM journal_lines x
        JOIN journal_entries e ON e.tenant_id = x.tenant_id AND e.id = x.journal_entry_id
        WHERE x.entry_date <> e.entry_date AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'allocations.document',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM allocations x
        WHERE NOT (
          (x.document_type = 'SALES_INVOICE' AND EXISTS (SELECT 1 FROM sales_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.document_id))
          OR (x.document_type = 'PURCHASE_INVOICE' AND EXISTS (SELECT 1 FROM purchase_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.document_id))
        ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'einvoice_submissions.document',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM einvoice_submissions x
        WHERE NOT (
          (x.document_type = 'SALES_INVOICE' AND EXISTS (SELECT 1 FROM sales_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.document_id))
          OR (x.document_type = 'SALES_RETURN' AND EXISTS (SELECT 1 FROM sales_returns d WHERE d.tenant_id = x.tenant_id AND d.id = x.document_id))
        ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    // A manual journal's source_id is its own id; an opening entry has no source.
    await orphans(
      'journal_entries.source',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM journal_entries x
        WHERE x.source_type IS NOT NULL
          AND NOT (
            (x.source_type = 'OPENING_ENTRY' AND x.source_id IS NULL)
            OR (x.source_id IS NOT NULL AND (
              (x.source_type = 'SALES_INVOICE' AND EXISTS (SELECT 1 FROM sales_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'SALES_RETURN' AND EXISTS (SELECT 1 FROM sales_returns d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'PURCHASE_INVOICE' AND EXISTS (SELECT 1 FROM purchase_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'PURCHASE_RETURN' AND EXISTS (SELECT 1 FROM purchase_returns d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'STOCK_ADJUSTMENT' AND EXISTS (SELECT 1 FROM stock_adjustments d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'STOCK_TRANSFER' AND EXISTS (SELECT 1 FROM stock_transfers d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE') AND EXISTS (SELECT 1 FROM goods_notes d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'CASH_TRANSFER' AND EXISTS (SELECT 1 FROM cash_transfers d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'RECEIPT' AND EXISTS (SELECT 1 FROM receipts d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'PAYMENT' AND EXISTS (SELECT 1 FROM payments d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'MANUAL_JOURNAL' AND EXISTS (SELECT 1 FROM journal_entries d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
            ))
          ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'stock_movements.source',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM stock_movements x
        WHERE NOT (
          (x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE') AND EXISTS (SELECT 1 FROM goods_notes d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'STOCK_ADJUSTMENT' AND EXISTS (SELECT 1 FROM stock_adjustments d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'STOCK_TRANSFER' AND EXISTS (SELECT 1 FROM stock_transfers d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'PURCHASE_INVOICE' AND EXISTS (SELECT 1 FROM purchase_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'PURCHASE_RETURN' AND EXISTS (SELECT 1 FROM purchase_returns d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'SALES_INVOICE' AND EXISTS (SELECT 1 FROM sales_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'SALES_RETURN' AND EXISTS (SELECT 1 FROM sales_returns d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          -- ADR-018: a zero-quantity write-off / revaluation keeps the source_id and
          -- source_line_id (either may be NULL) of the movement it comes with, not
          -- its document type: it is sound when that movement exists.
          OR (x.source_type = 'REVALUATION' AND EXISTS (
            SELECT 1 FROM stock_movements m
            WHERE m.tenant_id = x.tenant_id AND m.item_id = x.item_id AND m.warehouse_id = x.warehouse_id
              AND m.source_type <> 'REVALUATION'
              AND m.source_id <=> x.source_id AND m.source_line_id <=> x.source_line_id))
        ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    // A line of a reversal movement belongs to the document it reverses:
    // reversals of adjustments and transfers reference the original line
    // (reversal_of_id), so that link is accepted too.
    await orphans(
      'stock_movements.source_line',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM stock_movements x
        WHERE x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER',
                                'PURCHASE_INVOICE', 'PURCHASE_RETURN', 'SALES_INVOICE', 'SALES_RETURN')
          AND NOT (
            (x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE') AND EXISTS (
              SELECT 1 FROM goods_note_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id AND l.note_id = x.source_id))
            OR (x.source_type = 'STOCK_ADJUSTMENT' AND EXISTS (
              SELECT 1 FROM stock_adjustment_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id
                AND (l.adjustment_id = x.source_id OR EXISTS (
                  SELECT 1 FROM stock_adjustments r WHERE r.tenant_id = x.tenant_id AND r.id = x.source_id AND r.reversal_of_id = l.adjustment_id))))
            OR (x.source_type = 'STOCK_TRANSFER' AND EXISTS (
              SELECT 1 FROM stock_transfer_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id
                AND (l.transfer_id = x.source_id OR EXISTS (
                  SELECT 1 FROM stock_transfers r WHERE r.tenant_id = x.tenant_id AND r.id = x.source_id AND r.reversal_of_id = l.transfer_id))))
            OR (x.source_type = 'PURCHASE_INVOICE' AND EXISTS (
              SELECT 1 FROM purchase_invoice_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id AND l.invoice_id = x.source_id))
            OR (x.source_type = 'PURCHASE_RETURN' AND EXISTS (
              SELECT 1 FROM purchase_return_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id AND l.return_id = x.source_id))
            OR (x.source_type = 'SALES_INVOICE' AND EXISTS (
              SELECT 1 FROM sales_invoice_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id AND l.invoice_id = x.source_id))
            OR (x.source_type = 'SALES_RETURN' AND EXISTS (
              SELECT 1 FROM sales_return_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id AND l.return_id = x.source_id))
          ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );

    checks.push(await this.collation());
    return {
      ok: checks.every((c) => c.ok),
      tenantId: tenantId === undefined ? null : tenantId.toString(),
      checks,
    };
  }

  /**
   * DB-18: the database default, every table and every text column use the
   * target collation. Database-wide, so it ignores --tenant. The migrations
   * table is excluded (Prisma creates it with the database default), and so are
   * Json columns, which MariaDB keeps in utf8mb4_bin.
   */
  private async collation(): Promise<IntegrityCheck> {
    const db = this.prisma.client;
    const [schema] = await db.$queryRaw<{ collation: string }[]>`
      SELECT CAST(DEFAULT_COLLATION_NAME AS CHAR) AS collation
      FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()`;
    const tables = await db.$queryRaw<{ name: string; collation: string }[]>`
      SELECT CAST(TABLE_NAME AS CHAR) AS name, CAST(TABLE_COLLATION AS CHAR) AS collation
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations'
        AND TABLE_COLLATION <> ${TARGET_COLLATION}`;
    const columns = await db.$queryRaw<{ name: string; colName: string; collation: string }[]>`
      SELECT CAST(TABLE_NAME AS CHAR) AS name, CAST(COLUMN_NAME AS CHAR) AS colName,
             CAST(COLLATION_NAME AS CHAR) AS collation
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations'
        AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME <> ${TARGET_COLLATION}
        -- MariaDB stores a Json column as LONGTEXT utf8mb4_bin with a json_valid
        -- CHECK: binary on purpose. Only those are exempt.
        AND NOT (DATA_TYPE = 'longtext' AND COLLATION_NAME = 'utf8mb4_bin' AND EXISTS (
          SELECT 1 FROM information_schema.CHECK_CONSTRAINTS k
          WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = COLUMNS.TABLE_NAME
            AND k.CHECK_CLAUSE = CONCAT('json_valid(\`', COLUMNS.COLUMN_NAME, '\`)')))`;

    const offending: string[] = [];
    if (schema?.collation !== TARGET_COLLATION) offending.push(`database: ${schema?.collation ?? 'unknown'}`);
    for (const t of tables) offending.push(`table ${t.name}: ${t.collation}`);
    for (const c of columns) offending.push(`column ${c.name}.${c.colName}: ${c.collation}`);

    const count = offending.length;
    const shown = offending.slice(0, DETAIL_LIMIT).join('; ');
    const more = count > DETAIL_LIMIT ? ` (+${count - DETAIL_LIMIT} more)` : '';
    return {
      name: 'collation',
      ok: count === 0,
      count,
      ...(count === 0 ? {} : { detail: `${shown}${more}` }),
    };
  }
}

async function count(query: PromiseLike<CountRow>): Promise<number> {
  const [row] = await query;
  return Number(row?.n ?? 0);
}

function orphanCheck(name: string, orphans: number): IntegrityCheck {
  return { name, ok: orphans === 0, count: orphans };
}
