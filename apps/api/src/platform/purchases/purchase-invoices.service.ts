import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal, round3, sum } from '../../common/decimal/decimal.utils.js';
import {
  assertBranchAllowed,
  branchSql,
  branchWhere,
  currentBranchId,
  assertWarehouseBranchAllowed,
} from '../../common/branch/branch-context.js';
import { findPage } from '../../common/paging/find-page.js';
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

const SOURCE = 'PURCHASE_INVOICE';

interface ResolvedLine {
  dto: PurchaseInvoiceLineDto;
  itemId: bigint;
  itemUnitId: bigint | null;
  factorToBase: Decimal;
  itemKind: 'STOCK' | 'SERVICE';
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
  ) {}

  onModuleInit(): void {
    this.partyUsage.register('purchases', (tx, partyId) => this.partyInUse(tx, partyId));
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
      SELECT supplier_id AS party_id, branch_id, status, payment_type, grand_total, paid_amount
        FROM purchase_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!inv) return null;
    const [credited] = await tx.$queryRaw<{ s: { toString(): string } | null }[]>`
      SELECT SUM(grand_total) AS s FROM purchase_returns
       WHERE tenant_id = ${tenantId} AND original_invoice_id = ${id}
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
           WHERE tenant_id = ${tenantId} AND status = 'POSTED' AND refund_type = 'CREDIT'
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
        const rows = await tx.purchaseInvoice.findMany({
          where,
          include: {
            supplier: { select: { id: true, code: true, nameAr: true, nameEn: true } },
            _count: { select: { lines: true } },
          },
          orderBy,
          ...window,
        });
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
          },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
        returns: { select: { id: true, returnNo: true, status: true, grandTotal: true } },
        receivedGrn: { select: { id: true, docNo: true, noteDate: true } },
      },
    });
    if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
    return withBalance(inv, await this.creditedFor(db, [inv.id]));
  }

  async create(dto: CreatePurchaseInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const pricesIncludeTax = await this.support.pricesIncludeTax(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    await this.assertHeader(db, companyId, dto, lines);

    const inv = await db.$transaction(async (tx) => {
      const receivedGrnId = await this.checkDraftGrn(tx, tenantId, null, dto, lines);
      const created = await tx.purchaseInvoice.create({
        data: {
          tenantId,
          companyId,
          // Branch from the request context (BranchGuard), never the body — ADR-003.
          branchId: currentBranchId(),
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          supplierId: BigInt(dto.supplierId),
          supplierInvoiceNo: dto.supplierInvoiceNo ?? null,
          supplierInvoiceDate: dto.supplierInvoiceDate ? new Date(dto.supplierInvoiceDate) : null,
          warehouseId: dto.warehouseId ? BigInt(dto.warehouseId) : null,
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          description: dto.description ?? null,
          pricesIncludeTax,
          receivedGrnId,
          ...this.totals(lines),
          createdBy: this.support.userId() ?? null,
        },
      });
      await tx.purchaseInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: created.id,
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
      return created;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'purchase_invoice.create',
      entityType: 'purchase_invoice',
      entityId: inv.id,
      after: { lines: lines.length },
    });
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
    const pricesIncludeTax = await this.support.pricesIncludeTax(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    await this.assertHeader(db, companyId, dto, lines);

    await db.$transaction(async (tx) => {
      // Lock the invoice first and re-check it under the lock, the order
      // posting follows (invoice, then GRN): a save racing a post of the same
      // draft queues here instead of deadlocking, and never rewrites a posted
      // invoice. A locking read, so the GRN lock below is still taken before
      // this transaction's first plain read (see assertGrnBillable).
      const [locked] = await tx.$queryRaw<{ status: string; branch_id: bigint | null }[]>`
        SELECT status, branch_id FROM purchase_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      if (!locked) throw DomainError.notFound('PurchaseInvoice', id.toString());
      if (locked.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
      }
      assertBranchAllowed(locked.branch_id === null ? null : BigInt(locked.branch_id));
      const receivedGrnId = await this.checkDraftGrn(tx, tenantId, id, dto, lines);
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
          description: dto.description ?? null,
          pricesIncludeTax,
          receivedGrnId,
          ...this.totals(lines),
          updatedBy: this.support.userId() ?? null,
        },
      });
      await tx.purchaseInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: id,
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
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'purchase_invoice.update',
      entityType: 'purchase_invoice',
      entityId: id,
    });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const inv = await db.purchaseInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be deleted');
    }
    assertBranchAllowed(inv.branchId);
    await db.purchaseInvoice.delete({ where: { id } });
    return { deleted: true };
  }

  /** Posts: stock IN per STOCK line + inventory/purchases/tax journal (§8.4). */
  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // Lock the document first (§10.1 step 7), then the GRN it bills
        // (TRADE-02), both before the first plain read: every later read then
        // sees what was committed before both locks (see assertGrnBillable).
        const [head] = await tx.$queryRaw<{ received_grn_id: bigint | null }[]>`
          SELECT received_grn_id FROM purchase_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const lockedGrn =
          head?.received_grn_id != null ? await this.goodsNotes.lockForBilling(tx, BigInt(head.received_grn_id)) : null;
        const draft = await tx.purchaseInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('PurchaseInvoice', id.toString());
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
        return { id: draft.id, invoiceNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'purchase_invoice.post',
      entityType: 'purchase_invoice',
      entityId: result.id,
      after: { invoiceNo: result.invoiceNo },
    });
    return this.get(result.id);
  }

  // ------------------------------------------------------------- internals

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
      if (l.itemKind !== 'STOCK') continue;
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
    const hasStock = lines.some((l) => l.itemKind === 'STOCK');
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
