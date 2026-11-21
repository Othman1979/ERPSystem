import { Injectable, type OnModuleInit } from '@nestjs/common';
import { currentCompanySqlFilter } from '../../common/cls/current-company.js';
import { Decimal, round3, round6, sum } from '../../common/decimal/decimal.utils.js';
import {
  assertBranchAllowed,
  branchSql,
  branchWhere,
  currentBranchId,
  assertWarehouseBranchAllowed,
} from '../../common/branch/branch-context.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
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
import { computeLineAmounts } from '../shared/invoice-math.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';
import { GoodsNotesService, type GrnBillingSource } from '../goods-notes/goods-notes.service.js';
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
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type {
  CreatePurchaseInvoiceDto,
  ListPurchaseInvoicesQueryDto,
  PurchaseInvoiceLineDto,
} from './dto/purchases.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { CostCenterUsageRegistry } from '../cost-centers/cost-center-usage.registry.js';
import { assertCanApprove, assertDirectPurchaseAllowed, isAuthor, readApprover } from '../../common/procurement/approval.js';
import { lockProcurementLevel } from '../../common/procurement/procurement-level.js';
import type { ReceiptLine } from '../goods-notes/goods-notes.service.js';
import {
  BILLABLE_ORDER_STATUSES,
  netUnitPrice,
  PurchaseOrderReceiptsService,
  type LockedOrderLine,
} from '../procurement/purchase-order-receipts.service.js';
import type { BillPurchaseOrderDto } from './dto/purchases.dto.js';
import { clearedThrough } from '../shared/receipt-clearing.js';
import { isStocked, ItemKindValue, assertNotRecipe } from '../../common/inventory/item-kind.js';
import { YearClosingDraftRegistry, yearClosingDraft, yearClosingDraftText } from '../accounting/year-closing-draft.registry.js';
import { DocumentLocksService } from '../document-locks/document-locks.service.js';

const SOURCE = 'PURCHASE_INVOICE';

/** An order as an invoice drafted from its receipts reads it (PurchaseOrderReceiptsService.forBilling). */
type BillingOrder = Awaited<ReturnType<PurchaseOrderReceiptsService['forBilling']>>;

/** An invoice line priced above its order line (ADR-026 §2). */
interface AbovePrice {
  lineNo: number;
  grnLineId: string;
  invoiceNetUnitPrice: string;
  orderNetUnitPrice: string;
}

type Num = { toString(): string };

interface ResolvedLine {
  dto: PurchaseInvoiceLineDto;
  itemId: bigint;
  itemUnitId: bigint | null;
  factorToBase: Decimal;
  itemKind: ItemKindValue;
  taxRate: Decimal;
  taxCategoryId: bigint | null;
  amounts: ReturnType<typeof computeLineAmounts>;
}

/**
 * Purchase invoices: draft CRUD + post → stock IN (STOCK lines, at
 * netAmount/qtyBase cost) + inventory/purchases/tax journal (§8.4).
 */
