import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal, round3, round6, sum } from '../../common/decimal/decimal.utils.js';
import {
  assertBranchAllowed,
  assertWarehouseBranchAllowed,
  branchSql,
  branchWhere,
  currentBranchId,
} from '../../common/branch/branch-context.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { PlanLimitsService } from '../../common/plan-limits/plan-limits.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import {
  dayKey,
  foldMonths,
  itemRefs,
  partyRefs,
  summaryRow,
  taxRows,
  type DocumentSummaryRow,
  type SummaryGroupBy,
  type SummaryRange,
} from '../shared/document-summary.js';
import { allocateInvoiceDiscount, computeLineAmounts } from '../shared/invoice-math.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';
import {
  creditedByInvoice,
  chunks,
  IN_LIST_CHUNK,
  owedAsOf,
  withBalance,
  type OpenInvoiceAsOf,
  type OpenInvoiceRow,
} from '../shared/invoice-balance.js';
import {
  lockOrder,
  toSettlementState,
  type InvoiceSettlement,
  type SettlementRow,
  type SettlementState,
} from '../shared/invoice-settlement.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { assertCanApprove, isAuthor, readApprover } from '../../common/procurement/approval.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { lockCompanySales, lockOrderLines, lockSalesOrder, type LockedOrderLine } from './sales-cycle.locks.js';
import { reservedByItem } from './sales-cycle.reservation.js';
import {
  addDays,
  availableQty,
  leftToInvoice,
  neededPerItem,
  pricedBelowOrder,
  unitQtyFloor,
} from './sales-cycle.rules.js';
import type { CreateInvoiceFromOrderDto } from './dto/sales-cycle.dto.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { EInvoiceOutboxService } from '../einvoice/einvoice-outbox.service.js';
import type {
  CreateSalesInvoiceDto,
  ListSalesInvoicesQueryDto,
  PreviewSalesInvoiceDto,
  SalesInvoiceLineDto,
} from './dto/sales.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { CostCenterUsageRegistry } from '../cost-centers/cost-center-usage.registry.js';
import { isRecipe, ItemKindValue } from '../../common/inventory/item-kind.js';
import { BomService, type StockExplosion } from '../manufacturing/bom.service.js';
import { YearClosingDraftRegistry, yearClosingDraft, yearClosingDraftText } from '../accounting/year-closing-draft.registry.js';

const SOURCE = 'SALES_INVOICE';

interface ResolvedLine {
  dto: SalesInvoiceLineDto;
  itemId: bigint;
  itemUnitId: bigint | null;
  factorToBase: Decimal;
  itemKind: ItemKindValue;
  taxRate: Decimal;
  taxCategoryId: bigint | null;
  invoiceDiscountShare: Decimal;
  amounts: ReturnType<typeof computeLineAmounts>;
}

/** The order statuses that take invoices (ADR-027 §4): a confirmed or partly invoiced order. */
export const INVOICEABLE_ORDER_STATUSES: readonly string[] = ['CONFIRMED', 'PARTIALLY_INVOICED'];

/** One line of an invoice as the order check reads it (draft lines and resolved lines both map to this). */
interface BillingLine {
  lineNo: number;
  orderLineId: bigint | null;
  itemId: bigint;
  qtyBase: Decimal;
}

/**
 * ADR-027 §4 on the locked order lines: every line of an invoice made from an
 * order bills one line of that order, of the same item, and the base quantity
 * billed on an order line never exceeds what is left on it. Returns what this
 * invoice bills per order line. Refusals name the line, never a number of the
 * company (the figures are the order's own).
 */
export function billedPerOrderLine(orderLines: Map<bigint, LockedOrderLine>, lines: BillingLine[]): Map<bigint, Decimal> {
  const billed = new Map<bigint, Decimal>();
  for (const l of lines) {
    if (l.orderLineId === null) {
      throw new DomainError(ErrorCode.VALIDATION, 'An invoice made from a sales order bills order lines only', { lineNo: l.lineNo });
    }
    const ol = orderLines.get(l.orderLineId);
    if (!ol) {
      throw new DomainError(ErrorCode.VALIDATION, 'A line is not a line of this sales order', {
        lineNo: l.lineNo,
        orderLineId: l.orderLineId.toString(),
      });
    }
    if (ol.itemId !== l.itemId) {
      throw new DomainError(ErrorCode.VALIDATION, 'A line bills another item than its sales order line', {
        lineNo: l.lineNo,
        orderLineId: l.orderLineId.toString(),
      });
    }
    billed.set(ol.id, (billed.get(ol.id) ?? new Decimal(0)).plus(l.qtyBase));
  }
  for (const [olId, qty] of billed) {
    const ol = orderLines.get(olId)!;
    const remaining = leftToInvoice(ol.qtyBase, ol.invoicedQty);
    if (qty.gt(remaining)) {
      throw new DomainError(ErrorCode.SALES_ORDER_OVER_INVOICED, 'The invoice bills more than is left on the sales order line', {
        orderLineId: olId.toString(),
        remaining: remaining.toFixed(6),
        wanted: qty.toFixed(6),
      });
    }
  }
  return billed;
}

/** Refuses an order that takes no invoice (ADR-027 §3–§4): draft, pending, cancelled or closed. */
export function assertOrderInvoiceable(status: string): void {
  if (!INVOICEABLE_ORDER_STATUSES.includes(status)) {
    throw new DomainError(ErrorCode.SALES_ORDER_NOT_INVOICEABLE, 'The sales order takes no invoice in its status', { status });
  }
}

/** A posted-to-be draft line as the post reads it (Prisma values, read under the invoice lock). */
interface PostedDraftLine {
  lineNo: number;
  orderLineId: bigint | null;
  itemId: bigint;
  qty: { toString(): string };
  qtyBase: { toString(): string };
  unitPrice: { toString(): string };
  discountPct: { toString(): string };
  invoiceDiscountShare: { toString(): string };
}

/** An invoice's order billing, locked and checked (ADR-027 §4): the order, its lines, what this invoice bills per line. */
interface BilledOrder {
  orderId: bigint;
  lines: LockedOrderLine[];
  billed: Map<bigint, Decimal>;
}

/** A direct invoice (no order) names no order line (ADR-027 §4). */
function assertDirectLines(dtos: SalesInvoiceLineDto[]): void {
  if (dtos.some((l) => l.orderLineId !== undefined)) {
    throw new DomainError(ErrorCode.VALIDATION, 'Order lines are billed only by an invoice made from a sales order', {
      field: 'lines.orderLineId',
    });
  }
}

