import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantFanoutService } from '../prisma/tenant-fanout.js';

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

export interface IsolatedIntegrityCheckRun {
  ok: boolean;
  results: IntegrityCheckResult[];
  unavailable: string[];
}

type CountRow = { n: bigint }[];

/** The collation every table and text column must use (DB-18). */
const TARGET_COLLATION = 'utf8mb4_unicode_ci';

/** Upper bound of tenant_id (BIGINT UNSIGNED), for a run over every tenant. */
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

/** Detail lines shown for a failed collation check. */
const DETAIL_LIMIT = 10;

/**
 * Integrity of the data a restore or an old migration may have broken; the
 * job checks each tenant database independently in isolated mode.
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
  // systemPrisma: it enumerates tenant databases and uses control in shared mode.
  constructor(private readonly prisma: PrismaService, private readonly fanout: TenantFanoutService) {}

  async run(tenantId?: bigint): Promise<IntegrityCheckResult | IsolatedIntegrityCheckRun> {
    if (this.prisma.tenancyMode === 'shared') return this.runDatabase(this.prisma.control(), tenantId);
    if (tenantId !== undefined) {
      const exists = await this.prisma.control().tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (!exists) throw new Error(`Unknown tenant ${tenantId.toString()}`);
    }
    const databases = await this.fanout.databases({ tenantId });
    const { unavailable } = databases;
    const results: IntegrityCheckResult[] = [];
    for (const entry of databases) {
      if (entry.tenantId !== null) results.push(await this.runDatabase(entry.client, entry.tenantId));
    }
    return {
      ok: results.every((result) => result.ok) && unavailable.length === 0,
      results,
      unavailable: unavailable.map(String),
    };
  }

  private async runDatabase(db: PrismaClient, tenantId?: bigint): Promise<IntegrityCheckResult> {
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
    // ADR-024 §1.7: journal_lines.cost_center_id has no FK; the centre must
    // exist in the same company as the line's entry.
    await orphans(
      'journal_lines.cost_center_id',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM journal_lines x
        JOIN journal_entries e ON e.tenant_id = x.tenant_id AND e.id = x.journal_entry_id
        WHERE x.cost_center_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM cost_centers c
            WHERE c.tenant_id = x.tenant_id AND c.id = x.cost_center_id AND c.company_id = e.company_id)
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
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
              OR (x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE', 'CONSIGNMENT_IN', 'CONSIGNMENT_OUT') AND EXISTS (SELECT 1 FROM goods_notes d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'CASH_TRANSFER' AND EXISTS (SELECT 1 FROM cash_transfers d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'RECEIPT' AND EXISTS (SELECT 1 FROM receipts d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'PAYMENT' AND EXISTS (SELECT 1 FROM payments d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'MANUAL_JOURNAL' AND EXISTS (SELECT 1 FROM journal_entries d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'YEAR_CLOSING' AND EXISTS (SELECT 1 FROM fiscal_year_closings d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
              OR (x.source_type = 'PRODUCTION' AND EXISTS (SELECT 1 FROM production_vouchers d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
            ))
          ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'consignment_sales.source',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM consignment_sales x
        WHERE NOT (
          (x.source_type = 'SALES_INVOICE' AND EXISTS (
            SELECT 1 FROM sales_invoice_lines l
            JOIN sales_invoices d ON d.tenant_id = l.tenant_id AND d.id = l.invoice_id
            WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id
              AND l.invoice_id = x.source_id AND d.company_id = x.company_id))
          OR (x.source_type = 'STOCK_COUNT' AND EXISTS (
            SELECT 1 FROM stock_counts c
            JOIN stock_adjustment_lines l
              ON l.tenant_id = c.tenant_id AND l.adjustment_id = c.adjustment_id
            WHERE c.tenant_id = x.tenant_id AND c.id = x.source_id
              AND c.company_id = x.company_id AND l.id = x.source_line_id))
        ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'stock_movements.source',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM stock_movements x
        WHERE NOT (
          (x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE', 'CONSIGNMENT_IN', 'CONSIGNMENT_OUT') AND EXISTS (SELECT 1 FROM goods_notes d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'STOCK_ADJUSTMENT' AND EXISTS (SELECT 1 FROM stock_adjustments d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'STOCK_TRANSFER' AND EXISTS (SELECT 1 FROM stock_transfers d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'PURCHASE_INVOICE' AND EXISTS (SELECT 1 FROM purchase_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'PURCHASE_RETURN' AND EXISTS (SELECT 1 FROM purchase_returns d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'SALES_INVOICE' AND EXISTS (SELECT 1 FROM sales_invoices d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'SALES_RETURN' AND EXISTS (SELECT 1 FROM sales_returns d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
          OR (x.source_type = 'PRODUCTION' AND EXISTS (SELECT 1 FROM production_vouchers d WHERE d.tenant_id = x.tenant_id AND d.id = x.source_id))
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
        WHERE x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE', 'CONSIGNMENT_IN', 'CONSIGNMENT_OUT', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER',
                                'PURCHASE_INVOICE', 'PURCHASE_RETURN', 'SALES_INVOICE', 'SALES_RETURN', 'PRODUCTION')
          AND NOT (
            (x.source_type IN ('GOODS_RECEIPT', 'GOODS_ISSUE', 'CONSIGNMENT_IN', 'CONSIGNMENT_OUT') AND EXISTS (
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
            -- ADR-031 §7: the output movement has no line (NULL); a material has its voucher line.
            OR (x.source_type = 'PRODUCTION' AND (x.source_line_id IS NULL OR EXISTS (
              SELECT 1 FROM production_voucher_lines l WHERE l.tenant_id = x.tenant_id AND l.id = x.source_line_id AND l.voucher_id = x.source_id)))
          ) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );

    // ADR-032 §8: a recipe component is a projection of its movement: the movement is an OUT of the same
    // item and quantity, sourced from that invoice line, and the line belongs to the invoice.
    await orphans(
      'sales_invoice_line_components.movement',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM sales_invoice_line_components c
        LEFT JOIN stock_movements m ON m.tenant_id = c.tenant_id AND m.id = c.movement_id
        WHERE (m.id IS NULL OR m.movement_type <> 'OUT' OR m.item_id <> c.component_item_id
          OR m.qty_out <> c.qty_base OR m.source_type <> 'SALES_INVOICE' OR m.source_id <> c.invoice_id
          OR m.source_line_id <> c.invoice_line_id
          OR NOT EXISTS (SELECT 1 FROM sales_invoice_lines l
            WHERE l.tenant_id = c.tenant_id AND l.id = c.invoice_line_id AND l.invoice_id = c.invoice_id))
          AND c.tenant_id BETWEEN ${lo} AND ${hi}`,
    );

    // ADR-025 §9: a request line's ordered_qty is a projection of the order
    // lines (not cancelled) that order it; it must equal their sum. Order
    // lines must also belong to the order's own request, in the same tenant.
    await orphans(
      'purchase_request_lines.ordered_qty',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM purchase_request_lines x
        WHERE x.ordered_qty <> COALESCE((SELECT SUM(ol.qty) FROM purchase_order_lines ol
            JOIN purchase_orders o ON o.tenant_id = ol.tenant_id AND o.id = ol.order_id
           WHERE ol.tenant_id = x.tenant_id AND ol.request_line_id = x.id AND o.status <> 'CANCELLED'), 0)
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'purchase_order_lines.request_line_id',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM purchase_order_lines x
        JOIN purchase_orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
        JOIN purchase_request_lines rl ON rl.tenant_id = x.tenant_id AND rl.id = x.request_line_id
        WHERE (o.request_id IS NULL OR rl.request_id <> o.request_id) AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );

    // ADR-026 §5/§7/§9: the receipt, billing and issue projections equal the
    // posted documents they add up: an order line's received_qty the posted
    // GRN lines on it; a GRN line's billed_qty and cleared_value the links of
    // posted invoices; an issue request line's issued_qty the posted GIN lines.
    // ADR-027 §4: a sales order line's invoiced_qty is never negative nor above its base quantity
    // (the invoices that bill it add up to it, checked with the invoice links in part B).
    await orphans(
      'sales_order_lines.invoiced_qty',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM sales_order_lines x
        WHERE (x.invoiced_qty < 0 OR x.invoiced_qty > x.qty_base)
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    // ADR-027 §4: an order line's invoiced quantity is what the posted invoices that bill it add up to.
    await orphans(
      'sales_order_lines.invoiced_qty (posted invoices)',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM sales_order_lines x
        WHERE x.invoiced_qty <> COALESCE((SELECT SUM(il.qty_base) FROM sales_invoice_lines il
            JOIN sales_invoices i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
           WHERE il.tenant_id = x.tenant_id AND il.order_line_id = x.id AND i.status = 'POSTED'), 0)
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'purchase_order_lines.received_qty',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM purchase_order_lines x
        WHERE (x.received_qty <> COALESCE((SELECT SUM(gl.qty) FROM goods_note_lines gl
            JOIN goods_notes g ON g.tenant_id = gl.tenant_id AND g.id = gl.note_id
           WHERE gl.tenant_id = x.tenant_id AND gl.po_line_id = x.id AND g.status = 'POSTED'), 0)
           OR x.received_qty > x.qty_base)
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'goods_note_lines.billed_qty',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM goods_note_lines x
        WHERE (x.billed_qty <> COALESCE((SELECT SUM(r.qty) FROM purchase_invoice_receipts r
            JOIN purchase_invoice_lines il ON il.tenant_id = r.tenant_id AND il.id = r.invoice_line_id
            JOIN purchase_invoices i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
           WHERE r.tenant_id = x.tenant_id AND r.grn_line_id = x.id AND i.status = 'POSTED'), 0)
           OR x.cleared_value <> COALESCE((SELECT SUM(r.cleared_value) FROM purchase_invoice_receipts r
            JOIN purchase_invoice_lines il ON il.tenant_id = r.tenant_id AND il.id = r.invoice_line_id
            JOIN purchase_invoices i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
           WHERE r.tenant_id = x.tenant_id AND r.grn_line_id = x.id AND i.status = 'POSTED'), 0)
           OR x.billed_qty > x.qty)
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    // ADR-026 §7 (review #50): what posted invoices cleared from 2104 per GRN line
    // never passes the line's received value, no link clears a negative value, and
    // a line billed in full has cleared its value exactly (2104 back to zero).
    await orphans(
      'goods_note_lines.cleared_value',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM goods_note_lines x
        WHERE x.po_line_id IS NOT NULL
          AND (x.cleared_value < 0
           OR x.cleared_value > ROUND(x.qty * COALESCE(x.unit_cost, 0), 3)
           OR (x.billed_qty = x.qty AND x.cleared_value <> ROUND(x.qty * COALESCE(x.unit_cost, 0), 3))
           OR EXISTS (SELECT 1 FROM purchase_invoice_receipts r
                       WHERE r.tenant_id = x.tenant_id AND r.grn_line_id = x.id AND r.cleared_value < 0))
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );
    await orphans(
      'issue_request_lines.issued_qty',
      db.$queryRaw<CountRow>`SELECT COUNT(*) AS n FROM issue_request_lines x
        WHERE x.issued_qty <> COALESCE((SELECT SUM(gl.qty) FROM goods_note_lines gl
            JOIN goods_notes g ON g.tenant_id = gl.tenant_id AND g.id = gl.note_id
           WHERE gl.tenant_id = x.tenant_id AND gl.issue_request_line_id = x.id AND g.status = 'POSTED'), 0)
          AND x.tenant_id BETWEEN ${lo} AND ${hi}`,
    );

    checks.push(await this.collation(db));
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
  private async collation(db: PrismaClient): Promise<IntegrityCheck> {
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