@Injectable()
export class PurchaseInvoicesService implements OnModuleInit, InvoiceSettlement {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly goodsNotes: GoodsNotesService,
    private readonly partyUsage: PartyUsageRegistry,
    private readonly costCenters: CostCentersService,
    private readonly costCenterUsage: CostCenterUsageRegistry,
    private readonly orders: PurchaseOrderReceiptsService,
    private readonly yearClosingDrafts: YearClosingDraftRegistry,
    private readonly documentLocks: DocumentLocksService,
  ) {}

  onModuleInit(): void {
    this.documentLocks.registerTarget('PURCHASE_INVOICE', {
      lockForEdit: async (tx, docId) => {
        const { tenantId } = this.support.tenant();
        const [row] = await tx.$queryRaw<{ branch_id: bigint | null }[]>`
          SELECT branch_id FROM purchase_invoices
           WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${docId}
           FOR UPDATE`;
        if (!row) throw DomainError.notFound('PURCHASE_INVOICE', docId.toString());
        return { branchId: row.branch_id };
      },
      find: async (db, docId) => {
        const { tenantId } = this.support.tenant();
        const [row] = await db.$queryRaw<{ branch_id: bigint | null }[]>`
          SELECT branch_id FROM purchase_invoices
           WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${docId}`;
        if (!row) throw DomainError.notFound('PURCHASE_INVOICE', docId.toString());
        return { branchId: row.branch_id };
      },
    });
    this.partyUsage.register('purchases', (tx, partyId) => this.partyInUse(tx, partyId));
    this.costCenterUsage.register('purchases', (tx, id) => this.costCenterInUse(tx, id));
    this.yearClosingDrafts.register('PURCHASE_INVOICE', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.purchaseInvoice.findMany({
        where: { tenantId, companyId, status: 'DRAFT', invoiceDate: { gte: from, lte: to } },
        select: { id: true, invoiceDate: true, invoiceNo: true, description: true, supplier: { select: { nameAr: true } } },
      });
      return rows.map((row) => yearClosingDraft(
        'PURCHASE_INVOICE',
        row.id,
        row.invoiceDate,
        row.invoiceNo,
        yearClosingDraftText(row.description, row.supplier.nameAr),
      ));
    });
    this.yearClosingDrafts.register('PURCHASE_RETURN', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.purchaseReturn.findMany({
        where: { tenantId, companyId, status: 'DRAFT', returnDate: { gte: from, lte: to } },
        select: { id: true, returnDate: true, returnNo: true, reason: true, supplier: { select: { nameAr: true } } },
      });
      return rows.map((row) => yearClosingDraft(
        'PURCHASE_RETURN',
        row.id,
        row.returnDate,
        row.returnNo,
        yearClosingDraftText(row.reason, row.supplier.nameAr),
      ));
    });
  }

  /** ADR-024 §1.7: the first purchases table whose header references the cost centre, drafts included. */
  async costCenterInUse(tx: Prisma.TransactionClient, costCenterId: bigint): Promise<string | null> {
    if (await tx.purchaseInvoice.findFirst({ where: { costCenterId }, select: { id: true } })) return 'purchase_invoices';
    if (await tx.purchaseReturn.findFirst({ where: { costCenterId }, select: { id: true } })) return 'purchase_returns';
    return null;
  }

  /**
   * DB-15 / ADR-021: the first purchases table that references the party in
   * any status (drafts included), or null, read on the caller's transaction.
   * A party used here is deactivated, never deleted.
   */
  async partyInUse(tx: Prisma.TransactionClient, partyId: bigint): Promise<string | null> {
    if (await tx.purchaseInvoice.findFirst({ where: { supplierId: partyId }, select: { id: true } })) {
      return 'purchase_invoices';
    }
    if (await tx.purchaseReturn.findFirst({ where: { supplierId: partyId }, select: { id: true } })) {
      return 'purchase_returns';
    }
    return null;
  }

  /** Posted credit-return totals for the given invoices (for `outstanding`). */
  private async creditedFor(db: Pick<Prisma.TransactionClient, 'purchaseReturn'>, invoiceIds: bigint[]) {
    if (invoiceIds.length === 0) return new Map<string, Decimal>();
    const returns = await db.purchaseReturn.findMany({
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
   * are read too, in chunks. Cash invoices are settled at purchase and never appear.
   */
  /**
   * The company's posted purchase invoices as a derived table with the columns
   * `id`, `branch_id` and `doc_date`, for treasury's cross-branch aging
   * (ADR-003 §21): it joins allocations to their invoice's branch without
   * naming this module's table (module boundary, ADR-004).
   */
  async invoiceRefsSql(): Promise<Prisma.Sql> {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return Prisma.sql`(SELECT id, branch_id, invoice_date AS doc_date FROM purchase_invoices
       WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND status = 'POSTED')`;
  }

  async openCreditInvoicesAsOf(asOf: Date, allocationShift: Map<bigint, Decimal>): Promise<OpenInvoiceAsOf[]> {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const day = asOf.toISOString().slice(0, 10);
    const query = (which: Prisma.Sql) => db.$queryRaw<OpenInvoiceRow[]>`
      SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.supplier_id AS party_id,
             i.grand_total, i.paid_amount, COALESCE(r.credited, 0) AS credited
        FROM purchase_invoices i
        LEFT JOIN (
          SELECT original_invoice_id, SUM(grand_total) AS credited
            FROM purchase_returns
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
   * day, month, supplier, item or (tax category, rate) — the Phase 8 sales /
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
      const groups = await db.purchaseInvoice.groupBy({
        by: ['invoiceDate'],
        where,
        _sum: { netTotal: true, taxTotal: true, grandTotal: true },
        _count: { _all: true },
      });
      const days = groups.map((g) =>
        summaryRow(dayKey(g.invoiceDate), g._count._all, {
          net: g._sum.netTotal,
          tax: g._sum.taxTotal,
          grand: g._sum.grandTotal,
        }),
      );
      return groupBy === 'month' ? foldMonths(days) : days;
    }
    if (groupBy === 'party') {
      const groups = await db.purchaseInvoice.groupBy({
        by: ['supplierId'],
        where,
        _sum: { netTotal: true, taxTotal: true, grandTotal: true },
        _count: { _all: true },
      });
      const refs = await partyRefs(db, groups.map((g) => g.supplierId));
      return groups.map((g) =>
        summaryRow(
          g.supplierId.toString(),
          g._count._all,
          { net: g._sum.netTotal, tax: g._sum.taxTotal, grand: g._sum.grandTotal },
          { ref: refs.get(g.supplierId.toString()) ?? null },
        ),
      );
    }
    const lines = { invoice: where };
    if (groupBy === 'item') {
      const groups = await db.purchaseInvoiceLine.groupBy({
        by: ['itemId'],
        where: lines,
        _sum: { qtyBase: true, netAmount: true, taxAmount: true, lineTotal: true },
        _count: { _all: true },
      });
      const refs = await itemRefs(db, groups.map((g) => g.itemId));
      return groups.map((g) =>
        summaryRow(
          g.itemId.toString(),
          g._count._all,
          { qty: g._sum.qtyBase, net: g._sum.netAmount, tax: g._sum.taxAmount, grand: g._sum.lineTotal },
          { ref: refs.get(g.itemId.toString()) ?? null },
        ),
      );
    }
    const groups = await db.purchaseInvoiceLine.groupBy({
      by: ['taxCategoryId', 'taxRate'],
      where: lines,
      _sum: { qtyBase: true, netAmount: true, taxAmount: true, lineTotal: true },
      _count: { _all: true },
    });
    return taxRows(
      db,
      groups.map((g) => ({
        taxCategoryId: g.taxCategoryId,
        taxRate: g.taxRate,
        count: g._count._all,
        sums: { qty: g._sum.qtyBase, net: g._sum.netAmount, tax: g._sum.taxAmount, grand: g._sum.lineTotal },
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
      SELECT id FROM purchase_invoices
       WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id IN (${Prisma.join(sorted)})
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
      SELECT supplier_id AS party_id, branch_id, status, payment_type, grand_total, paid_amount
        FROM purchase_invoices WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
    if (!inv) return null;
    const [credited] = await tx.$queryRaw<{ s: { toString(): string } | null }[]>`
      SELECT SUM(grand_total) AS s FROM purchase_returns
       WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND original_invoice_id = ${id}
         AND status = 'POSTED' AND refund_type = 'CREDIT' LOCK IN SHARE MODE`;
    return toSettlementState(inv, credited?.s);
  }

  /** paid_amount projection (§7.8) += delta; negative undoes an allocation. */
  async addPaid(tx: Prisma.TransactionClient, id: bigint, delta: Decimal): Promise<void> {
    await tx.purchaseInvoice.update({ where: { id }, data: { paidAmount: { increment: delta } } });
  }

  /**
   * The party's posted credit invoices that still have an outstanding
   * balance (§7.8), oldest first. Cash invoices are settled at purchase. A
   * plain read: the caller locks them all with lockForSettlement and re-reads
   * each with settlementState (TRADE-18).
   */
  async creditInvoiceIdsOldestFirst(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    partyId: bigint,
  ): Promise<bigint[]> {
    const { tenantId } = this.support.tenant();
    const rows = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT i.id
        FROM purchase_invoices i
        LEFT JOIN (
          SELECT original_invoice_id, SUM(grand_total) AS credited
            FROM purchase_returns
           WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND status = 'POSTED' AND refund_type = 'CREDIT'
           GROUP BY original_invoice_id
        ) r ON r.original_invoice_id = i.id
       WHERE i.tenant_id = ${tenantId} AND i.company_id = ${companyId} AND i.supplier_id = ${partyId}
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
    const rows = await db.purchaseInvoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNo: true } });
    return new Map(rows.map((r) => [r.id, r.invoiceNo]));
  }

  async draftCount(): Promise<number> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.purchaseInvoice.count({
      where: { companyId, status: 'DRAFT', AND: [branchWhere()] },
    });
  }

  /**
   * Numbered page of invoices (ADR-022), newest first unless `sort` says otherwise.
   * `q` matches the invoice number, the supplier's invoice number and the supplier's
   * code and names. Branch: the invoice's own branch (ADR-003 §10).
   */
  async list(query: ListPurchaseInvoicesQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.PurchaseInvoiceWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentType ? { paymentType: query.paymentType } : {}),
      ...(query.supplierId ? { supplierId: BigInt(query.supplierId) } : {}),
      ...(query.purchaseOrderId ? { purchaseOrderId: BigInt(query.purchaseOrderId) } : {}),
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
          ? { status: 'POSTED', paymentType: 'CREDIT', grandTotal: { gt: db.purchaseInvoice.fields.paidAmount } }
          : {},
        q
          ? {
              OR: [
                { invoiceNo: { contains: q } },
                { supplierInvoiceNo: { contains: q } },
                { supplier: { code: { contains: q } } },
                { supplier: { nameAr: { contains: q } } },
                { supplier: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'invoiceDate' | 'invoiceNo' | 'grandTotal', Prisma.PurchaseInvoiceOrderByWithRelationInput>(
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
        const page = await tx.purchaseInvoice.findMany({
          where,
          include: {
            supplier: { select: { id: true, code: true, nameAr: true, nameEn: true } },
          },
          orderBy,
          ...window,
        });
        // Line counts of this page only (see withLineCounts).
        const rows = await withLineCounts(page, 'invoiceId', (ids) =>
          tx.purchaseInvoiceLine.groupBy({ by: ['invoiceId'], where: { invoiceId: { in: ids } }, _count: { _all: true } }),
        );
        const credited = await this.creditedFor(tx, rows.map((r) => r.id));
        return rows.map((r) => withBalance(r, credited));
      },
      count: (tx) => tx.purchaseInvoice.count({ where }),
    });
  }

  /** One invoice; another branch's answers 404 (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const inv = await db.purchaseInvoice.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        supplier: true,
        warehouse: { select: { id: true, code: true, nameAr: true } },
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            item: { select: { id: true, code: true, nameAr: true, baseUnitId: true, itemKind: true } },
            itemUnit: { include: { unit: { select: { id: true, code: true, nameAr: true } } } },
            // ADR-026 §7: the GRN line it bills, the quantity and the value cleared from 2104.
            receipts: { select: { id: true, grnLineId: true, qty: true, clearedValue: true } },
          },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
        returns: { select: { id: true, returnNo: true, status: true, grandTotal: true } },
        receivedGrn: { select: { id: true, docNo: true, noteDate: true } },
        purchaseOrder: { select: { id: true, orderNo: true, status: true } },
      },
    });
    if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
    // ADR-026 §2: a draft on an order shows the lines above the order price (what the approval covers).
    let priceAboveOrderLines: AbovePrice[] = [];
    if (inv.status === 'DRAFT' && inv.purchaseOrderId) {
      const order = await this.orders.forBilling(inv.purchaseOrderId);
      const received = await this.goodsNotes.receiptLinesOf(db, { lineIds: inv.lines.flatMap((l) => l.receipts.map((r) => r.grnLineId)) });
      priceAboveOrderLines = this.abovePrice(inv, order, received);
    }
    return { ...withBalance(inv, await this.creditedFor(db, [inv.id])), priceAboveOrderLines };
  }

  async create(dto: CreatePurchaseInvoiceDto, auditInTransaction = false) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    // ADR-026 §7: an invoice on a purchase order; another tenant's or branch's order answers 404.
    const order = dto.purchaseOrderId ? await this.orders.forBilling(BigInt(dto.purchaseOrderId)) : null;
    const pricesIncludeTax = await this.support.pricesIncludeTax(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    await this.assertHeader(db, companyId, dto, lines);
    this.assertReceiptLinksNeedOrder(order, lines);
    if (order) this.assertOrderHeader(order, dto);
    const costCenterId = dto.costCenterId ? BigInt(dto.costCenterId) : (order?.costCenterId ?? null);

    // Retried on a lock conflict: the transaction now share-locks the company row (ADR-025 §4).
    const inv = await this.support.withRetry(async () => {
      const noteIds = order ? await this.receiptNoteIds(this.linkedGrnLineIds(lines)) : [];
      return db.$transaction(async (tx) => {
        let received: Map<bigint, ReceiptLine> | null = null;
        if (order) {
          // ADR-026 §7/§10: billing an order's receipts is not a direct purchase.
          // The posting's lock order: company (shared) → the order → its GRNs →
          // their lines, so a draft and a posting never wait on each other in a cycle.
          received = await this.lockReceiptBilling(tx, tenantId, companyId, order.id, noteIds);
        } else {
          // ADR-025 §4: at MEDIUM / FULL a direct purchase needs purchase.direct (owners aside).
          await assertDirectPurchaseAllowed(tx, tenantId, companyId);
        }
        // Share-lock the header centre before the row that references it (ADR-024 §1.4).
        if (costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, costCenterId);
        const receivedGrnId = await this.checkDraftGrn(tx, tenantId, null, dto, lines);
        if (order && received) this.assertDraftReceipts(order.id, lines, received);
        const created = await tx.purchaseInvoice.create({
        data: {
          tenantId,
          companyId,
          // Branch from the request context (BranchGuard), never the body — ADR-003;
          // an invoice on an order is in the order's branch (ADR-026 §7).
          branchId: order?.branchId ?? currentBranchId(),
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          supplierId: BigInt(dto.supplierId),
          supplierInvoiceNo: dto.supplierInvoiceNo ?? null,
          supplierInvoiceDate: dto.supplierInvoiceDate ? new Date(dto.supplierInvoiceDate) : null,
          warehouseId: dto.warehouseId ? BigInt(dto.warehouseId) : null,
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          costCenterId,
          description: dto.description ?? null,
          pricesIncludeTax,
          receivedGrnId,
          purchaseOrderId: order?.id ?? null,
          ...this.totals(lines),
          createdBy: this.support.userId() ?? null,
        },
        });
        await this.writeLines(tx, tenantId, created.id, lines);
        if (auditInTransaction) {
          await this.audit.log({
            action: 'purchase_invoice.create',
            entityType: 'purchase_invoice',
            entityId: created.id,
            after: { lines: lines.length },
          }, tx);
        }
        return created;
      }, POSTING_TX_OPTIONS);
    });
    if (!auditInTransaction) {
      await this.audit.log({
        action: 'purchase_invoice.create',
        entityType: 'purchase_invoice',
        entityId: inv.id,
        after: { lines: lines.length },
      });
    }
    return this.get(inv.id);
  }

  async update(id: bigint, dto: CreatePurchaseInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const inv = await db.purchaseInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
    }
    assertBranchAllowed(inv.branchId);
    // ADR-026 §7: the order is set at creation and never changes.
    const orderId = dto.purchaseOrderId ? BigInt(dto.purchaseOrderId) : null;
    if (orderId !== inv.purchaseOrderId) {
      throw new DomainError(ErrorCode.VALIDATION, "An invoice's purchase order is set when it is created and never changes");
    }
    const order = orderId ? await this.orders.forBilling(orderId) : null;
    const pricesIncludeTax = await this.support.pricesIncludeTax(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    await this.assertHeader(db, companyId, dto, lines);
    this.assertReceiptLinksNeedOrder(order, lines);
    if (order) this.assertOrderHeader(order, dto);
    const costCenterId = dto.costCenterId ? BigInt(dto.costCenterId) : (order?.costCenterId ?? null);

    // Retried on a lock conflict, like posting.
    await this.support.withRetry(async () => {
      // The GRNs the draft bills now and will bill after the save, read before the transaction to lock them first.
      const noteIds = order
        ? await this.receiptNoteIds([...this.linkedGrnLineIds(lines), ...(await this.currentGrnLineIds(id))])
        : [];
      return db.$transaction(async (tx) => {
      // Locks in the posting's order, all locking reads ahead of the first plain read:
      //  - on an order (ADR-026 §10): company (shared) → the order → its GRNs →
      //    their lines → the invoice, the order postFromReceipts takes them in;
      //  - otherwise: the invoice, then the GRN it bills (TRADE-02, as post()).
      // A save racing a post of the same draft queues on the first shared lock
      // instead of deadlocking, and never rewrites a posted invoice.
      const received = order ? await this.lockReceiptBilling(tx, tenantId, companyId, order.id, noteIds) : null;
      const [locked] = await tx.$queryRaw<{ status: string; branch_id: bigint | null }[]>`
        SELECT status, branch_id FROM purchase_invoices WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
      if (!locked) throw DomainError.notFound('PurchaseInvoice', id.toString());
      if (locked.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
      }
      assertBranchAllowed(locked.branch_id === null ? null : BigInt(locked.branch_id));
      await this.documentLocks.requireHeld(tx, 'PURCHASE_INVOICE', id);
      // Share-lock the header centre before the row that references it (ADR-024 §1.4).
      if (costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, costCenterId);
      const receivedGrnId = await this.checkDraftGrn(tx, tenantId, id, dto, lines);
      if (order && received) this.assertDraftReceipts(order.id, lines, received);
      // Cascades to the lines' receipt links (purchase_invoice_receipts).
      await tx.purchaseInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.purchaseInvoice.update({
        where: { id },
        data: {
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          supplierId: BigInt(dto.supplierId),
          supplierInvoiceNo: dto.supplierInvoiceNo ?? null,
          supplierInvoiceDate: dto.supplierInvoiceDate ? new Date(dto.supplierInvoiceDate) : null,
          warehouseId: dto.warehouseId ? BigInt(dto.warehouseId) : null,
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          costCenterId,
          description: dto.description ?? null,
          pricesIncludeTax,
          receivedGrnId,
          // ADR-026 §2: an edit clears the approval of a price above the order.
          priceApprovedAt: null,
          priceApprovedBy: null,
          ...this.totals(lines),
          updatedBy: this.support.userId() ?? null,
        },
      });
      await this.writeLines(tx, tenantId, id, lines);
      }, POSTING_TX_OPTIONS);
    });
    await this.audit.log({
      action: 'purchase_invoice.update',
      entityType: 'purchase_invoice',
      entityId: id,
    });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    await db.$transaction(async (tx) => {
      // Locked and re-checked: a delete racing a post of the same draft never
      // deletes a posted invoice (and its GRN lines' billed quantities).
      const [inv] = await tx.$queryRaw<{ status: string; branch_id: bigint | null }[]>`
        SELECT status, branch_id FROM purchase_invoices WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
      if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
      if (inv.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be deleted');
      }
      assertBranchAllowed(inv.branch_id === null ? null : BigInt(inv.branch_id));
      await this.documentLocks.assertNotLockedByOther(tx, 'PURCHASE_INVOICE', id);
      await tx.purchaseInvoice.delete({ where: { id } });
    }, POSTING_TX_OPTIONS);
    return { deleted: true };
  }

  /** Posts: stock IN per STOCK line + inventory/purchases/tax journal (§8.4). */
  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    // ADR-026 §7: an invoice on a purchase order bills its receipts (set at creation, never changed).
    const head = await db.purchaseInvoice.findFirst({ where: { id }, select: { purchaseOrderId: true } });
    if (head?.purchaseOrderId) return this.postFromReceipts(id, head.purchaseOrderId);

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // ADR-025 §4: at MEDIUM / FULL a direct purchase needs purchase.direct
        // (owners aside). A shared lock on the company row, a locking read like
        // the ones below, so it does not open the snapshot early.
        await assertDirectPurchaseAllowed(tx, tenantId, companyId);
        // Lock the document first (§10.1 step 7), then the GRN it bills
        // (TRADE-02), both before the first plain read: every later read then
        // sees what was committed before both locks (see assertGrnBillable).
        const [head] = await tx.$queryRaw<{ received_grn_id: bigint | null }[]>`
          SELECT received_grn_id FROM purchase_invoices WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
        const lockedGrn =
          head?.received_grn_id != null ? await this.goodsNotes.lockForBilling(tx, BigInt(head.received_grn_id)) : null;
        const draft = await tx.purchaseInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('PurchaseInvoice', id.toString());
        await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        assertBranchAllowed(draft.branchId);
        await this.documentLocks.assertNotLockedByOther(tx, 'PURCHASE_INVOICE', id);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Invoice is not a draft');
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Invoice has no lines');
        }
        if (draft.paymentType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
        }

        const stockItems = await this.ledger.stockItemIds(tx, companyId, draft.lines.map((l) => l.itemId));
        const hasStock = stockItems.size > 0;
        if (hasStock && !draft.warehouseId) {
          throw new DomainError(ErrorCode.VALIDATION, 'warehouseId is required for stocked items');
        }
        if (draft.warehouseId) {
          const wh = await tx.warehouse.findFirst({
            where: { id: draft.warehouseId, companyId, isActive: true },
            select: { id: true },
          });
          if (!wh) throw DomainError.notFound('Warehouse', draft.warehouseId.toString());
        }

        const invoiceDate = new Date(draft.invoiceDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, invoiceDate);

        // TRADE-02 (ADR-016): an invoice billing a posted GRN receives no
        // stock: the GRN did. Its stock lines clear 2104 at the GRN's value,
        // and the price difference goes to INVENTORY_ADJUSTMENT.
        const grn = draft.receivedGrnId
          ? await this.receivedGrnValue(tx, tenantId, draft, lockedGrn, stockItems)
          : null;

        // Lock every (item, warehouse) in the fixed order before any movement
        // (no warehouse: a service-only invoice, checked above).
        const warehouseId = draft.warehouseId;
        if (warehouseId && !grn) {
          await this.ledger.lockForDocument(
            tx,
            companyId,
            draft.lines.map((l) => ({ itemId: l.itemId, warehouseId })),
          );
        }

        // Stock IN for STOCK lines at net cost per base unit.
        let stockNet = new Decimal(0);
        let serviceNet = new Decimal(0);
        let writeOff = new Decimal(0);
        for (const line of draft.lines) {
          if (stockItems.has(line.itemId) && grn) {
            stockNet = stockNet.plus(line.netAmount);
          } else if (stockItems.has(line.itemId)) {
            const unitCost = new Decimal(line.netAmount.toString()).div(line.qtyBase.toString());
            const res = await this.ledger.applyMovement(tx, companyId, {
              warehouseId: draft.warehouseId!,
              itemId: line.itemId,
              movementDate: invoiceDate,
              type: 'IN',
              qty: line.qtyBase.toString(),
              unitCost: unitCost.toString(),
              sourceType: SOURCE,
              sourceId: draft.id,
              sourceLineId: line.id,
              description: `Purchase invoice ${draft.id}`,
            });
            stockNet = stockNet.plus(line.netAmount);
            writeOff = writeOff.plus(res.writeOff);
          } else {
            serviceNet = serviceNet.plus(line.netAmount);
          }
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
          'INVENTORY_ADJUSTMENT',
          'GOODS_RECEIVED_NOT_INVOICED',
          'PURCHASES',
          'INPUT_TAX',
          'SUPPLIERS_CONTROL',
        ]);

        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const tax = draft.taxTotal;

        if (grn) {
          // Clear the GRN's value from 2104; the invoice's price difference
          // (positive: dearer than received) goes to INVENTORY_ADJUSTMENT.
          if (grn.cleared.gt(0)) {
            journalLines.push({
              accountId: mapping.GOODS_RECEIVED_NOT_INVOICED,
              debit: grn.cleared.toString(),
              description: `Goods received ${grn.docNo ?? grn.id}`,
            });
          }
          const difference = stockNet.minus(grn.cleared);
          if (difference.gt(0)) {
            journalLines.push({ accountId: mapping.INVENTORY_ADJUSTMENT, debit: difference.toString(), description: 'Invoice vs goods received' });
          } else if (difference.lt(0)) {
            journalLines.push({ accountId: mapping.INVENTORY_ADJUSTMENT, credit: difference.abs().toString(), description: 'Invoice vs goods received' });
          }
        } else if (stockNet.gt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY, debit: stockNet.toString() });
        }
        journalLines.push(
          ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
        );
        if (serviceNet.gt(0)) {
          journalLines.push({ accountId: mapping.PURCHASES, debit: serviceNet.toString() });
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.INPUT_TAX, debit: tax.toString() });
        }
        if (draft.paymentType === 'CASH') {
          journalLines.push({
            accountId: draft.cashAccountId!,
            credit: grand.toString(),
            description: 'Cash purchase',
          });
        } else {
          journalLines.push({
            accountId: mapping.SUPPLIERS_CONTROL,
            credit: grand.toString(),
            partyType: 'SUPPLIER',
            partyId: draft.supplierId,
            description: 'Credit purchase',
          });
        }

        const invoiceNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'PURCHASE_INVOICE', invoiceDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId: draft.branchId,
          entryDate: invoiceDate,
          fiscalPeriodId: period.id,
          sourceType: SOURCE,
          sourceId: draft.id,
          description: draft.description ?? `Purchase invoice ${invoiceNo}`,
          lines: journalLines,
          postedBy: userId ?? null,
          // ADR-024 §1.2: onto every income-statement line (expenses, cost, adjustments).
          costCenterId: draft.costCenterId,
          // ADR-024 §1.3: the document has a centre field, so a flagged line needs one.
          requireCostCenters: true,
        });

        await tx.purchaseInvoice.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            invoiceNo,
            journalEntryId: entry.id,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        await this.audit.log({
          action: 'purchase_invoice.post',
          entityType: 'purchase_invoice',
          entityId: draft.id,
          after: { invoiceNo },
        }, tx);
        return { id: draft.id, invoiceNo };
      }, POSTING_TX_OPTIONS),
    );

    return this.get(result.id);
  }

  // ------------------------------------------- invoices from receipts (ADR-026)

  /**
   * Posts an invoice on a purchase order (ADR-026 §7, ADR-016 §2): no stock
   * moves (its GRNs received the goods); each stocked line clears its GRN
   * line's value from 2104 pro rata, the last bill of a GRN line taking what
   * is left of it, so 2104 reaches exactly zero once everything received is
   * billed; the price difference goes to INVENTORY_ADJUSTMENT. Services, tax
   * and the supplier as in any invoice.
   *
   * Locks (ADR-026 §10): company (shared) → the order → its lines → the GRNs
   * → their lines → the invoice, all locking reads before the first plain
   * read. The GRNs are those the invoice's links name, read before the
   * transaction and checked again under the invoice's lock.
   */
  private async postFromReceipts(id: bigint, orderId: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    const result = await this.support.withRetry(async () => {
      const grnIds = await this.receiptNoteIds(await this.currentGrnLineIds(id));
      return db.$transaction(async (tx) => {
        const { order, received } = await this.lockReceiptBillingWithOrder(tx, tenantId, companyId, orderId, grnIds);
        await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
        const draft = await tx.purchaseInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' }, include: { receipts: { orderBy: { id: 'asc' } } } } },
        });
        if (!draft) throw DomainError.notFound('PurchaseInvoice', id.toString());
        assertBranchAllowed(draft.branchId);
        await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        await this.documentLocks.assertNotLockedByOther(tx, 'PURCHASE_INVOICE', id);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Invoice is not a draft');
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Invoice has no lines');
        }
        if (draft.paymentType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
        }
        // An edit between the read above and the invoice lock may name other GRNs: start again.
        for (const link of draft.lines.flatMap((l) => l.receipts)) {
          if (!received.has(link.grnLineId)) {
            throw new DomainError(ErrorCode.CONFLICT, 'The invoice changed while posting; try again');
          }
        }
        if (!(BILLABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
          throw new DomainError(ErrorCode.PURCHASE_ORDER_NOT_RECEIVED, `Nothing is received on purchase order ${order.orderNo ?? order.id}`, {
            status: order.status,
          });
        }
        if (draft.supplierId !== order.supplierId || draft.warehouseId !== order.warehouseId) {
          throw new DomainError(ErrorCode.VALIDATION, "An invoice on a purchase order has the order's supplier and warehouse");
        }

        const invoiceDate = new Date(draft.invoiceDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, invoiceDate);
        const stockItems = await this.ledger.stockItemIds(tx, companyId, draft.lines.map((l) => l.itemId));

        // Three-way match under the locks (ADR-026 §7): every stocked line bills
        // a posted GRN line of this order, within what it received and has not
        // billed yet; the order's received quantities never pass the order (§4).
        const billing = draft.lines.map((l) => ({
          lineNo: l.lineNo,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId,
          isStock: stockItems.has(l.itemId),
          qtyBase: new Decimal(l.qtyBase.toString()),
          links: l.receipts.map((r) => ({ grnLineId: r.grnLineId, qty: new Decimal(r.qty.toString()) })),
        }));
        this.assertReceiptMatch(order.id, billing, received);
        // ADR-026 §2: above the order price, only once the difference is approved.
        const above = this.abovePrice(draft, order, received);
        if (above.length > 0 && !draft.priceApprovedAt) {
          throw new DomainError(ErrorCode.PURCHASE_PRICE_ABOVE_ORDER, 'A line is priced above the purchase order: approve the difference first', {
            lines: above,
          });
        }

        // Pro-rata clearing, cumulative, in line order (ADR-026 §7): what a GRN
        // line has cleared once `billedAfter` of it is billed is
        // round3(value × billedAfter / received); each bill clears the step from
        // what was cleared before. Every step lies between 0 and what is left
        // (round3 is monotonic), and the bill that takes the last of the line
        // clears exactly value − Σ cleared, so 2104 ends at zero. A per-bill
        // round3 of value × qty / received could overshoot and leave a negative rest.
        const running = new Map([...received].map(([lineId, r]) => [lineId, { billed: r.billedQty, cleared: r.clearedValue }]));
        const perGrnLine = new Map<bigint, { qty: Decimal; cleared: Decimal }>();
        let cleared = new Decimal(0);
        let stockNet = new Decimal(0);
        let serviceNet = new Decimal(0);
        for (const line of draft.lines) {
          if (!stockItems.has(line.itemId)) {
            serviceNet = serviceNet.plus(line.netAmount);
            continue;
          }
          stockNet = stockNet.plus(line.netAmount);
          for (const link of line.receipts) {
            const r = received.get(link.grnLineId)!;
            const run = running.get(link.grnLineId)!;
            const qty = new Decimal(link.qty.toString());
            const billedAfter = run.billed.plus(qty);
            const value = clearedThrough(r.value, billedAfter, r.qty).minus(run.cleared);
            if (value.lt(0)) {
              // Unreachable while cleared_value is a projection of this rule (integrity check); refuse rather than post it.
              throw new DomainError(ErrorCode.INTERNAL, `GRN line ${r.id} would clear a negative value`);
            }
            run.billed = billedAfter;
            run.cleared = run.cleared.plus(value);
            const acc = perGrnLine.get(link.grnLineId) ?? { qty: new Decimal(0), cleared: new Decimal(0) };
            perGrnLine.set(link.grnLineId, { qty: acc.qty.plus(qty), cleared: acc.cleared.plus(value) });
            await tx.purchaseInvoiceReceipt.update({ where: { id: link.id }, data: { clearedValue: value } });
            cleared = cleared.plus(value);
          }
        }
        await this.goodsNotes.recordBilling(tx, perGrnLine);

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY_ADJUSTMENT',
          'GOODS_RECEIVED_NOT_INVOICED',
          'PURCHASES',
          'INPUT_TAX',
          'SUPPLIERS_CONTROL',
        ]);
        const docNos = [...new Set([...received.values()].filter((r) => perGrnLine.has(r.id)).map((r) => r.docNo ?? r.noteId.toString()))];
        const journalLines: JournalLineInput[] = [];
        if (cleared.gt(0)) {
          journalLines.push({
            accountId: mapping.GOODS_RECEIVED_NOT_INVOICED,
            debit: cleared.toString(),
            description: `Goods received ${docNos.join(', ')}`,
          });
        }
        // ADR-016 §2: the price difference (positive: dearer than received) to INVENTORY_ADJUSTMENT.
        const difference = stockNet.minus(cleared);
        if (difference.gt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY_ADJUSTMENT, debit: difference.toString(), description: 'Invoice vs goods received' });
        } else if (difference.lt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY_ADJUSTMENT, credit: difference.abs().toString(), description: 'Invoice vs goods received' });
        }
        if (serviceNet.gt(0)) {
          journalLines.push({ accountId: mapping.PURCHASES, debit: serviceNet.toString() });
        }
        if (draft.taxTotal.gt(0)) {
          journalLines.push({ accountId: mapping.INPUT_TAX, debit: draft.taxTotal.toString() });
        }
        if (draft.paymentType === 'CASH') {
          journalLines.push({ accountId: draft.cashAccountId!, credit: draft.grandTotal.toString(), description: 'Cash purchase' });
        } else {
          journalLines.push({
            accountId: mapping.SUPPLIERS_CONTROL,
            credit: draft.grandTotal.toString(),
            partyType: 'SUPPLIER',
            partyId: draft.supplierId,
            description: 'Credit purchase',
          });
        }

        const invoiceNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'PURCHASE_INVOICE', invoiceDate);
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId: draft.branchId,
          entryDate: invoiceDate,
          fiscalPeriodId: period.id,
          sourceType: SOURCE,
          sourceId: draft.id,
          description: draft.description ?? `Purchase invoice ${invoiceNo}`,
          lines: journalLines,
          postedBy: userId ?? null,
          // ADR-024 §1.2: onto every income-statement line (expenses, cost, adjustments).
          costCenterId: draft.costCenterId,
          // ADR-024 §1.3: the document has a centre field, so a flagged line needs one.
          requireCostCenters: true,
        });
        await tx.purchaseInvoice.update({
          where: { id: draft.id },
          data: { status: 'POSTED', invoiceNo, journalEntryId: entry.id, postedAt: new Date(), postedBy: userId ?? null },
        });
        await this.audit.log({
          action: 'purchase_invoice.post',
          entityType: 'purchase_invoice',
          entityId: draft.id,
          after: { invoiceNo, purchaseOrderId: orderId.toString() },
        }, tx);
        return { id: draft.id, invoiceNo };
      }, POSTING_TX_OPTIONS);
    });

    return this.get(result.id);
  }

  /**
   * ADR-026 §2: «approve the price difference» of a draft invoice on a
   * purchase order with a line above the order price. purchase.approve (the
   * route), no amount limit, never by the invoice's creator or last editor;
   * an owner always. An edit afterwards clears it.
   */
  async approvePrice(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await lockProcurementLevel(tx, tenantId, companyId);
        const [inv] = await tx.$queryRaw<
          { status: string; branch_id: bigint | null; purchase_order_id: bigint | null; created_by: bigint | null; updated_by: bigint | null }[]
        >`
          SELECT status, branch_id, purchase_order_id, created_by, updated_by FROM purchase_invoices
           WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
        if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
        assertBranchAllowed(inv.branch_id === null ? null : BigInt(inv.branch_id));
        await this.documentLocks.assertNotLockedByOther(tx, 'PURCHASE_INVOICE', id);
        if (inv.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only a draft invoice has a price to approve', {
            status: inv.status,
            action: 'approve-price',
          });
        }
        if (inv.purchase_order_id === null) {
          throw new DomainError(ErrorCode.VALIDATION, 'Only an invoice on a purchase order has an order price to compare with');
        }
        const draft = await tx.purchaseInvoice.findFirstOrThrow({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' }, include: { receipts: true } } },
        });
        const order = await this.orders.forBilling(BigInt(inv.purchase_order_id), tx);
        const received = await this.goodsNotes.receiptLinesOf(tx, { lineIds: draft.lines.flatMap((l) => l.receipts.map((r) => r.grnLineId)) });
        if (this.abovePrice(draft, order, received).length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'No line is priced above the purchase order');
        }
        const approver = await readApprover(tx, tenantId);
        const author = { created_by: inv.created_by === null ? null : BigInt(inv.created_by), updated_by: inv.updated_by === null ? null : BigInt(inv.updated_by), submitted_by: null };
        assertCanApprove({ ...approver, amount: null, isAuthor: isAuthor(author, approver.userId) });
        // An approval is not an edit: updated_by stays the last editor.
        await tx.purchaseInvoice.update({ where: { id }, data: { priceApprovedAt: new Date(), priceApprovedBy: approver.userId } });
        await this.audit.log({
          action: 'purchase_invoice.approve_price',
          entityType: 'purchase_invoice',
          entityId: id,
          after: { approvedBy: approver.userId?.toString() ?? null },
        }, tx);
      }, POSTING_TX_OPTIONS),
    );
    return this.get(id);
  }

  /**
   * POST /purchase-orders/:id/bill (ADR-026 §7): a draft invoice from the
   * order's posted receipts, one line per GRN line billed, in base units,
   * with the order's supplier, warehouse, cost centre and the order line's
   * tax category.
   */
  async bill(orderId: bigint, dto: BillPurchaseOrderDto) {
    const { db } = this.support.tenant();
    const order = await this.orders.forBilling(orderId);
    const received = await this.goodsNotes.receiptLinesOf(db, { lineIds: dto.lines.map((l) => BigInt(l.grnLineId)) });
    return this.create({
      invoiceDate: dto.invoiceDate,
      dueDate: dto.dueDate,
      supplierInvoiceNo: dto.supplierInvoiceNo,
      supplierInvoiceDate: dto.supplierInvoiceDate,
      paymentType: dto.paymentType,
      cashAccountId: dto.cashAccountId,
      costCenterId: dto.costCenterId,
      description: dto.description,
      supplierId: order.supplierId.toString(),
      warehouseId: order.warehouseId.toString(),
      purchaseOrderId: orderId.toString(),
      lines: dto.lines.map((l) => {
        const r = received.get(BigInt(l.grnLineId));
        if (!r || r.purchaseOrderId !== order.id) throw DomainError.notFound('GoodsNoteLine', l.grnLineId);
        const poLine = r.poLineId !== null ? order.lines.get(r.poLineId) : undefined;
        return {
          itemId: r.itemId.toString(),
          qty: l.qty,
          unitCost: l.unitCost,
          discountPct: l.discountPct,
          ...(poLine?.taxCategoryId ? { taxCategoryId: poLine.taxCategoryId.toString() } : {}),
          grnLineId: l.grnLineId,
        };
      }),
    }, true);
  }

  /**
   * GET /purchase-orders/:id/billable: the order's posted GRN lines with what
   * is received and billed, the order price and the default invoice price
   * per base unit (the order's, never above it), for the «Bill» screen.
   */
  async billable(orderId: bigint) {
    const { db } = this.support.tenant();
    const order = await this.orders.forBilling(orderId);
    const pricesIncludeTax = await this.support.pricesIncludeTax(db);
    const received = await this.goodsNotes.receiptLinesOf(db, { orderId });
    const items = await db.item.findMany({
      where: { id: { in: [...new Set([...received.values()].map((r) => r.itemId))] } },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const lines = [...received.values()].map((r) => {
      const poLine = r.poLineId !== null ? order.lines.get(r.poLineId) : undefined;
      const unbilled = r.qty.minus(r.billedQty);
      return {
        grnLineId: r.id.toString(),
        grnId: r.noteId.toString(),
        grnDocNo: r.docNo,
        item: itemById.get(r.itemId)!,
        poLineId: poLine?.id.toString() ?? null,
        poLineNo: poLine?.lineNo ?? null,
        receivedQty: r.qty.toString(),
        billedQty: r.billedQty.toString(),
        unbilledQty: unbilled.toString(),
        receiptUnitCost: r.unitCost.toString(),
        orderUnitPrice: poLine?.unitPrice.toString() ?? null,
        orderDiscountPct: poLine?.discountPct.toString() ?? null,
        orderNetUnitPrice: poLine ? round6(this.orderNetUnitPrice(order, poLine)).toString() : null,
        defaultUnitCost: poLine ? this.defaultUnitCost(order, poLine, pricesIncludeTax).toString() : r.unitCost.toString(),
        defaultDiscountPct: poLine?.discountPct.toString() ?? '0',
        taxCategoryId: poLine?.taxCategoryId?.toString() ?? null,
        taxRate: poLine?.taxRate.toString() ?? '0',
      };
    });
    return {
      orderId: order.id.toString(),
      orderNo: order.orderNo,
      status: order.status,
      supplierId: order.supplierId.toString(),
      warehouseId: order.warehouseId.toString(),
      costCenterId: order.costCenterId?.toString() ?? null,
      orderPricesIncludeTax: order.pricesIncludeTax,
      pricesIncludeTax,
      lines,
    };
  }

  // ------------------------------------------------------------- internals

  /** The lines, then the receipt links of the lines that bill a GRN line (ADR-026 §7, qty in base units). */
  private async writeLines(tx: Prisma.TransactionClient, tenantId: bigint, invoiceId: bigint, lines: ResolvedLine[]) {
    await tx.purchaseInvoiceLine.createMany({
      data: lines.map((l, i) => ({
        tenantId,
        invoiceId,
        lineNo: i + 1,
        itemId: l.itemId,
        itemUnitId: l.itemUnitId,
        qty: l.dto.qty,
        qtyBase: l.amounts.qtyBase,
        unitCost: l.dto.unitCost,
        discountPct: l.dto.discountPct ?? '0',
        discountAmount: l.amounts.discountAmount,
        netAmount: l.amounts.netAmount,
        taxCategoryId: l.taxCategoryId,
        taxRate: l.taxRate,
        taxAmount: l.amounts.taxAmount,
        lineTotal: l.amounts.lineTotal,
      })),
    });
    if (!lines.some((l) => l.dto.grnLineId)) return;
    const written = await tx.purchaseInvoiceLine.findMany({ where: { invoiceId }, select: { id: true, lineNo: true } });
    const idByNo = new Map(written.map((w) => [w.lineNo, w.id]));
    await tx.purchaseInvoiceReceipt.createMany({
      data: lines.flatMap((l, i) =>
        l.dto.grnLineId
          ? [{ tenantId, invoiceLineId: idByNo.get(i + 1)!, grnLineId: BigInt(l.dto.grnLineId), qty: l.amounts.qtyBase }]
          : [],
      ),
    });
  }

  /** ADR-026 §7: an invoice on an order has the order's supplier and warehouse, and bills no GRN as a whole. */
  private assertOrderHeader(order: BillingOrder, dto: CreatePurchaseInvoiceDto): void {
    if (dto.receivedGrnId) {
      throw new DomainError(ErrorCode.VALIDATION, 'An invoice on a purchase order bills its GRN lines, not receivedGrnId');
    }
    if (BigInt(dto.supplierId) !== order.supplierId) {
      throw new DomainError(ErrorCode.VALIDATION, "An invoice on a purchase order is from the order's supplier", {
        field: 'supplierId',
        orderSupplierId: order.supplierId.toString(),
      });
    }
    if (!dto.warehouseId || BigInt(dto.warehouseId) !== order.warehouseId) {
      throw new DomainError(ErrorCode.VALIDATION, "An invoice on a purchase order names the order's warehouse", {
        field: 'warehouseId',
        orderWarehouseId: order.warehouseId.toString(),
      });
    }
  }

  /** The GRN lines the lines of a draft name (ADR-026 §7). */
  private linkedGrnLineIds(lines: ResolvedLine[]): bigint[] {
    return lines.filter((l) => l.dto.grnLineId).map((l) => BigInt(l.dto.grnLineId!));
  }

  /** The GRN lines an invoice's saved lines bill now (plain read, before its transaction). */
  private async currentGrnLineIds(invoiceId: bigint): Promise<bigint[]> {
    const { db } = this.support.tenant();
    const links = await db.purchaseInvoiceReceipt.findMany({ where: { invoiceLine: { invoiceId } }, select: { grnLineId: true } });
    return links.map((l) => l.grnLineId);
  }

  /**
   * The goods notes holding these GRN lines, read before the transaction so
   * it can lock them first (a posted GRN line never moves to another note).
   */
  private async receiptNoteIds(grnLineIds: bigint[]): Promise<bigint[]> {
    if (grnLineIds.length === 0) return [];
    const { db } = this.support.tenant();
    const lines = await this.goodsNotes.receiptLinesOf(db, { lineIds: [...new Set(grnLineIds)] });
    return [...new Set([...lines.values()].map((l) => l.noteId))];
  }

  /**
   * ADR-026 §10, for every writer of an invoice on an order (create, update,
   * post): company (shared) → the order FOR UPDATE → its lines → the GRNs
   * (ascending) → their lines (ascending), all locking reads. The invoice row
   * comes after. Returns the locked order and GRN lines.
   */
  private async lockReceiptBillingWithOrder(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    orderId: bigint,
    noteIds: bigint[],
  ) {
    await lockProcurementLevel(tx, tenantId, companyId);
    const order = await this.orders.lockOrder(tx, orderId);
    const received = await this.goodsNotes.lockReceiptLines(tx, noteIds);
    return { order, received };
  }

  private async lockReceiptBilling(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    orderId: bigint,
    noteIds: bigint[],
  ): Promise<Map<bigint, ReceiptLine>> {
    return (await this.lockReceiptBillingWithOrder(tx, tenantId, companyId, orderId, noteIds)).received;
  }

  /** ADR-026 §7: a line bills a GRN line only on an invoice on a purchase order. */
  private assertReceiptLinksNeedOrder(order: BillingOrder | null, lines: ResolvedLine[]): void {
    if (!order && lines.some((l) => l.dto.grnLineId)) {
      throw new DomainError(ErrorCode.VALIDATION, 'grnLineId needs purchaseOrderId: only an invoice on a purchase order bills GRN lines', {
        field: 'grnLineId',
      });
    }
  }

  /**
   * Draft check of an invoice on an order (ADR-026 §3, §7) against the GRN
   * lines locked on the draft's transaction; posting checks it all again.
   */
  private assertDraftReceipts(orderId: bigint, lines: ResolvedLine[], received: Map<bigint, ReceiptLine>): void {
    if (lines.some((l) => l.dto.grnLineId && !isStocked(l.itemKind))) {
      throw new DomainError(ErrorCode.VALIDATION, 'Only a stocked line bills a GRN line');
    }
    this.assertReceiptMatch(
      orderId,
      lines.map((l, i) => ({
        lineNo: i + 1,
        itemId: l.itemId,
        itemUnitId: l.itemUnitId,
        isStock: isStocked(l.itemKind),
        qtyBase: l.amounts.qtyBase,
        links: l.dto.grnLineId ? [{ grnLineId: BigInt(l.dto.grnLineId), qty: l.amounts.qtyBase }] : [],
      })),
      received,
    );
  }

  /**
   * The three-way match (ADR-026 §3, §7): receive first (at least one GRN
   * line, and every stocked line bills one); each billed GRN line is a
   * posted receipt of this order for the same item, billed in base units;
   * and per GRN line the billed quantity stays within what it received and
   * has not billed yet. The order's received quantity never passes the order
   * (enforced when receiving, §4).
   */
  private assertReceiptMatch(
    orderId: bigint,
    lines: { lineNo: number; itemId: bigint; itemUnitId: bigint | null; isStock: boolean; qtyBase: Decimal; links: { grnLineId: bigint; qty: Decimal }[] }[],
    received: Map<bigint, ReceiptLine>,
  ): void {
    if (!lines.some((l) => l.links.length > 0)) {
      throw new DomainError(ErrorCode.PURCHASE_ORDER_NOT_RECEIVED, 'An invoice on a purchase order bills its posted receipts: receive the goods first');
    }
    const wanted = new Map<bigint, Decimal>();
    for (const l of lines) {
      if (l.isStock && l.links.length === 0) {
        throw new DomainError(ErrorCode.PURCHASE_ORDER_NOT_RECEIVED, `Line ${l.lineNo} bills no received goods: name its GRN line`, {
          lineNo: l.lineNo,
        });
      }
      if (l.links.length === 0) continue;
      if (l.itemUnitId !== null) {
        throw new DomainError(ErrorCode.VALIDATION, `Line ${l.lineNo} bills received goods in base units: no item unit`, { lineNo: l.lineNo });
      }
      const linked = sum(l.links.map((k) => k.qty));
      if (!linked.eq(l.qtyBase)) {
        throw new DomainError(ErrorCode.CONFLICT, 'The invoice changed while posting; try again');
      }
      for (const k of l.links) {
        const r = received.get(k.grnLineId);
        if (!r) throw DomainError.notFound('GoodsNoteLine', k.grnLineId.toString());
        if (r.noteType !== 'GRN' || r.noteStatus !== 'POSTED' || r.purchaseOrderId !== orderId) {
          throw new DomainError(ErrorCode.PURCHASE_ORDER_NOT_RECEIVED, `GRN line ${k.grnLineId} is not a posted receipt of this purchase order`, {
            grnLineId: k.grnLineId.toString(),
          });
        }
        if (r.itemId !== l.itemId) {
          throw new DomainError(ErrorCode.VALIDATION, `Line ${l.lineNo} is for another item than its GRN line`, {
            lineNo: l.lineNo,
            grnLineId: k.grnLineId.toString(),
          });
        }
        wanted.set(k.grnLineId, (wanted.get(k.grnLineId) ?? new Decimal(0)).plus(k.qty));
      }
    }
    for (const [grnLineId, qty] of wanted) {
      const r = received.get(grnLineId)!;
      const unbilled = r.qty.minus(r.billedQty);
      if (qty.gt(unbilled)) {
        throw new DomainError(
          ErrorCode.PURCHASE_BILL_EXCEEDS_RECEIPT,
          `GRN ${r.docNo ?? r.noteId} has ${unbilled.toFixed(6)} received and not billed on this line`,
          { grnLineId: grnLineId.toString(), unbilled: unbilled.toFixed(6), wanted: qty.toFixed(6) },
        );
      }
    }
  }

  /** The order line's net price per base unit (exact), on the order's own tax basis. */
  private orderNetUnitPrice(order: { pricesIncludeTax: boolean }, poLine: LockedOrderLine): Decimal {
    return netUnitPrice({
      unitPrice: poLine.unitPrice,
      discountPct: poLine.discountPct,
      factorToBase: poLine.factorToBase,
      taxRate: poLine.taxRate,
      pricesIncludeTax: order.pricesIncludeTax,
    });
  }

  /**
   * ADR-026 §2: the lines priced above their order line, comparing the net
   * price per base unit exactly (price less discount, per base unit, net of
   * tax when the price includes it); a lower or equal price passes.
   */
  private abovePrice(
    inv: {
      pricesIncludeTax: boolean;
      lines: { lineNo: number; unitCost: Num; discountPct: Num; taxRate: Num; receipts: { grnLineId: bigint }[] }[];
    },
    order: { pricesIncludeTax: boolean; lines: Map<bigint, LockedOrderLine> },
    received: Map<bigint, ReceiptLine>,
  ): AbovePrice[] {
    const out: AbovePrice[] = [];
    for (const line of inv.lines) {
      const invoiceNet = netUnitPrice({
        unitPrice: line.unitCost.toString(),
        discountPct: line.discountPct.toString(),
        factorToBase: 1,
        taxRate: line.taxRate.toString(),
        pricesIncludeTax: inv.pricesIncludeTax,
      });
      for (const link of line.receipts) {
        const poLineId = received.get(link.grnLineId)?.poLineId;
        const poLine = poLineId != null ? order.lines.get(poLineId) : undefined;
        if (!poLine) continue;
        const orderNet = this.orderNetUnitPrice(order, poLine);
        if (invoiceNet.gt(orderNet)) {
          out.push({
            lineNo: line.lineNo,
            grnLineId: link.grnLineId.toString(),
            invoiceNetUnitPrice: round6(invoiceNet).toFixed(6),
            orderNetUnitPrice: round6(orderNet).toFixed(6),
          });
        }
      }
    }
    return out;
  }

  /**
   * The invoice price per base unit an order line suggests: its price per
   * base unit, on the company's current tax basis, rounded DOWN to 6 dp so
   * the default is never above the order (ADR-026 §2).
   */
  private defaultUnitCost(order: { pricesIncludeTax: boolean }, poLine: LockedOrderLine, pricesIncludeTax: boolean): Decimal {
    let price = poLine.unitPrice.div(poLine.factorToBase);
    const factor = poLine.taxRate.div(100).plus(1);
    if (order.pricesIncludeTax && !pricesIncludeTax) price = price.div(factor);
    else if (!order.pricesIncludeTax && pricesIncludeTax) price = price.times(factor);
    return price.toDecimalPlaces(6, Decimal.ROUND_DOWN);
  }

  private totals(lines: ResolvedLine[]) {
    return {
      netTotal: sum(lines.map((l) => l.amounts.netAmount)),
      taxTotal: sum(lines.map((l) => l.amounts.taxAmount)),
      grandTotal: sum(lines.map((l) => l.amounts.lineTotal)),
    };
  }

  /**
   * Draft check of the GRN a purchase invoice bills (TRADE-02, ADR-016), on
   * the draft's own transaction: the GRN is posted, in the invoice's
   * warehouse, not billed by a posted invoice, and covers the invoice's stock
   * quantities. Posting checks it all again under the GRN's lock.
   */
  private async checkDraftGrn(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    invoiceId: bigint | null,
    dto: CreatePurchaseInvoiceDto,
    lines: ResolvedLine[],
  ): Promise<bigint | null> {
    if (!dto.receivedGrnId) return null;
    const grn = await this.goodsNotes.lockForBilling(tx, BigInt(dto.receivedGrnId));
    const qtyByItem = new Map<bigint, Decimal>();
    for (const l of lines) {
      if (!isStocked(l.itemKind)) continue;
      qtyByItem.set(l.itemId, (qtyByItem.get(l.itemId) ?? new Decimal(0)).plus(l.amounts.qtyBase));
    }
    await this.assertGrnBillable(tx, tenantId, invoiceId, grn, dto.receivedGrnId, dto.warehouseId ? BigInt(dto.warehouseId) : null, qtyByItem);
    return grn!.id;
  }

  /**
   * At posting: the GRN (locked FOR UPDATE at the start of the transaction,
   * so two invoices billing it queue there) checked again, and the value its
   * billed quantities clear from 2104 — the GRN's own value per item, pro
   * rata for a partial bill.
   */
  private async receivedGrnValue(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    draft: { id: bigint; receivedGrnId: bigint | null; warehouseId: bigint | null; lines: { itemId: bigint; qtyBase: { toString(): string } }[] },
    grn: GrnBillingSource | null,
    stockItems: Set<bigint>,
  ): Promise<{ id: bigint; docNo: string | null; cleared: Decimal }> {
    const grnId = draft.receivedGrnId!;
    const qtyByItem = new Map<bigint, Decimal>();
    for (const l of draft.lines) {
      if (!stockItems.has(l.itemId)) continue;
      qtyByItem.set(l.itemId, (qtyByItem.get(l.itemId) ?? new Decimal(0)).plus(l.qtyBase.toString()));
    }
    await this.assertGrnBillable(tx, tenantId, draft.id, grn, grnId.toString(), draft.warehouseId, qtyByItem);
    let cleared = new Decimal(0);
    for (const [itemId, qty] of qtyByItem) {
      const received = grn!.byItem.get(itemId)!;
      cleared = cleared.plus(qty.eq(received.qty) ? received.value : round3(received.value.times(qty).div(received.qty)));
    }
    return { id: grn!.id, docNo: grn!.docNo, cleared };
  }

  private async assertGrnBillable(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    invoiceId: bigint | null,
    grn: GrnBillingSource | null,
    grnId: string,
    warehouseId: bigint | null,
    qtyByItem: Map<bigint, Decimal>,
  ): Promise<void> {
    if (!grn) throw DomainError.notFound('GoodsNote', grnId);
    if (grn.noteType !== 'GRN' || grn.status !== 'POSTED') {
      throw new DomainError(ErrorCode.VALIDATION, 'receivedGrnId must be a posted goods receipt note');
    }
    // ADR-026 §7: a receipt against a purchase order is billed from that order, line by line.
    if (grn.purchaseOrderId !== null) {
      throw new DomainError(ErrorCode.VALIDATION, 'This goods receipt is against a purchase order: bill it from the order', {
        purchaseOrderId: grn.purchaseOrderId.toString(),
      });
    }
    if (warehouseId !== grn.warehouseId) {
      throw new DomainError(ErrorCode.VALIDATION, 'The invoice warehouse must be the warehouse the goods were received in');
    }
    // A plain read, on purpose. Every biller of this GRN holds its row lock
    // until commit, and each caller takes that lock before its transaction's
    // first plain read, so the snapshot already holds any invoice that billed
    // it. A locking read here would take a shared gap lock on
    // (tenant_id, received_grn_id) when nothing matches — the usual case — and
    // two drafts saved at once for different GRNs would deadlock on inserting
    // into that gap.
    const billed = await tx.purchaseInvoice.findMany({
      where: { tenantId, receivedGrnId: grn.id, status: 'POSTED', NOT: { id: invoiceId ?? 0n } },
      select: { id: true },
      take: 1,
    });
    if (billed.length > 0) {
      throw new DomainError(ErrorCode.GRN_ALREADY_INVOICED, `Goods receipt ${grn.docNo ?? grn.id} is already invoiced`);
    }
    for (const [itemId, qty] of qtyByItem) {
      const received = grn.byItem.get(itemId);
      if (!received || qty.gt(received.qty)) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Item ${itemId} on the invoice exceeds the goods received (${received?.qty.toString() ?? '0'})`,
        );
      }
    }
  }

  private async assertHeader(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    dto: CreatePurchaseInvoiceDto,
    lines: ResolvedLine[],
  ) {
    const supplier = await db.party.findFirst({
      where: { companyId, id: BigInt(dto.supplierId), isActive: true },
      select: { id: true, partyType: true },
    });
    if (!supplier || (supplier.partyType !== 'SUPPLIER' && supplier.partyType !== 'BOTH')) {
      throw new DomainError(ErrorCode.VALIDATION, 'Supplier not found or not a supplier');
    }
    const hasStock = lines.some((l) => isStocked(l.itemKind));
    if (hasStock) {
      if (!dto.warehouseId) {
        throw new DomainError(ErrorCode.VALIDATION, 'warehouseId is required for stocked items');
      }
      const wh = await db.warehouse.findFirst({
        where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
        select: { id: true, branchId: true },
      });
      if (!wh) throw DomainError.notFound('Warehouse', dto.warehouseId);
      assertBranchAllowed(wh.branchId);
    } else if (dto.warehouseId) {
      const wh = await db.warehouse.findFirst({
        where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
        select: { id: true, branchId: true },
      });
      if (!wh) throw DomainError.notFound('Warehouse', dto.warehouseId);
      assertBranchAllowed(wh.branchId);
    }
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
    dtos: PurchaseInvoiceLineDto[],
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
      assertNotRecipe(item.itemKind, item.code);

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
        unitPrice: l.unitCost,
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
        amounts,
      });
    }
    return out;
  }
}