/** Sales invoices: draft CRUD + post → stock OUT + COGS/revenue journal (§8.4). */
@Injectable()
export class SalesInvoicesService implements OnModuleInit, InvoiceSettlement {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly einvoice: EInvoiceOutboxService,
    private readonly limits: PlanLimitsService,
    private readonly partyUsage: PartyUsageRegistry,
    private readonly costCenters: CostCentersService,
    private readonly costCenterUsage: CostCenterUsageRegistry,
    private readonly bom: BomService,
    private readonly yearClosingDrafts: YearClosingDraftRegistry,
  ) {}

  onModuleInit(): void {
    this.partyUsage.register('sales', (tx, partyId) => this.partyInUse(tx, partyId));
    this.costCenterUsage.register('sales', (tx, id) => this.costCenterInUse(tx, id));
    this.yearClosingDrafts.register('SALES_INVOICE', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.salesInvoice.findMany({
        where: { tenantId, companyId, status: 'DRAFT', invoiceDate: { gte: from, lte: to } },
        select: { id: true, invoiceDate: true, invoiceNo: true, description: true, customer: { select: { nameAr: true } } },
      });
      return rows.map((row) => yearClosingDraft(
        'SALES_INVOICE',
        row.id,
        row.invoiceDate,
        row.invoiceNo,
        yearClosingDraftText(row.description, row.customer.nameAr),
      ));
    });
    this.yearClosingDrafts.register('SALES_RETURN', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.salesReturn.findMany({
        where: { tenantId, companyId, status: 'DRAFT', returnDate: { gte: from, lte: to } },
        select: { id: true, returnDate: true, returnNo: true, reason: true, customer: { select: { nameAr: true } } },
      });
      return rows.map((row) => yearClosingDraft(
        'SALES_RETURN',
        row.id,
        row.returnDate,
        row.returnNo,
        yearClosingDraftText(row.reason, row.customer.nameAr),
      ));
    });
    this.yearClosingDrafts.register('SALES_QUOTE', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.salesQuote.findMany({
        where: { tenantId, companyId, status: 'DRAFT', quoteDate: { gte: from, lte: to } },
        select: { id: true, quoteDate: true, quoteNo: true, description: true, customer: { select: { nameAr: true } } },
      });
      return rows.map((row) => yearClosingDraft(
        'SALES_QUOTE',
        row.id,
        row.quoteDate,
        row.quoteNo,
        yearClosingDraftText(row.description, row.customer.nameAr),
      ));
    });
    this.yearClosingDrafts.register('SALES_ORDER', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.salesOrder.findMany({
        where: { tenantId, companyId, status: 'DRAFT', orderDate: { gte: from, lte: to } },
        select: { id: true, orderDate: true, orderNo: true, description: true, customer: { select: { nameAr: true } } },
      });
      return rows.map((row) => yearClosingDraft(
        'SALES_ORDER',
        row.id,
        row.orderDate,
        row.orderNo,
        yearClosingDraftText(row.description, row.customer.nameAr),
      ));
    });
  }

  /** ADR-024 §1.7: the first sales table whose header references the cost centre, drafts included. */
  async costCenterInUse(tx: Prisma.TransactionClient, costCenterId: bigint): Promise<string | null> {
    if (await tx.salesInvoice.findFirst({ where: { costCenterId }, select: { id: true } })) return 'sales_invoices';
    if (await tx.salesReturn.findFirst({ where: { costCenterId }, select: { id: true } })) return 'sales_returns';
    // ADR-027 §8: quotes and orders header their cost centre too.
    if (await tx.salesQuote.findFirst({ where: { costCenterId }, select: { id: true } })) return 'sales_quotes';
    if (await tx.salesOrder.findFirst({ where: { costCenterId }, select: { id: true } })) return 'sales_orders';
    return null;
  }

  /**
   * DB-15 / ADR-021: the first sales table that references the party in
   * any status (drafts included), or null, read on the caller's transaction.
   * A party used here is deactivated, never deleted.
   */
  async partyInUse(tx: Prisma.TransactionClient, partyId: bigint): Promise<string | null> {
    if (await tx.salesInvoice.findFirst({ where: { customerId: partyId }, select: { id: true } })) {
      return 'sales_invoices';
    }
    if (await tx.salesReturn.findFirst({ where: { customerId: partyId }, select: { id: true } })) {
      return 'sales_returns';
    }
    // ADR-027 §8: a customer named by a quote or an order is in use too.
    if (await tx.salesQuote.findFirst({ where: { customerId: partyId }, select: { id: true } })) return 'sales_quotes';
    if (await tx.salesOrder.findFirst({ where: { customerId: partyId }, select: { id: true } })) return 'sales_orders';
    return null;
  }

  /** Posted credit-return totals for the given invoices (for `outstanding`). */
  private async creditedFor(db: Pick<Prisma.TransactionClient, 'salesReturn'>, invoiceIds: bigint[]) {
    if (invoiceIds.length === 0) return new Map<string, Decimal>();
    const returns = await db.salesReturn.findMany({
      where: { originalInvoiceId: { in: invoiceIds }, status: 'POSTED', refundType: 'CREDIT' },
      select: { originalInvoiceId: true, grandTotal: true },
    });
    return creditedByInvoice(returns);
  }

  /**
   * Aging as of a date (Phase 6, DB-14): the posted credit invoices dated on
   * or before `asOf` that still owe something then, oldest first.
   * owed = grand_total − allocations counted as of asOf − posted CREDIT
   * returns dated on or before asOf. Allocations are treasury's: it passes
   * `allocationShift` = paid_amount − allocations counted as of asOf, per
   * invoice (non-zero only for vouchers dated after asOf and cancellations
   * that still count then). The filter runs in SQL on paid_amount, so settled
   * invoices are not read; those with a positive shift (settled after asOf)
   * are read too, in chunks. Cash invoices are settled at sale and never appear.
   */
  /**
   * The company's posted sales invoices as a derived table with the columns
   * `id`, `branch_id` and `doc_date`, for treasury's cross-branch aging
   * (ADR-003 §21): it joins allocations to their invoice's branch without
   * naming this module's table (module boundary, ADR-004).
   */
  async invoiceRefsSql(): Promise<Prisma.Sql> {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return Prisma.sql`(SELECT id, branch_id, invoice_date AS doc_date FROM sales_invoices
       WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND status = 'POSTED')`;
  }

  async openCreditInvoicesAsOf(asOf: Date, allocationShift: Map<bigint, Decimal>): Promise<OpenInvoiceAsOf[]> {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const day = asOf.toISOString().slice(0, 10);
    const query = (which: Prisma.Sql) => db.$queryRaw<OpenInvoiceRow[]>`
      SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.customer_id AS party_id,
             i.grand_total, i.paid_amount, COALESCE(r.credited, 0) AS credited
        FROM sales_invoices i
        LEFT JOIN (
          SELECT original_invoice_id, SUM(grand_total) AS credited
            FROM sales_returns
           WHERE tenant_id = ${tenantId} AND company_id = ${companyId}
             AND status = 'POSTED' AND refund_type = 'CREDIT' AND return_date <= ${day}
           GROUP BY original_invoice_id
        ) r ON r.original_invoice_id = i.id
       WHERE i.tenant_id = ${tenantId} AND i.company_id = ${companyId}
         AND i.status = 'POSTED' AND i.payment_type = 'CREDIT' AND i.invoice_date <= ${day}
         AND ${which}
         AND ${branchSql(Prisma.raw('i.branch_id'))}`;
    // Open now (owes something on paid_amount)...
    const rows = await query(Prisma.sql`i.grand_total - i.paid_amount - COALESCE(r.credited, 0) > 0`);
    // ...plus those settled now but not yet as of the date. The ids come from
    // treasury and may include invoices dated after asOf (dropped here by the
    // date filter); they are read in chunks to stay far below the 65,535
    // placeholders of a prepared statement.
    const settledLater = [...allocationShift].filter(([, shift]) => shift.gt(0)).map(([id]) => id);
    for (const ids of chunks(settledLater, IN_LIST_CHUNK)) {
      rows.push(
        ...(await query(
          Prisma.sql`i.grand_total - i.paid_amount - COALESCE(r.credited, 0) <= 0 AND i.id IN (${Prisma.join(ids)})`,
        )),
      );
    }
    rows.sort((x, y) => x.invoice_date.getTime() - y.invoice_date.getTime() || (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
    return owedAsOf(rows, allocationShift);
  }

  /**
   * Posted invoices dated in the range (both ends inclusive), added up by
   * day, month, customer, item or (tax category, rate) — the Phase 8 sales /
   * purchases / tax summaries and the dashboard. Header totals for day,
   * month and party; line amounts for item and tax (a header's totals are
   * the sums of its lines).
   */
  async summary(range: SummaryRange, groupBy: SummaryGroupBy): Promise<DocumentSummaryRow[]> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    // Branch of the caller (ADR-003 §12). `where` also filters the line groupBys through `invoice: where`.
    const where = {
      companyId,
      status: 'POSTED' as const,
      invoiceDate: { gte: range.from, lte: range.to },
      AND: [branchWhere()],
    };
    if (groupBy === 'day' || groupBy === 'month') {
      const groups = await db.salesInvoice.groupBy({
        by: ['invoiceDate'],
        where,
        _sum: { netTotal: true, taxTotal: true, grandTotal: true, costTotal: true },
        _count: { _all: true },
      });
      const days = groups.map((g) =>
        summaryRow(dayKey(g.invoiceDate), g._count._all, {
          net: g._sum.netTotal,
          tax: g._sum.taxTotal,
          grand: g._sum.grandTotal, cost: g._sum.costTotal,
        }),
      );
      return groupBy === 'month' ? foldMonths(days) : days;
    }
    if (groupBy === 'party') {
      const groups = await db.salesInvoice.groupBy({
        by: ['customerId'],
        where,
        _sum: { netTotal: true, taxTotal: true, grandTotal: true, costTotal: true },
        _count: { _all: true },
      });
      const refs = await partyRefs(db, groups.map((g) => g.customerId));
      return groups.map((g) =>
        summaryRow(
          g.customerId.toString(),
          g._count._all,
          { net: g._sum.netTotal, tax: g._sum.taxTotal, grand: g._sum.grandTotal, cost: g._sum.costTotal },
          { ref: refs.get(g.customerId.toString()) ?? null },
        ),
      );
    }
    const lines = { invoice: where };
    if (groupBy === 'item') {
      const groups = await db.salesInvoiceLine.groupBy({
        by: ['itemId'],
        where: lines,
        _sum: { qtyBase: true, netAmount: true, taxAmount: true, lineTotal: true, costTotal: true },
        _count: { _all: true },
      });
      const refs = await itemRefs(db, groups.map((g) => g.itemId));
      return groups.map((g) =>
        summaryRow(
          g.itemId.toString(),
          g._count._all,
          { qty: g._sum.qtyBase, net: g._sum.netAmount, tax: g._sum.taxAmount, grand: g._sum.lineTotal, cost: g._sum.costTotal },
          { ref: refs.get(g.itemId.toString()) ?? null },
        ),
      );
    }
    const groups = await db.salesInvoiceLine.groupBy({
      by: ['taxCategoryId', 'taxRate'],
      where: lines,
      _sum: { qtyBase: true, netAmount: true, taxAmount: true, lineTotal: true, costTotal: true },
      _count: { _all: true },
    });
    return taxRows(
      db,
      groups.map((g) => ({
        taxCategoryId: g.taxCategoryId,
        taxRate: g.taxRate,
        count: g._count._all,
        sums: { qty: g._sum.qtyBase, net: g._sum.netAmount, tax: g._sum.taxAmount, grand: g._sum.lineTotal, cost: g._sum.costTotal },
      })),
    );
  }

  // --------------------------------------------- settlement (treasury, ADR-004)

  /** SELECT … FOR UPDATE on the invoices, ascending id (§10.1 fixed lock order). */
  async lockForSettlement(tx: Prisma.TransactionClient, ids: bigint[]): Promise<void> {
    const { tenantId } = this.support.tenant();
    const sorted = lockOrder(ids);
    if (sorted.length === 0) return;
    // One locking read in id order (TRADE-18: auto-allocation used to lock every invoice one by one).
    await tx.$queryRaw`
      SELECT id FROM sales_invoices
       WHERE tenant_id = ${tenantId} AND id IN (${Prisma.join(sorted)})
       ORDER BY id FOR UPDATE`;
  }

  /**
   * Party, status, payment type and outstanding, read with LOCKING reads on
   * the caller's transaction. Under REPEATABLE READ a plain SELECT returns the
   * snapshot taken before the caller waited for the invoice lock, so a voucher
   * racing another would still see the old paid_amount and settle the invoice
   * twice (phase 6 race test). FOR UPDATE / LOCK IN SHARE MODE read the latest
   * committed rows.
   */
  async settlementState(tx: Prisma.TransactionClient, id: bigint): Promise<SettlementState | null> {
    const { tenantId } = this.support.tenant();
    const [inv] = await tx.$queryRaw<SettlementRow[]>`
      SELECT customer_id AS party_id, branch_id, status, payment_type, grand_total, paid_amount
        FROM sales_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!inv) return null;
    const [credited] = await tx.$queryRaw<{ s: { toString(): string } | null }[]>`
      SELECT SUM(grand_total) AS s FROM sales_returns
       WHERE tenant_id = ${tenantId} AND original_invoice_id = ${id}
         AND status = 'POSTED' AND refund_type = 'CREDIT' LOCK IN SHARE MODE`;
    return toSettlementState(inv, credited?.s);
  }

  /** paid_amount projection (§7.8) += delta; negative undoes an allocation. */
  async addPaid(tx: Prisma.TransactionClient, id: bigint, delta: Decimal): Promise<void> {
    await tx.salesInvoice.update({ where: { id }, data: { paidAmount: { increment: delta } } });
  }

  /**
   * The party's posted credit invoices that still have an outstanding
   * balance (§7.8), oldest first. Cash invoices are settled at sale. A plain
   * read: the caller locks them all with lockForSettlement and re-reads each
   * with settlementState (TRADE-18).
   */
  async creditInvoiceIdsOldestFirst(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    partyId: bigint,
  ): Promise<bigint[]> {
    const { tenantId } = this.support.tenant();
    // Only the caller's branches (ADR-003 §10): auto-allocation must not reach another branch's invoice.
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT i.id
        FROM sales_invoices i
        LEFT JOIN (
          SELECT original_invoice_id, SUM(grand_total) AS credited
            FROM sales_returns
           WHERE tenant_id = ${tenantId} AND status = 'POSTED' AND refund_type = 'CREDIT'
           GROUP BY original_invoice_id
        ) r ON r.original_invoice_id = i.id
       WHERE i.tenant_id = ${tenantId} AND i.company_id = ${companyId} AND i.customer_id = ${partyId}
         AND i.status = 'POSTED' AND i.payment_type = 'CREDIT'
         AND i.grand_total - i.paid_amount - COALESCE(r.credited, 0) > 0
         AND ${branchSql(Prisma.raw('i.branch_id'))}
       ORDER BY i.invoice_date, i.id`;
    return rows.map((r) => BigInt(r.id));
  }

  /** Invoice numbers by id (printed vouchers name the invoices they settled). */
  async invoiceNumbers(ids: bigint[]): Promise<Map<bigint, string | null>> {
    if (ids.length === 0) return new Map();
    const { db } = this.support.tenant();
    const rows = await db.salesInvoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNo: true } });
    return new Map(rows.map((r) => [r.id, r.invoiceNo]));
  }

  /**
   * One numbered page of invoices (ADR-022): the caller's branches only
   * (ADR-003 §10), newest first unless `sort` says otherwise.
   */
  async list(query: ListSalesInvoicesQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.SalesInvoiceWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentType ? { paymentType: query.paymentType } : {}),
      ...(query.customerId ? { customerId: BigInt(query.customerId) } : {}),
      ...(query.from || query.to
        ? {
            invoiceDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [
        branchWhere(),
        query.open === 'true'
          ? { status: 'POSTED', paymentType: 'CREDIT', grandTotal: { gt: db.salesInvoice.fields.paidAmount } }
          : {},
        q
          ? {
              OR: [
                { invoiceNo: { contains: q } },
                { customer: { code: { contains: q } } },
                { customer: { nameAr: { contains: q } } },
                { customer: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'invoiceDate' | 'invoiceNo' | 'grandTotal', Prisma.SalesInvoiceOrderByWithRelationInput>(
      query.sort,
      '-invoiceDate',
      {
        invoiceDate: (dir) => ({ invoiceDate: dir }),
        invoiceNo: (dir) => ({ invoiceNo: dir }),
        grandTotal: (dir) => ({ grandTotal: dir }),
      },
      (dir) => ({ id: dir }),
    );
    // The rows, their credited returns and the total read on one snapshot (ADR-022 §3).
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) => {
        const page = await tx.salesInvoice.findMany({
          where,
          include: {
            customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
            warehouse: { select: { id: true, code: true, nameAr: true } },
          },
          orderBy,
          ...window,
        });
        // Line counts of this page only (see withLineCounts).
        const rows = await withLineCounts(page, 'invoiceId', (ids) =>
          tx.salesInvoiceLine.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: ids } }, _count: { _all: true } }),
        );
        const credited = await this.creditedFor(tx, rows.map((r) => r.id));
        return rows.map((r) => withBalance(r, credited));
      },
      count: (tx) => tx.salesInvoice.count({ where }),
    });
  }

  /** One invoice; another branch's answers 404 like another tenant's (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const inv = await db.salesInvoice.findFirst({
      where: { id, ...branchWhere() },
      include: {
        customer: true,
        warehouse: true,
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            item: { select: { id: true, code: true, nameAr: true, baseUnitId: true, itemKind: true } },
            itemUnit: { include: { unit: { select: { id: true, code: true, nameAr: true } } } },
            // ADR-032 §12: what a recipe line took from stock, per merged component.
            components: {
              orderBy: { id: 'asc' },
              include: { componentItem: { select: { id: true, code: true, nameAr: true, baseUnitId: true, itemKind: true } } },
            },
          },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
        returns: { select: { id: true, returnNo: true, status: true, grandTotal: true } },
      },
    });
    if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
    return {
      ...withBalance(inv, await this.creditedFor(db, [inv.id])),
      einvoice: await this.einvoice.stateOf('SALES_INVOICE', inv.id),
    };
  }

  /**
   * ADR-032 §6: the quantity the recipe sales took from one warehouse per component item, for the
   * movements dated in (from, to]. Read from the component projection and its movements.
   */
  async recipeOutByItem(warehouseId: bigint, from: Date, to: Date): Promise<Map<bigint, Decimal>> {
    const { tenantId, db } = this.support.tenant();
    // The sales module reads its own tables only (CLAUDE.md): a component moved out of the invoice's
    // warehouse on the invoice date, so the invoice header gives both (review #65).
    const rows = await db.$queryRaw<{ itemId: bigint; qty: string }[]>`
      SELECT c.component_item_id AS itemId, COALESCE(SUM(c.qty_base), 0) AS qty
        FROM sales_invoice_line_components c
        JOIN sales_invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
       WHERE c.tenant_id = ${tenantId} AND i.warehouse_id = ${warehouseId} AND i.status = 'POSTED'
         AND i.invoice_date > ${from} AND i.invoice_date <= ${to}
       GROUP BY c.component_item_id`;
    return new Map(rows.map((r) => [BigInt(r.itemId), new Decimal(r.qty)]));
  }

  /**
   * ADR-032 §1 (report): the recipe lines of posted invoices dated in [from, to] that were sold without an
   * ACTIVE bill of materials, so their cost is missing. Lists them to correct the bills of materials.
   */
  async recipeSalesWithoutBom(from: Date, to: Date) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const lines = await db.salesInvoiceLine.findMany({
      where: {
        recipeBomMissing: true,
        invoice: { companyId, status: 'POSTED', invoiceDate: { gte: from, lte: to } },
      },
      orderBy: [{ invoiceId: 'asc' }, { lineNo: 'asc' }],
      select: {
        id: true,
        lineNo: true,
        qtyBase: true,
        netAmount: true,
        invoice: { select: { id: true, invoiceNo: true, invoiceDate: true } },
        item: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      },
    });
    return lines.map((l) => ({
      invoiceId: l.invoice.id,
      invoiceNo: l.invoice.invoiceNo,
      invoiceDate: l.invoice.invoiceDate,
      lineId: l.id,
      lineNo: l.lineNo,
      itemId: l.item.id,
      itemCode: l.item.code,
      itemNameAr: l.item.nameAr,
      itemNameEn: l.item.nameEn,
      qtyBase: new Decimal(l.qtyBase.toString()),
      netAmount: new Decimal(l.netAmount.toString()),
    }));
  }

  /**
   * ADR-032 §12: a draft's recipe lines, the stock components each one will take, what is on hand for
   * them in the invoice warehouse, the shortage (negative stock follows the company setting, ADR-018),
   * and the missing-version warning. Nothing is reserved or moved here.
   */
  async recipePreview(id: bigint) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const inv = await db.salesInvoice.findFirst({
      where: { id, ...branchWhere() },
      select: {
        id: true,
        warehouseId: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          select: { id: true, lineNo: true, itemId: true, qtyBase: true, item: { select: { code: true, itemKind: true } } },
        },
      },
    });
    if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
    const recipeLines = inv.lines.filter((l) => l.item.itemKind === 'RECIPE');
    // Explode every recipe line first, then read balances and names once for all components (review #65):
    // balances through the inventory module's service, never stock_balances directly (CLAUDE.md).
    const explosions = [];
    for (const line of recipeLines) {
      explosions.push(await this.bom.explodeToStock(db, companyId, line.itemId, line.qtyBase.toString(), false));
    }
    const allComponentIds = explosions.flatMap((e) => e.components.map((c) => c.itemId));
    const onHand = await this.ledger.onHandIn(db, inv.warehouseId, allComponentIds);
    const names = allComponentIds.length === 0
      ? []
      : await db.item.findMany({
          where: { companyId, id: { in: [...new Set(allComponentIds)] } },
          select: { id: true, code: true, nameAr: true },
        });
    const nameById = new Map(names.map((n) => [n.id, n]));
    const lines = [];
    for (const [index, line] of recipeLines.entries()) {
      const exp = explosions[index];
      const comps = exp.components.map((c) => {
        const have = onHand.get(c.itemId) ?? new Decimal(0);
        const short = c.qtyBase.gt(have) ? c.qtyBase.minus(have) : new Decimal(0);
        return { componentItemId: c.itemId, qtyBase: c.qtyBase, onHandBase: have, shortageBase: short };
      });
      lines.push({
        lineId: line.id,
        lineNo: line.lineNo,
        itemId: line.itemId,
        itemCode: line.item.code,
        qtyBase: line.qtyBase,
        bomMissing: exp.missing,
        components: comps.map((c) => ({
          componentItemId: c.componentItemId,
          code: nameById.get(c.componentItemId)?.code ?? '',
          nameAr: nameById.get(c.componentItemId)?.nameAr ?? '',
          qtyBase: c.qtyBase,
          onHandBase: c.onHandBase,
          shortageBase: c.shortageBase,
        })),
      });
    }
    return {
      invoiceId: inv.id,
      warehouseId: inv.warehouseId,
      hasWarnings: lines.some((l) => l.bomMissing),
      hasShortage: lines.some((l) => l.components.some((c) => c.shortageBase.gt(0))),
      lines,
    };
  }

  /**
   * A posted invoice as JoFotara needs it (docs/decisions/0005 §3–§7):
   * amounts exactly as posted. Read by the e-invoice module (module boundary).
   */
  async einvoiceSource(id: bigint) {
    const { db } = this.support.tenant();
    return db.salesInvoice.findFirst({
      where: { id, status: 'POSTED' },
      select: {
        id: true,
        invoiceNo: true,
        invoiceDate: true,
        paymentType: true,
        pricesIncludeTax: true,
        description: true,
        grandTotal: true,
        customer: {
          select: { nameAr: true, taxNumber: true, nationalId: true, nationalIdKind: true, phone: true, isCashCustomer: true },
        },
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            lineNo: true,
            qty: true,
            unitPrice: true,
            discountAmount: true,
            netAmount: true,
            taxRate: true,
            taxAmount: true,
            item: { select: { nameAr: true } },
            taxCategory: { select: { einvoiceCode: true } },
          },
        },
      },
    });
  }

  async create(dto: CreateSalesInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const pricesIncludeTax = await this.invoicePricesIncludeTax(db);
    assertDirectLines(dto.lines);
    const resolved = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    const calculation = this.applyInvoiceDiscount(resolved, dto, pricesIncludeTax);
    const lines = calculation.lines;
    await this.assertHeader(db, companyId, dto);

    const inv = await db.$transaction(async (tx) => {
      // Share-lock the header centre before the row that references it (ADR-024 §1.4).
      if (dto.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, BigInt(dto.costCenterId));
      const created = await tx.salesInvoice.create({
        data: {
          tenantId,
          companyId,
          // Branch from the request context (BranchGuard), never the body — ADR-003.
          branchId: currentBranchId(),
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          customerId: BigInt(dto.customerId),
          warehouseId: BigInt(dto.warehouseId),
          paymentType: dto.paymentType,
          invoiceDiscountPct: dto.invoiceDiscountPct ?? null,
          invoiceDiscountAmount: calculation.invoiceDiscountAmount,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
          description: dto.description ?? null,
          pricesIncludeTax,
          ...this.totals(lines),
          createdBy: this.support.userId() ?? null,
        },
      });
      await tx.salesInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: created.id,
          lineNo: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId,
          qty: l.dto.qty,
          qtyBase: l.amounts.qtyBase,
          unitPrice: l.dto.unitPrice,
          discountPct: l.dto.discountPct ?? '0',
          discountAmount: l.amounts.discountAmount,
          invoiceDiscountShare: l.invoiceDiscountShare,
          netAmount: l.amounts.netAmount,
          taxCategoryId: l.taxCategoryId,
          taxRate: l.taxRate,
          taxAmount: l.amounts.taxAmount,
          lineTotal: l.amounts.lineTotal,
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'sales_invoice.create',
      entityType: 'sales_invoice',
      entityId: inv.id,
      after: { lines: lines.length },
    });
    return this.get(inv.id);
  }

  async update(id: bigint, dto: CreateSalesInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const inv = await db.salesInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
    }
    assertBranchAllowed(inv.branchId);
    // ADR-027 §4: an invoice made from an order keeps its order's customer and warehouse.
    if (inv.salesOrderId !== null) {
      if (BigInt(dto.customerId) !== inv.customerId || BigInt(dto.warehouseId) !== inv.warehouseId) {
        throw new DomainError(ErrorCode.VALIDATION, 'An invoice made from a sales order keeps its customer and warehouse');
      }
    } else {
      assertDirectLines(dto.lines);
    }
    const pricesIncludeTax = await this.invoicePricesIncludeTax(db, inv);
    const resolved = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    const calculation = this.applyInvoiceDiscount(resolved, dto, pricesIncludeTax);
    const lines = calculation.lines;
    await this.assertHeader(db, companyId, dto);

    await db.$transaction(async (tx) => {
      // The company's sales settings first (shared), as in every sales transaction (ADR-027 §8).
      await lockCompanySales(tx, tenantId, companyId);
      // Lock the invoice and re-check it first: a save racing a post of the
      // same draft must not delete and rewrite the lines of a posted invoice.
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM sales_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      if (!locked || locked.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
      }
      if (inv.salesOrderId !== null) await this.lockDraftOrder(tx, tenantId, inv.salesOrderId, lines);
      // Share-lock the header centre before the row that references it (ADR-024 §1.4).
      if (dto.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, BigInt(dto.costCenterId));
      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.salesInvoice.update({
        where: { id },
        data: {
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          customerId: BigInt(dto.customerId),
          warehouseId: BigInt(dto.warehouseId),
          paymentType: dto.paymentType,
          invoiceDiscountPct: dto.invoiceDiscountPct ?? null,
          invoiceDiscountAmount: calculation.invoiceDiscountAmount,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
          description: dto.description ?? null,
          pricesIncludeTax,
          ...this.totals(lines),
          // ADR-027 §4 / ADR-026 §2: an edit clears the price approval.
          priceApprovedAt: null,
          priceApprovedBy: null,
          updatedBy: this.support.userId() ?? null,
        },
      });
      await tx.salesInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: id,
          lineNo: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId,
          orderLineId: l.dto.orderLineId ? BigInt(l.dto.orderLineId) : null,
          qty: l.dto.qty,
          qtyBase: l.amounts.qtyBase,
          unitPrice: l.dto.unitPrice,
          discountPct: l.dto.discountPct ?? '0',
          discountAmount: l.amounts.discountAmount,
          invoiceDiscountShare: l.invoiceDiscountShare,
          netAmount: l.amounts.netAmount,
          taxCategoryId: l.taxCategoryId,
          taxRate: l.taxRate,
          taxAmount: l.amounts.taxAmount,
          lineTotal: l.amounts.lineTotal,
        })),
      });
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'sales_invoice.update',
      entityType: 'sales_invoice',
      entityId: id,
    });
    return this.get(id);
  }

  async preview(dto: PreviewSalesInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const invoice = dto.invoiceId
      ? await db.salesInvoice.findFirst({
          where: { id: BigInt(dto.invoiceId), companyId },
          select: { id: true, status: true, branchId: true, pricesIncludeTax: true },
        })
      : null;
    if (dto.invoiceId && !invoice) throw DomainError.notFound('SalesInvoice', dto.invoiceId);
    if (invoice) {
      assertBranchAllowed(invoice.branchId);
      if (invoice.status !== 'DRAFT') throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be previewed');
    }
    const pricesIncludeTax = await this.invoicePricesIncludeTax(db, invoice ?? undefined);
    const resolved = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    const calculation = this.applyInvoiceDiscount(resolved, dto, pricesIncludeTax);
    const lineDiscountAmount = sum(
      calculation.lines.map((line) => line.amounts.discountAmount.minus(line.invoiceDiscountShare)),
    );
    const discountAmount = sum(calculation.lines.map((line) => line.amounts.discountAmount));
    return {
      subtotal: sum(dto.lines.map((line) => new Decimal(line.qty).times(line.unitPrice))),
      lineDiscountAmount,
      invoiceDiscountAmount: calculation.invoiceDiscountAmount,
      discountAmount,
      ...this.totals(calculation.lines),
      lines: calculation.lines.map((line, i) => ({
        lineNo: i + 1,
        discountAmount: line.amounts.discountAmount,
        invoiceDiscountShare: line.invoiceDiscountShare,
        netAmount: line.amounts.netAmount,
        taxAmount: line.amounts.taxAmount,
        lineTotal: line.amounts.lineTotal,
      })),
    };
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const inv = await db.salesInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be deleted');
    }
    assertBranchAllowed(inv.branchId);
    await db.salesInvoice.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * POST sales-orders/:id/invoice (ADR-027 §4): a draft invoice of what is left on each
   * line of a confirmed or partly invoiced order. The customer, warehouse, branch, cost
   * centre, prices-include-tax flag and tax come from the order. Several drafts may
   * exist at once; the posting decides (§4). A line with nothing left is not copied.
   */
  async createFromOrder(orderId: bigint, dto: CreateInvoiceFromOrderDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    // The order first: another branch's or tenant's id answers 404 before any body check.
    const exists = await db.salesOrder.findFirst({ where: { id: orderId, AND: [branchWhere()] }, select: { id: true } });
    if (!exists) throw DomainError.notFound('SalesOrder', orderId.toString());
    const paymentType = dto.paymentType ?? 'CREDIT';
    if (paymentType === 'CASH') {
      if (!dto.cashAccountId) throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
      await this.assertCashAccount(db, companyId, BigInt(dto.cashAccountId));
    }
    const invoiceDate = dto.invoiceDate ? new Date(dto.invoiceDate) : (await this.support.companyTodayDate());

    const id = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await lockCompanySales(tx, tenantId, companyId);
        const order = await lockSalesOrder(tx, tenantId, orderId);
        assertBranchAllowed(order.branch_id);
        assertOrderInvoiceable(order.status);
        const lines = await lockOrderLines(tx, tenantId, orderId);
        const header = await tx.salesOrder.findFirstOrThrow({
          where: { id: orderId },
          select: { branchId: true, customerId: true, warehouseId: true, costCenterId: true, pricesIncludeTax: true, paymentTermsDays: true },
        });
        const open = lines.filter((l) => leftToInvoice(l.qtyBase, l.invoicedQty).gt(0));
        if (open.length === 0) {
          throw new DomainError(ErrorCode.SALES_ORDER_NOT_INVOICEABLE, 'Nothing is left to invoice on the sales order', { status: order.status });
        }
        if (header.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, header.costCenterId);
        const dueDate = dto.dueDate
          ? new Date(dto.dueDate)
          : header.paymentTermsDays !== null
            ? addDays(invoiceDate, header.paymentTermsDays)
            : null;

        const drafts = open.map((l, i) => {
          const qty = unitQtyFloor(leftToInvoice(l.qtyBase, l.invoicedQty), l.factorToBase);
          const amounts = computeLineAmounts({
            qty: qty.toString(),
            factorToBase: l.factorToBase.toString(),
            unitPrice: l.unitPrice.toString(),
            discountPct: l.discountPct.toString(),
            taxRate: l.taxRate.toString(),
            pricesIncludeTax: header.pricesIncludeTax,
          });
          return { lineNo: i + 1, line: l, qty, amounts };
        });
        const created = await tx.salesInvoice.create({
          data: {
            tenantId,
            companyId,
            branchId: header.branchId,
            invoiceDate,
            dueDate,
            customerId: header.customerId,
            warehouseId: header.warehouseId,
            paymentType,
            invoiceDiscountPct: null,
            invoiceDiscountAmount: new Decimal(0),
            cashAccountId: paymentType === 'CASH' ? BigInt(dto.cashAccountId!) : null,
            costCenterId: header.costCenterId,
            salesOrderId: orderId,
            description: dto.description ?? null,
            pricesIncludeTax: header.pricesIncludeTax,
            netTotal: sum(drafts.map((d) => d.amounts.netAmount)),
            taxTotal: sum(drafts.map((d) => d.amounts.taxAmount)),
            grandTotal: sum(drafts.map((d) => d.amounts.lineTotal)),
            createdBy: this.support.userId() ?? null,
          },
        });
        await tx.salesInvoiceLine.createMany({
          data: drafts.map((d) => ({
            tenantId,
            invoiceId: created.id,
            lineNo: d.lineNo,
            orderLineId: d.line.id,
            itemId: d.line.itemId,
            itemUnitId: d.line.itemUnitId,
            qty: d.qty,
            qtyBase: d.amounts.qtyBase,
            unitPrice: d.line.unitPrice,
            discountPct: d.line.discountPct,
            discountAmount: d.amounts.discountAmount,
            invoiceDiscountShare: new Decimal(0),
            netAmount: d.amounts.netAmount,
            taxCategoryId: d.line.taxCategoryId,
            taxRate: d.line.taxRate,
            taxAmount: d.amounts.taxAmount,
            lineTotal: d.amounts.lineTotal,
          })),
        });
        await this.audit.log({
          action: 'sales_invoice.create',
          entityType: 'sales_invoice',
          entityId: created.id,
          after: { salesOrderId: orderId.toString() },
        }, tx);
        return created.id;
      }, POSTING_TX_OPTIONS),
    );
    return this.get(id);
  }

  /**
   * GET sales-orders/:id/invoiceable (ADR-027 §4): what each line of the order still
   * allows to invoice, in base units and in the line's unit (rounded down).
   */
  async invoiceable(orderId: bigint) {
    const { db } = this.support.tenant();
    const order = await db.salesOrder.findFirst({
      where: { id: orderId, AND: [branchWhere()] },
      select: {
        id: true,
        status: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            id: true,
            lineNo: true,
            itemId: true,
            itemUnitId: true,
            qtyBase: true,
            invoicedQty: true,
            unitPrice: true,
            discountPct: true,
            taxCategoryId: true,
            taxRate: true,
            itemUnit: { select: { factorToBase: true } },
          },
        },
      },
    });
    if (!order) throw DomainError.notFound('SalesOrder', orderId.toString());
    return {
      orderId: order.id.toString(),
      status: order.status,
      invoiceable: INVOICEABLE_ORDER_STATUSES.includes(order.status),
      lines: order.lines.map((l) => {
        const qtyBase = new Decimal(l.qtyBase.toString());
        const remaining = leftToInvoice(qtyBase, new Decimal(l.invoicedQty.toString()));
        const factor = l.itemUnit ? new Decimal(l.itemUnit.factorToBase.toString()) : new Decimal(1);
        return {
          orderLineId: l.id.toString(),
          lineNo: l.lineNo,
          itemId: l.itemId.toString(),
          itemUnitId: l.itemUnitId?.toString() ?? null,
          qtyBase: qtyBase.toFixed(6),
          invoicedQty: new Decimal(l.invoicedQty.toString()).toFixed(6),
          remainingBase: remaining.toFixed(6),
          remainingQty: unitQtyFloor(remaining, factor).toFixed(6),
          unitPrice: new Decimal(l.unitPrice.toString()).toFixed(3),
          discountPct: new Decimal(l.discountPct.toString()).toFixed(4),
          taxCategoryId: l.taxCategoryId?.toString() ?? null,
          taxRate: new Decimal(l.taxRate.toString()).toFixed(4),
        };
      }),
    };
  }

  /**
   * POST sales-invoices/:id/approve-price (ADR-027 §4): «approve the price» of a draft
   * made from an order, one with a line priced below its order line or discounted more.
   * sales.approve (the route), no amount limit, never by the invoice's author or last
   * editor; an owner always. A later edit of the draft clears it.
   */
  async approvePrice(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await lockCompanySales(tx, tenantId, companyId);
        const [inv] = await tx.$queryRaw<
          { status: string; branch_id: bigint | null; sales_order_id: bigint | null; created_by: bigint | null; updated_by: bigint | null }[]
        >`
          SELECT status, branch_id, sales_order_id, created_by, updated_by FROM sales_invoices
           WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
        assertBranchAllowed(inv.branch_id === null ? null : BigInt(inv.branch_id));
        if (inv.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only a draft invoice has a price to approve', {
            status: inv.status,
            action: 'approve-price',
          });
        }
        if (inv.sales_order_id === null) {
          throw new DomainError(ErrorCode.VALIDATION, 'Only an invoice made from a sales order has an order price to compare with');
        }
        const orderId = BigInt(inv.sales_order_id);
        await lockSalesOrder(tx, tenantId, orderId);
        const orderLines = new Map((await lockOrderLines(tx, tenantId, orderId)).map((l) => [l.id, l]));
        // A plain read after every lock above: its snapshot is taken now, so it sees the committed draft.
        const draft = await tx.salesInvoiceLine.findMany({ where: { invoiceId: id }, orderBy: { lineNo: 'asc' } });
        const below = draft.some((l) => {
          const ol = l.orderLineId === null ? undefined : orderLines.get(l.orderLineId);
          return ol !== undefined && pricedBelowOrder(
            {
              unitPrice: l.unitPrice.toString(),
              discountPct: l.discountPct.toString(),
              invoiceDiscountShare: l.invoiceDiscountShare.toString(),
              qty: l.qty.toString(),
            },
            { unitPrice: ol.unitPrice.toString(), discountPct: ol.discountPct.toString() },
          );
        });
        if (!below) throw new DomainError(ErrorCode.VALIDATION, 'No line is priced below the sales order: nothing to approve');
        const approver = await readApprover(tx, tenantId, PERMISSIONS.SALES_APPROVE);
        const author = {
          created_by: inv.created_by === null ? null : BigInt(inv.created_by),
          updated_by: inv.updated_by === null ? null : BigInt(inv.updated_by),
          submitted_by: null,
        };
        assertCanApprove({
          permission: PERMISSIONS.SALES_APPROVE,
          ...approver,
          amount: null,
          isAuthor: isAuthor(author, approver.userId),
        });
        // An approval is not an edit: updated_by stays the last editor.
        await tx.salesInvoice.update({ where: { id }, data: { priceApprovedAt: new Date(), priceApprovedBy: approver.userId } });
        await this.audit.log({
          action: 'sales_invoice.approve_price',
          entityType: 'sales_invoice',
          entityId: id,
          after: { approvedBy: approver.userId?.toString() ?? null },
        }, tx);
      }, POSTING_TX_OPTIONS),
    );
    return this.get(id);
  }

  /** Posts: stock OUT per line + revenue/tax/COGS journal (§8.4, §9), with the order and reservation rules of ADR-027 §4–§5. */
  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // The company's sales settings first, under a shared lock (ADR-027 §8). A post
        // never writes the company row, so concurrent posts hold shared locks only and
        // none of them waits to upgrade one.
        const settings = await lockCompanySales(tx, tenantId, companyId);
        // Lock the document first (§10.1 step 7). As the first statement it also
        // makes every later read see the latest committed state, so two
        // concurrent requests cannot both post or reverse it.
        await tx.$queryRaw`SELECT id FROM sales_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const draft = await tx.salesInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('SalesInvoice', id.toString());
        await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Invoice is not a draft');
        }
        assertBranchAllowed(draft.branchId);
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Invoice has no lines');
        }
        if (draft.paymentType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
        }
        const pricesIncludeTax = await this.invoicePricesIncludeTax(db, draft);
        // ADR-027 §1: while sales_order_required is on, a direct invoice does not post.
        if (settings.salesOrderRequired && draft.salesOrderId === null) {
          throw new DomainError(ErrorCode.SALES_ORDER_REQUIRED, 'Sales invoices are made from a sales order while sales_order_required is on');
        }
        // JoFotara rules (buyer, tax codes), checked before anything is posted (0005 §11).
        const buyer = await tx.party.findFirst({
          where: { id: draft.customerId },
          select: { nameAr: true, taxNumber: true, nationalId: true, nationalIdKind: true, phone: true, isCashCustomer: true },
        });
        const categoryIds = [...new Set(draft.lines.map((l) => l.taxCategoryId).filter((x): x is bigint => x !== null))];
        const codes = new Map(
          (
            await tx.taxCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, einvoiceCode: true } })
          ).map((c) => [c.id, c.einvoiceCode]),
        );
        if (buyer) {
          await this.einvoice.assertInvoiceSendable(tx, companyId, {
            paymentType: draft.paymentType,
            grandTotal: draft.grandTotal.toString(),
            buyer,
            lines: draft.lines.map((l) => ({
              taxRate: l.taxRate.toString(),
              taxAmount: l.taxAmount.toString(),
              einvoiceCode: l.taxCategoryId ? (codes.get(l.taxCategoryId) ?? null) : null,
            })),
          });
        }

        const invoiceDate = new Date(draft.invoiceDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, invoiceDate);

        // Plan quota (§13.1): sales invoices already posted in this invoice's month.
        const monthStart = new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth(), 1));
        const nextMonth = new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth() + 1, 1));
        await this.limits.assertMonthlyInvoiceQuota(
          tx,
          await tx.salesInvoice.count({
            where: { companyId, status: 'POSTED', invoiceDate: { gte: monthStart, lt: nextMonth } },
          }),
        );

        // An invoice made from an order: the order and its lines locked before any stock lock (ADR-027 §8).
        const billing = draft.salesOrderId === null ? null : await this.lockBilledOrder(tx, tenantId, draft, settings.salesPriceLocked);

        // ADR-032 §7: a recipe line explodes to its stock components before any stock lock. A recipe with
        // no ACTIVE version posts at cost 0 and is flagged (ADR-032 §1).
        let costTotal = new Decimal(0);
        let writeOff = new Decimal(0);
        const costByLine = new Map<bigint, { unitCost: Decimal; totalCost: Decimal }>();
        const explosions = await this.explodeRecipeLines(tx, companyId, draft.lines);
        const missingLineIds = [...explosions].filter(([, e]) => e.missing).map(([lineId]) => lineId);
        // Lock every (item, warehouse) in the fixed order before any movement: the document's own
        // pairs and the components of its recipes (ADR-032 §7).
        const stockItems = await this.ledger.lockForDocument(tx, companyId, [
          ...draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
          ...[...explosions.values()].flatMap((e) =>
            e.components.map((c) => ({ itemId: c.itemId, warehouseId: draft.warehouseId })),
          ),
        ]);
        // ADR-027 §5 (HARD): a direct invoice takes only what no open order reserves; read under the stock locks.
        // ADR-032 §10: the components of the recipes count with the direct lines.
        if (billing === null && settings.salesReservation === 'HARD') {
          await this.assertDirectReservable(
            tx,
            tenantId,
            companyId,
            draft.warehouseId,
            [
              ...draft.lines
                .filter((l) => !explosions.has(l.id))
                .map((l) => ({ itemId: l.itemId, qtyBase: new Decimal(l.qtyBase.toString()) })),
              ...[...explosions.values()].flatMap((e) => e.components.map((c) => ({ itemId: c.itemId, qtyBase: c.qtyBase }))),
            ],
            stockItems,
          );
        }
        const componentRows: Prisma.SalesInvoiceLineComponentCreateManyInput[] = [];
        for (const line of draft.lines) {
          const explosion = explosions.get(line.id);
          if (explosion !== undefined) {
            if (explosion.missing || explosion.bomId === null) {
              costByLine.set(line.id, { unitCost: new Decimal(0), totalCost: new Decimal(0) });
              continue;
            }
            let lineCost = new Decimal(0);
            for (const comp of explosion.components) {
              const res = await this.ledger.applyMovement(tx, companyId, {
                warehouseId: draft.warehouseId,
                itemId: comp.itemId,
                movementDate: invoiceDate,
                type: 'OUT',
                qty: comp.qtyBase.toString(),
                sourceType: SOURCE,
                sourceId: draft.id,
                sourceLineId: line.id,
                description: `Sales invoice ${draft.id}: recipe component`,
              });
              lineCost = lineCost.plus(res.totalCost);
              writeOff = writeOff.plus(res.writeOff);
              componentRows.push({
                tenantId,
                invoiceId: draft.id,
                invoiceLineId: line.id,
                componentItemId: comp.itemId,
                qtyBase: comp.qtyBase,
                unitCost: res.unitCost,
                totalCost: res.totalCost,
                movementId: res.movementId,
                bomId: explosion.bomId,
              });
            }
            // ADR-032 §8: the line's cost is the sum of its components; its unit cost is that sum per sold unit.
            costByLine.set(line.id, { unitCost: round6(lineCost.div(new Decimal(line.qtyBase.toString()))), totalCost: round3(lineCost) });
            costTotal = costTotal.plus(lineCost);
            continue;
          }
          if (!stockItems.has(line.itemId)) continue;
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.warehouseId,
            itemId: line.itemId,
            movementDate: invoiceDate,
            type: 'OUT',
            qty: line.qtyBase.toString(),
            sourceType: SOURCE,
            sourceId: draft.id,
            sourceLineId: line.id,
            description: `Sales invoice ${draft.id}`,
          });
          costByLine.set(line.id, { unitCost: res.unitCost, totalCost: res.totalCost });
          costTotal = costTotal.plus(res.totalCost);
          writeOff = writeOff.plus(res.writeOff);
        }
        if (componentRows.length > 0) await tx.salesInvoiceLineComponent.createMany({ data: componentRows });
        if (missingLineIds.length > 0) {
          await tx.salesInvoiceLine.updateMany({
            where: { invoiceId: draft.id, id: { in: missingLineIds } },
            data: { recipeBomMissing: true },
          });
        }
        // Persist the per-line cost snapshot in one statement (TRADE-21 / DB-09),
        // not one UPDATE per line inside the posting transaction.
        if (costByLine.size > 0) {
          const costs = [...costByLine];
          const unitCase = Prisma.join(
            costs.map(([lineId, c]) => Prisma.sql`WHEN ${lineId} THEN CAST(${c.unitCost.toString()} AS DECIMAL(18,6))`),
            ' ',
          );
          const totalCase = Prisma.join(
            costs.map(([lineId, c]) => Prisma.sql`WHEN ${lineId} THEN CAST(${c.totalCost.toString()} AS DECIMAL(18,3))`),
            ' ',
          );
          await tx.$executeRaw`
            UPDATE sales_invoice_lines
               SET unit_cost = CASE id ${unitCase} END,
                   cost_total = CASE id ${totalCase} END
             WHERE tenant_id = ${tenantId} AND invoice_id = ${draft.id}
               AND id IN (${Prisma.join(costs.map(([lineId]) => lineId))})`;
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'SALES',
          'OUTPUT_TAX',
          'COGS',
          'INVENTORY',
          'INVENTORY_ADJUSTMENT',
          'CUSTOMERS_CONTROL',
          ...(draft.invoiceDiscountAmount.gt(0) ? ['SALES_DISCOUNTS' as const] : []),
        ]);

        const discountByDimension = new Map<string, Decimal>();
        if (draft.invoiceDiscountAmount.gt(0)) {
          const key = `${draft.costCenterId?.toString() ?? ''}:${draft.branchId?.toString() ?? ''}`;
          discountByDimension.set(key, sum(draft.lines.map((line) => {
            if (line.invoiceDiscountShare.isZero()) return new Decimal(0);
            const beforeInvoiceDiscount = computeLineAmounts({
              qty: line.qty,
              factorToBase: '1',
              unitPrice: line.unitPrice,
              discountPct: line.discountPct,
              taxRate: line.taxRate,
              pricesIncludeTax,
            }).netAmount;
            return round3(beforeInvoiceDiscount.minus(line.netAmount));
          })));
        }
        const invoiceDiscountNetTotal = sum([...discountByDimension.values()]);
        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const net = draft.netTotal.plus(invoiceDiscountNetTotal);
        const tax = draft.taxTotal;

        if (draft.paymentType === 'CASH') {
          journalLines.push({
            accountId: draft.cashAccountId!,
            debit: grand.toString(),
            description: 'Cash sale',
          });
        } else {
          journalLines.push({
            accountId: mapping.CUSTOMERS_CONTROL,
            debit: grand.toString(),
            partyType: 'CUSTOMER',
            partyId: draft.customerId,
            description: 'Credit sale',
          });
        }
        if (net.gt(0)) {
          journalLines.push({ accountId: mapping.SALES, credit: net.toString() });
        }
        for (const amount of discountByDimension.values()) {
          if (amount.gt(0)) {
            journalLines.push({ accountId: mapping.SALES_DISCOUNTS, debit: amount.toString() });
          } else if (amount.lt(0)) {
            journalLines.push({ accountId: mapping.SALES_DISCOUNTS, credit: amount.abs().toString() });
          }
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.OUTPUT_TAX, credit: tax.toString() });
        }
        if (costTotal.gt(0)) {
          journalLines.push({ accountId: mapping.COGS, debit: costTotal.toString() });
          journalLines.push({ accountId: mapping.INVENTORY, credit: costTotal.toString() });
        }
        journalLines.push(
          ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
        );

        const invoiceNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'SALES_INVOICE', invoiceDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId: draft.branchId,
          entryDate: invoiceDate,
          fiscalPeriodId: period.id,
          sourceType: SOURCE,
          sourceId: draft.id,
          description: draft.description ?? `Sales invoice ${invoiceNo}`,
          lines: journalLines,
          postedBy: userId ?? null,
          // ADR-024 §1.2: onto the revenue and cost lines (income statement).
          costCenterId: draft.costCenterId,
          // ADR-024 §1.3: the document has a centre field, so a flagged line needs one.
          requireCostCenters: true,
        });

        await tx.salesInvoice.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            invoiceNo,
            costTotal,
            journalEntryId: entry.id,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        // ADR-027 §4: the order's billed quantities and status, in this same transaction.
        if (billing !== null) await this.recordOrderBilling(tx, billing);
        // Outbox (BUILD_PLAN §12.2): queued in this transaction, sent by the worker after it commits.
        await this.einvoice.enqueue(tx, {
          companyId,
          documentType: 'SALES_INVOICE',
          documentId: draft.id,
          documentNo: invoiceNo,
          branchId: draft.branchId,
        });
        await this.audit.log({
          action: 'sales_invoice.post',
          entityType: 'sales_invoice',
          entityId: draft.id,
          after: { invoiceNo },
        }, tx);
        return { id: draft.id, invoiceNo };
      }, POSTING_TX_OPTIONS),
    );

    return this.get(result.id);
  }

  // ------------------------------------------------------------- internals

  /**
   * ADR-032 §7: the explosion of each recipe line of a draft, read in the posting transaction
   * before any stock lock (the BOM versions are read with a shared lock there).
   */
  private async explodeRecipeLines(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    lines: { id: bigint; itemId: bigint; qtyBase: Prisma.Decimal }[],
  ): Promise<Map<bigint, StockExplosion>> {
    const kinds = await tx.item.findMany({
      where: { companyId, id: { in: [...new Set(lines.map((l) => l.itemId))] } },
      select: { id: true, itemKind: true },
    });
    const recipes = new Set(kinds.filter((k) => isRecipe(k.itemKind)).map((k) => k.id));
    const out = new Map<bigint, StockExplosion>();
    for (const line of lines) {
      if (!recipes.has(line.itemId)) continue;
      out.set(line.id, await this.bom.explodeToStock(tx, companyId, line.itemId, line.qtyBase.toString(), true));
    }
    return out;
  }

  /**
   * ADR-027 §4 under the locks of a post: the order and its lines (locking reads, before
   * any stock lock), the order's status, what this invoice bills per order line, and the
   * price approval when the price is locked.
   */
  private async lockBilledOrder(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    draft: { salesOrderId: bigint | null; priceApprovedAt: Date | null; lines: PostedDraftLine[] },
    priceLocked: boolean,
  ): Promise<BilledOrder> {
    const orderId = draft.salesOrderId!;
    const order = await lockSalesOrder(tx, tenantId, orderId);
    assertBranchAllowed(order.branch_id);
    assertOrderInvoiceable(order.status);
    const lines = await lockOrderLines(tx, tenantId, orderId);
    const byId = new Map(lines.map((l) => [l.id, l]));
    const billed = billedPerOrderLine(
      byId,
      draft.lines.map((l) => ({ lineNo: l.lineNo, orderLineId: l.orderLineId, itemId: l.itemId, qtyBase: new Decimal(l.qtyBase.toString()) })),
    );
    if (priceLocked && draft.priceApprovedAt === null) {
      const below = draft.lines
        .filter((l) => {
          const ol = l.orderLineId === null ? undefined : byId.get(l.orderLineId);
          return ol !== undefined && pricedBelowOrder(
            {
              unitPrice: l.unitPrice.toString(),
              discountPct: l.discountPct.toString(),
              invoiceDiscountShare: l.invoiceDiscountShare.toString(),
              qty: l.qty.toString(),
            },
            { unitPrice: ol.unitPrice.toString(), discountPct: ol.discountPct.toString() },
          );
        })
        .map((l) => l.lineNo);
      if (below.length > 0) {
        throw new DomainError(ErrorCode.SALES_PRICE_APPROVAL_REQUIRED, 'A line is priced below its sales order line: approve the price first', {
          lines: below,
        });
      }
    }
    return { orderId, lines, billed };
  }

  /**
   * The order part of a draft update (ADR-027 §4): the order is invoiceable, and each
   * line bills one of its lines, no more than what is left. Under the order locks.
   */
  private async lockDraftOrder(tx: Prisma.TransactionClient, tenantId: bigint, orderId: bigint, lines: ResolvedLine[]): Promise<void> {
    const order = await lockSalesOrder(tx, tenantId, orderId);
    assertBranchAllowed(order.branch_id);
    assertOrderInvoiceable(order.status);
    const byId = new Map((await lockOrderLines(tx, tenantId, orderId)).map((l) => [l.id, l]));
    billedPerOrderLine(
      byId,
      lines.map((l, i) => ({
        lineNo: i + 1,
        orderLineId: l.dto.orderLineId ? BigInt(l.dto.orderLineId) : null,
        itemId: l.itemId,
        qtyBase: l.amounts.qtyBase,
      })),
    );
  }

  /** ADR-027 §4: the invoice's billed quantities go onto its order lines; the order is INVOICED when all of them are billed. */
  private async recordOrderBilling(tx: Prisma.TransactionClient, billing: BilledOrder): Promise<void> {
    for (const [lineId, qty] of billing.billed) {
      await tx.salesOrderLine.update({ where: { id: lineId }, data: { invoicedQty: { increment: qty } } });
    }
    const allBilled = billing.lines.every((l) => leftToInvoice(l.qtyBase, l.invoicedQty.plus(billing.billed.get(l.id) ?? 0)).lte(0));
    await tx.salesOrder.update({ where: { id: billing.orderId }, data: { status: allBilled ? 'INVOICED' : 'PARTIALLY_INVOICED' } });
  }

  /**
   * ADR-027 §5 (HARD): the stock a direct invoice takes must fit in what is available,
   * that is on hand less what the other open orders still reserve. Called after the
   * stock locks, so the on-hand quantities are the committed ones; the reservations are
   * read with a locking read for the same reason. Negative stock does not lift the block.
   */
  private async assertDirectReservable(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    warehouseId: bigint,
    lines: { itemId: bigint; qtyBase: Decimal }[],
    stockItems: Set<bigint>,
  ): Promise<void> {
    const needed = neededPerItem(lines.filter((l) => stockItems.has(l.itemId)));
    if (needed.size === 0) return;
    const held = await reservedByItem(tx, tenantId, companyId, warehouseId, [...needed.keys()], null, true);
    for (const [itemId, need] of needed) {
      const onHand = this.ledger.lockedQtyOnHand(tx, warehouseId, itemId);
      const available = availableQty(onHand, held.get(itemId) ?? new Decimal(0));
      if (need.gt(available)) {
        throw new DomainError(ErrorCode.STOCK_RESERVED, 'The quantity is above what is available after the sales orders reserve their stock', {
          itemId: itemId.toString(),
          needed: need.toFixed(6),
          available: available.toFixed(6),
        });
      }
    }
  }

  /** A cash invoice's account: an active cash or bank account of the company (as on a direct invoice). */
  private async assertCashAccount(db: ReturnType<PrismaService['forTenant']>, companyId: bigint, accountId: bigint): Promise<void> {
    const acc = await db.account.findFirst({
      where: { companyId, id: accountId, isActive: true, isPostable: true, controlType: { in: ['CASH', 'BANK'] } },
      select: { id: true },
    });
    if (!acc) throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId must be an active cash/bank account');
  }

  private totals(lines: ResolvedLine[]) {
    return {
      netTotal: sum(lines.map((l) => l.amounts.netAmount)),
      taxTotal: sum(lines.map((l) => l.amounts.taxAmount)),
      grandTotal: sum(lines.map((l) => l.amounts.lineTotal)),
    };
  }

  private async invoicePricesIncludeTax(
    db: ReturnType<PrismaService['forTenant']>,
    invoice?: { pricesIncludeTax: boolean },
  ): Promise<boolean> {
    return invoice?.pricesIncludeTax ?? this.support.pricesIncludeTax(db);
  }

  private applyInvoiceDiscount(
    lines: ResolvedLine[],
    dto: Pick<CreateSalesInvoiceDto, 'invoiceDiscountPct' | 'invoiceDiscountAmount'>,
    pricesIncludeTax: boolean,
  ) {
    const discount = {
      ...(dto.invoiceDiscountPct !== undefined ? { pct: dto.invoiceDiscountPct } : {}),
      ...(dto.invoiceDiscountAmount !== undefined ? { amount: dto.invoiceDiscountAmount } : {}),
    };
    const allocation = allocateInvoiceDiscount(
      lines.map((line) => pricesIncludeTax ? line.amounts.lineTotal : line.amounts.netAmount),
      discount,
    );
    const discountedLines = lines.map((line, i) => {
      const invoiceDiscountShare = allocation.shares[i];
      return {
        ...line,
        invoiceDiscountShare,
        amounts: invoiceDiscountShare.isZero()
          ? line.amounts
          : computeLineAmounts({
              qty: line.dto.qty,
              factorToBase: line.factorToBase,
              unitPrice: line.dto.unitPrice,
              discountPct: line.dto.discountPct ?? '0',
              invoiceDiscountShare,
              taxRate: line.taxRate,
              pricesIncludeTax,
            }),
      };
    });
    return { lines: discountedLines, invoiceDiscountAmount: allocation.amount };
  }

  private async assertHeader(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    dto: CreateSalesInvoiceDto,
  ) {
    const customer = await db.party.findFirst({
      where: { companyId, id: BigInt(dto.customerId), isActive: true },
      select: { id: true, partyType: true },
    });
    if (!customer || (customer.partyType !== 'CUSTOMER' && customer.partyType !== 'BOTH')) {
      throw new DomainError(ErrorCode.VALIDATION, 'Customer not found or not a customer');
    }
    const warehouse = await db.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true, branchId: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);
    assertBranchAllowed(warehouse.branchId);
    if (dto.paymentType === 'CASH') {
      if (!dto.cashAccountId) {
        throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
      }
      const acc = await db.account.findFirst({
        where: {
          companyId,
          id: BigInt(dto.cashAccountId),
          isActive: true,
          isPostable: true,
          controlType: { in: ['CASH', 'BANK'] },
        },
        select: { id: true },
      });
      if (!acc) {
        throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId must be an active cash/bank account');
      }
    }
  }

  private async resolveLines(
    db: ReturnType<PrismaService['forTenant']>,
    tenantId: bigint,
    companyId: bigint,
    dtos: SalesInvoiceLineDto[],
    pricesIncludeTax = false,
  ): Promise<ResolvedLine[]> {
    const itemIds = dtos.map((l) => BigInt(l.itemId));
    const items = await db.item.findMany({
      where: { tenantId, companyId, id: { in: itemIds }, isActive: true },
      include: { taxCategory: { select: { id: true, rate: true } } },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const unitIds = dtos.filter((l) => l.itemUnitId).map((l) => BigInt(l.itemUnitId!));
    const units = unitIds.length
      ? await db.itemUnit.findMany({
          where: { tenantId, id: { in: unitIds }, isActive: true },
          include: { unit: { select: { id: true, code: true } } },
        })
      : [];
    const unitById = new Map(units.map((u) => [u.id, u]));

    const taxIds = [
      ...new Set(
        dtos
          .map((l) => l.taxCategoryId ?? itemById.get(BigInt(l.itemId))?.taxCategoryId?.toString())
          .filter((x): x is string => !!x)
          .map((x) => BigInt(x)),
      ),
    ];
    const taxes = taxIds.length
      ? await db.taxCategory.findMany({
          where: { tenantId, id: { in: taxIds }, isActive: true },
          select: { id: true, rate: true },
        })
      : [];
    const taxById = new Map(taxes.map((t) => [t.id, t]));
    const defaultTax = await db.taxCategory.findFirst({
      where: { tenantId, isDefault: true, isActive: true },
      select: { id: true, rate: true },
    });

    const out: ResolvedLine[] = [];
    for (const l of dtos) {
      const item = itemById.get(BigInt(l.itemId));
      if (!item) throw DomainError.notFound('Item', l.itemId);

      let itemUnitId: bigint | null = null;
      let factorToBase = new Decimal(1);
      if (l.itemUnitId) {
        const iu = unitById.get(BigInt(l.itemUnitId));
        if (!iu || iu.itemId !== item.id) {
          throw new DomainError(ErrorCode.VALIDATION, `Item unit ${l.itemUnitId} does not belong to item ${item.code}`);
        }
        itemUnitId = iu.id;
        factorToBase = iu.factorToBase;
      }

      const taxCategoryId = l.taxCategoryId
        ? BigInt(l.taxCategoryId)
        : (item.taxCategoryId ?? defaultTax?.id ?? null);
      const taxRate = taxCategoryId
        ? new Decimal(taxById.get(taxCategoryId)?.rate ?? item.taxCategory?.rate ?? defaultTax?.rate ?? 0)
        : new Decimal(0);

      const qty = new Decimal(l.qty);
      if (qty.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
      const amounts = computeLineAmounts({
        qty: l.qty,
        factorToBase,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct ?? '0',
        taxRate,
        pricesIncludeTax,
      });
      out.push({
        dto: l,
        itemId: item.id,
        itemUnitId,
        factorToBase,
        itemKind: item.itemKind,
        taxRate,
        taxCategoryId,
        invoiceDiscountShare: new Decimal(0),
        amounts,
      });
    }
    return out;
  }
}
