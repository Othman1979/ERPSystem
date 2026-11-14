import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal, sum } from '../../common/decimal/decimal.utils.js';
import {
  assertBranchAllowed,
  assertWarehouseBranchAllowed,
  branchWhere,
  currentBranchId,
} from '../../common/branch/branch-context.js';
import { findPage, mapPage } from '../../common/paging/find-page.js';
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
import { computeLineAmounts } from '../shared/invoice-math.js';
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
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { EInvoiceOutboxService } from '../einvoice/einvoice-outbox.service.js';
import type { CreateSalesInvoiceDto, ListSalesInvoicesQueryDto, SalesInvoiceLineDto } from './dto/sales.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';

const SOURCE = 'SALES_INVOICE';

interface ResolvedLine {
  dto: SalesInvoiceLineDto;
  itemId: bigint;
  itemUnitId: bigint | null;
  factorToBase: Decimal;
  itemKind: 'STOCK' | 'SERVICE';
  taxRate: Decimal;
  taxCategoryId: bigint | null;
  amounts: ReturnType<typeof computeLineAmounts>;
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
  ) {}

  onModuleInit(): void {
    this.partyUsage.register('sales', (tx, partyId) => this.partyInUse(tx, partyId));
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
    return null;
  }

  /** Posted credit-return totals for the given invoices (for `outstanding`). */
  private async creditedFor(
    db: ReturnType<DocumentSupportService['tenant']>['db'],
    invoiceIds: bigint[],
  ) {
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
         AND ${which}`;
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
    const where = { companyId, status: 'POSTED' as const, invoiceDate: { gte: range.from, lte: range.to } };
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
    const page = await findPage(db, pageWindow(query), {
      rows: (tx, window) =>
        tx.salesInvoice.findMany({
          where,
          include: {
            customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
            warehouse: { select: { id: true, code: true, nameAr: true } },
            _count: { select: { lines: true } },
          },
          orderBy,
          ...window,
        }),
      count: (tx) => tx.salesInvoice.count({ where }),
    });
    const credited = await this.creditedFor(db, page.items.map((r) => r.id));
    return mapPage(page, (rows) => rows.map((r) => withBalance(r, credited)));
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
    const pricesIncludeTax = await this.support.pricesIncludeTax(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    await this.assertHeader(db, companyId, dto);

    const inv = await db.$transaction(async (tx) => {
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
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
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
    const pricesIncludeTax = await this.support.pricesIncludeTax(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines, pricesIncludeTax);
    await this.assertHeader(db, companyId, dto);

    await db.$transaction(async (tx) => {
      // Lock the invoice and re-check it first: a save racing a post of the
      // same draft must not delete and rewrite the lines of a posted invoice.
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM sales_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      if (!locked || locked.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
      }
      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.salesInvoice.update({
        where: { id },
        data: {
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          customerId: BigInt(dto.customerId),
          warehouseId: BigInt(dto.warehouseId),
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          description: dto.description ?? null,
          pricesIncludeTax,
          ...this.totals(lines),
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
          qty: l.dto.qty,
          qtyBase: l.amounts.qtyBase,
          unitPrice: l.dto.unitPrice,
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
      action: 'sales_invoice.update',
      entityType: 'sales_invoice',
      entityId: id,
    });
    return this.get(id);
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

  /** Posts: stock OUT per line + revenue/tax/COGS journal (§8.4, §9). */
  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
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

        // Stock OUT for STOCK items — returns avg cost per base unit.
        let costTotal = new Decimal(0);
        let writeOff = new Decimal(0);
        const costByLine = new Map<bigint, { unitCost: Decimal; totalCost: Decimal }>();
        // Lock every (item, warehouse) in the fixed order before any movement.
        const stockItems = await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
        );
        for (const line of draft.lines) {
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
        ]);

        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const net = draft.netTotal;
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
        // Outbox (BUILD_PLAN §12.2): queued in this transaction, sent by the worker after it commits.
        await this.einvoice.enqueue(tx, {
          companyId,
          documentType: 'SALES_INVOICE',
          documentId: draft.id,
          documentNo: invoiceNo,
          branchId: draft.branchId,
        });
        return { id: draft.id, invoiceNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'sales_invoice.post',
      entityType: 'sales_invoice',
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
        amounts,
      });
    }
    return out;
  }
}
