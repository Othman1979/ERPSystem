import { Injectable } from '@nestjs/common';
import { currentCompanySqlFilter } from '../../common/cls/current-company.js';
import { isRecipe } from '../../common/inventory/item-kind.js';
import { Decimal, round3, sum } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, assertWarehouseBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { Prisma } from '../../generated/prisma/client.js';
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
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { lineDescription } from '../journal/line-description.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { EInvoiceOutboxService } from '../einvoice/einvoice-outbox.service.js';
import type { CreateSalesReturnDto, ListSalesReturnsQueryDto } from './dto/sales.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { computeReturnLines, returnedByLine } from '../shared/return-lines.js';
import { computeLineAmounts } from '../shared/invoice-math.js';
import { assertRefundType } from '../shared/refund-type.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';

const SOURCE = 'SALES_RETURN';

/**
 * Sales returns linked to a posted invoice (§7.6, §8.4). Return qty is in
 * BASE units of the original line. Amounts are proportional to the original
 * line. Posting: stock IN at original cost + reversal-style journal using
 * SALES_RETURNS / OUTPUT_TAX.
 */
@Injectable()
export class SalesReturnsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly einvoice: EInvoiceOutboxService,
    private readonly costCenters: CostCentersService,
  ) {}

  /**
   * Posted returns dated in the range (both ends inclusive), added up by
   * day, month, customer, item or (tax category, rate) — the Phase 8 sales /
   * purchases / tax summaries and the dashboard. Header totals for day,
   * month and party; line amounts for item and tax (a header's totals are
   * the sums of its lines).
   */
  async summary(range: SummaryRange, groupBy: SummaryGroupBy): Promise<DocumentSummaryRow[]> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    // A return belongs to its original invoice's branch (ADR-003 §12). `where` also
    // filters the line groupBys through `salesReturn: where`.
    const where = {
      companyId,
      status: 'POSTED' as const,
      returnDate: { gte: range.from, lte: range.to },
      AND: [{ originalInvoice: branchWhere() }],
    };
    if (groupBy === 'day' || groupBy === 'month') {
      const groups = await db.salesReturn.groupBy({
        by: ['returnDate'],
        where,
        _sum: { netTotal: true, taxTotal: true, grandTotal: true, costTotal: true },
        _count: { _all: true },
      });
      const days = groups.map((g) =>
        summaryRow(dayKey(g.returnDate), g._count._all, {
          net: g._sum.netTotal,
          tax: g._sum.taxTotal,
          grand: g._sum.grandTotal, cost: g._sum.costTotal,
        }),
      );
      return groupBy === 'month' ? foldMonths(days) : days;
    }
    if (groupBy === 'party') {
      const groups = await db.salesReturn.groupBy({
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
    const lines = { salesReturn: where };
    if (groupBy === 'item') {
      // Posting keeps a return's cost on its header only (lines' cost_total
      // stays 0), so a line's cost is re-derived the way posting computed it:
      // stock comes back at the original line's unit cost, round3(qty × cost).
      const rows = await db.salesReturnLine.findMany({
        where: lines,
        select: { itemId: true, qtyBase: true, netAmount: true, taxAmount: true, lineTotal: true, unitCost: true },
      });
      const byItem = new Map<bigint, { count: number; qty: Decimal; net: Decimal; tax: Decimal; grand: Decimal; cost: Decimal }>();
      for (const l of rows) {
        const g = byItem.get(l.itemId) ?? {
          count: 0,
          qty: new Decimal(0),
          net: new Decimal(0),
          tax: new Decimal(0),
          grand: new Decimal(0),
          cost: new Decimal(0),
        };
        byItem.set(l.itemId, g);
        g.count += 1;
        g.qty = g.qty.plus(l.qtyBase.toString());
        g.net = g.net.plus(l.netAmount.toString());
        g.tax = g.tax.plus(l.taxAmount.toString());
        g.grand = g.grand.plus(l.lineTotal.toString());
        if (l.unitCost) g.cost = g.cost.plus(round3(new Decimal(l.qtyBase.toString()).times(l.unitCost.toString())));
      }
      const refs = await itemRefs(db, [...byItem.keys()]);
      return [...byItem.entries()].map(([itemId, g]) =>
        summaryRow(itemId.toString(), g.count, g, { ref: refs.get(itemId.toString()) ?? null }),
      );
    }
    // By tax: base and tax only (line cost is not stored on returns, see above).
    const groups = await db.salesReturnLine.groupBy({
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

  /**
   * Numbered page of returns (ADR-022), newest first unless `sort` says otherwise.
   * `q` matches the return number, the original invoice number and the customer's
   * code and names. The caller's branches are those of the original invoice (ADR-003 §10).
   */
  async list(query: ListSalesReturnsQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.SalesReturnWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: BigInt(query.customerId) } : {}),
      ...(query.from || query.to
        ? {
            returnDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [
        { originalInvoice: branchWhere() },
        q
          ? {
              OR: [
                { returnNo: { contains: q } },
                { originalInvoice: { invoiceNo: { contains: q } } },
                { customer: { code: { contains: q } } },
                { customer: { nameAr: { contains: q } } },
                { customer: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'returnDate' | 'returnNo' | 'grandTotal', Prisma.SalesReturnOrderByWithRelationInput>(
      query.sort,
      '-returnDate',
      {
        returnDate: (dir) => ({ returnDate: dir }),
        returnNo: (dir) => ({ returnNo: dir }),
        grandTotal: (dir) => ({ grandTotal: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) =>
        withLineCounts(
          await tx.salesReturn.findMany({
            where,
            include: {
              customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
              originalInvoice: { select: { id: true, invoiceNo: true } },
            },
            orderBy,
            ...window,
          }),
          'returnId',
          // Line counts of this page only (see withLineCounts).
          (ids) => tx.salesReturnLine.groupBy({ by: ['returnId'], where: { returnId: { in: ids } }, _count: { _all: true } }),
        ),
      count: (tx) => tx.salesReturn.count({ where }),
    });
  }

  /** One return; a return of another branch's invoice answers 404 (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const ret = await db.salesReturn.findFirst({
      where: { id, AND: [{ originalInvoice: branchWhere() }] },
      include: {
        customer: true,
        originalInvoice: { select: { id: true, invoiceNo: true, invoiceDate: true } },
        warehouse: { select: { id: true, code: true, nameAr: true } },
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            item: { select: { id: true, code: true, nameAr: true } },
            originalLine: {
              select: { id: true, lineNo: true, qty: true, qtyBase: true, itemUnit: { select: { unit: { select: { nameAr: true } } } } },
            },
          },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
      },
    });
    if (!ret) throw DomainError.notFound('SalesReturn', id.toString());
    return { ...ret, einvoice: await this.einvoice.stateOf('SALES_RETURN', ret.id) };
  }

  /**
   * A posted return as JoFotara needs it (docs/decisions/0005 §6, §8): each
   * line with its ORIGINAL line number, unit and tax, amounts as posted.
   * Read by the e-invoice module (module boundary).
   */
  async einvoiceSource(id: bigint) {
    const { db } = this.support.tenant();
    return db.salesReturn.findFirst({
      where: { id, status: 'POSTED' },
      select: {
        id: true,
        returnNo: true,
        returnDate: true,
        reason: true,
        originalInvoiceId: true,
        grandTotal: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            qtyBase: true,
            unitPrice: true,
            discountAmount: true,
            netAmount: true,
            taxRate: true,
            taxAmount: true,
            originalLine: {
              select: {
                lineNo: true,
                qty: true,
                qtyBase: true,
                invoice: { select: { pricesIncludeTax: true } },
                item: { select: { nameAr: true } },
                taxCategory: { select: { einvoiceCode: true } },
              },
            },
          },
        },
      },
    });
  }

  async create(dto: CreateSalesReturnDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);

    if (dto.refundType === 'CASH' && !dto.cashAccountId) {
      throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash refunds');
    }
    if (dto.cashAccountId) {
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

    const { ret, invoiceId } = await db.$transaction(async (tx) => {
      // TRADE-01: lock the original invoice first. Every return of it is
      // created and posted under this lock, so the returned-so-far read below
      // (this transaction's first plain read) sees all of them.
      await tx.$queryRaw`SELECT id FROM sales_invoices WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${BigInt(dto.originalInvoiceId)} FOR UPDATE`;
      const invoice = await tx.salesInvoice.findFirst({
        where: { id: BigInt(dto.originalInvoiceId), companyId },
        include: { lines: true },
      });
      if (!invoice) throw DomainError.notFound('SalesInvoice', dto.originalInvoiceId);
      if (invoice.warehouseId !== null) {
        await this.ledger.consignmentSupplierOf(tx, companyId, invoice.warehouseId);
      }
      // Share-lock the header centre before the row that references it (ADR-024 §1.4).
      if (dto.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, BigInt(dto.costCenterId));
      if (invoice.status !== 'POSTED') {
        throw new DomainError(ErrorCode.VALIDATION, 'Returns require a posted invoice');
      }
      // A return belongs to its original invoice's branch (ADR-003, TRADE-11).
      assertBranchAllowed(invoice.branchId);
      assertRefundType(invoice.paymentType, dto.refundType);
      // Already-returned qty per original line (all statuses — drafts reserve qty).
      const prior = await tx.salesReturnLine.findMany({
        where: { tenantId, originalLine: { invoiceId: invoice.id } },
        select: {
          originalLineId: true,
          qtyBase: true,
          discountAmount: true,
          invoiceDiscountShare: true,
          netAmount: true,
          taxAmount: true,
        },
      });
      const resolved = computeReturnLines(invoice.lines, dto.lines, returnedByLine(prior));
      const totals = {
        netTotal: sum(resolved.map((r) => r.netAmount)),
        taxTotal: sum(resolved.map((r) => r.taxAmount)),
        grandTotal: sum(resolved.map((r) => r.lineTotal)),
      };
      // ADR-032 §11: a recipe comes back as revenue and tax only. Its line carries no unit cost, so no
      // cost is reversed or re-derived for it (stock never moved for a recipe).
      const recipeIds = new Set(
        (
          await tx.item.findMany({
            where: { companyId, id: { in: [...new Set(resolved.map((r) => r.orig.itemId))] } },
            select: { id: true, itemKind: true },
          })
        )
          .filter((i) => isRecipe(i.itemKind))
          .map((i) => i.id),
      );
      const created = await tx.salesReturn.create({
        data: {
          tenantId,
          companyId,
          returnDate: new Date(dto.returnDate),
          originalInvoiceId: invoice.id,
          customerId: invoice.customerId,
          warehouseId: invoice.warehouseId,
          refundType: dto.refundType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
          reason: dto.reason ?? null,
          ...totals,
          createdBy: this.support.userId() ?? null,
        },
      });
      await tx.salesReturnLine.createMany({
        data: resolved.map((r, i) => ({
          tenantId,
          returnId: created.id,
          lineNo: i + 1,
          originalLineId: r.orig.id,
          itemId: r.orig.itemId,
          qty: r.qty,
          qtyBase: r.qtyBase,
          unitPrice: r.orig.unitPrice,
          discountPct: r.orig.discountPct,
          discountAmount: r.discountAmount,
          invoiceDiscountShare: r.invoiceDiscountShare,
          netAmount: r.netAmount,
          taxCategoryId: r.orig.taxCategoryId,
          taxRate: r.orig.taxRate,
          taxAmount: r.taxAmount,
          lineTotal: r.lineTotal,
          unitCost: recipeIds.has(r.orig.itemId) ? null : r.orig.unitCost,
        })),
      });
      return { ret: created, invoiceId: invoice.id };
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'sales_return.create',
      entityType: 'sales_return',
      entityId: ret.id,
      after: { originalInvoiceId: invoiceId },
    });
    return this.get(ret.id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const ret = await db.salesReturn.findFirst({ where: { id } });
    if (!ret) throw DomainError.notFound('SalesReturn', id.toString());
    if (ret.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft returns can be deleted');
    }
    const original = await db.salesInvoice.findFirst({
      where: { id: ret.originalInvoiceId },
      select: { branchId: true },
    });
    assertBranchAllowed(original?.branchId);
    await db.salesReturn.delete({ where: { id } });
    return { deleted: true };
  }

  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    // The original invoice never changes on a return: read it first to lock it first.
    const head = await db.salesReturn.findFirst({ where: { id }, select: { originalInvoiceId: true } });
    if (!head) throw DomainError.notFound('SalesReturn', id.toString());

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // Lock the original invoice, then the return (§10.1 step 7), the order
        // every return path and voucher allocation follows. Every return of
        // the invoice is created and posted under the invoice lock (TRADE-01),
        // and as locking reads ahead of any plain read they make the reads
        // below see the latest committed state.
        await tx.$queryRaw`SELECT id FROM sales_invoices WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${head.originalInvoiceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM sales_returns WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
        const draft = await tx.salesReturn.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('SalesReturn', id.toString());
        await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Return is not a draft');
        }
        // A return belongs to its original invoice's branch (ADR-003).
        const original = await tx.salesInvoice.findFirst({
          where: { id: draft.originalInvoiceId },
          select: {
            branchId: true,
            paymentType: true,
            warehouseId: true,
            pricesIncludeTax: true,
            invoiceDiscountAmount: true,
            lines: {
              select: {
                id: true,
                lineNo: true,
                qty: true,
                qtyBase: true,
                unitPrice: true,
                discountPct: true,
                taxRate: true,
                netAmount: true,
                invoiceDiscountShare: true,
              },
            },
          },
        });
        assertBranchAllowed(original?.branchId);
        const consignmentSupplierId =
          original?.warehouseId === null || original?.warehouseId === undefined
            ? null
            : await this.ledger.consignmentSupplierOf(tx, companyId, original.warehouseId);
        if (original) assertRefundType(original.paymentType, draft.refundType);
        // TRADE-01: posted returns of the invoice plus this one stay within each line.
        const posted = await tx.salesReturnLine.findMany({
          where: { tenantId, salesReturn: { originalInvoiceId: draft.originalInvoiceId, status: 'POSTED' } },
          select: {
            originalLineId: true,
            qtyBase: true,
            discountAmount: true,
            invoiceDiscountShare: true,
            invoiceDiscountNetShare: true,
            netAmount: true,
            taxAmount: true,
          },
        });
        const postedByLine = returnedByLine(posted);
        for (const line of draft.lines) {
          const orig = original?.lines.find((l) => l.id === line.originalLineId);
          const taken = postedByLine.get(line.originalLineId)?.qtyBase ?? new Decimal(0);
          if (!orig || taken.plus(line.qtyBase.toString()).gt(orig.qtyBase.toString())) {
            throw new DomainError(
              ErrorCode.VALIDATION,
              `Return qty exceeds remaining qty for line ${orig?.lineNo ?? line.lineNo}`,
            );
          }
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Return has no lines');
        }
        const invoiceDiscountNetByReturnLine = new Map<bigint, Decimal>();
        if (original && original.invoiceDiscountAmount.gt(0)) {
          for (const line of draft.lines) {
            const orig = original.lines.find((candidate) => candidate.id === line.originalLineId);
            if (!orig || orig.invoiceDiscountShare.isZero()) continue;
            const preDiscountNet = computeLineAmounts({
              qty: orig.qty,
              factorToBase: '1',
              unitPrice: orig.unitPrice,
              discountPct: orig.discountPct,
              taxRate: orig.taxRate,
              pricesIncludeTax: original.pricesIncludeTax,
            }).netAmount;
            const totalNetDiscountShare = round3(preDiscountNet.minus(orig.netAmount));
            const postedForLine = posted.filter((returned) => returned.originalLineId === orig.id);
            const priorQty = sum(postedForLine.map((returned) => returned.qtyBase));
            const priorNetShare = sum(postedForLine.map((returned) => returned.invoiceDiscountNetShare));
            const completesLine = priorQty.plus(line.qtyBase).eq(orig.qtyBase);
            const netShare = completesLine
              ? round3(totalNetDiscountShare.minus(priorNetShare))
              : round3(totalNetDiscountShare.times(line.qtyBase).div(orig.qtyBase));
            invoiceDiscountNetByReturnLine.set(line.id, netShare);
            await tx.salesReturnLine.update({
              where: { tenantId_id: { tenantId, id: line.id } },
              data: { invoiceDiscountNetShare: netShare },
            });
          }
        }
        const invoiceDiscountNetTotal = sum([...invoiceDiscountNetByReturnLine.values()]);
        await this.einvoice.assertReturnSendable(tx, companyId, {
          originalInvoiceId: draft.originalInvoiceId,
          reason: draft.reason,
        });
        if (draft.refundType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash refunds');
        }

        const returnDate = new Date(draft.returnDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, returnDate);

        // Lock every (item, warehouse) in the fixed order before any movement.
        const stockItems = await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
        );
        if (consignmentSupplierId !== null) {
          const originalLineIds = [...new Set(draft.lines.map((line) => line.originalLineId))];
          const sales = await tx.$queryRaw<{
            id: bigint;
            source_line_id: bigint;
            qty: Prisma.Decimal;
            returned_qty: Prisma.Decimal;
            invoiced_qty: Prisma.Decimal;
          }[]>`
            SELECT id, source_line_id, qty, returned_qty, invoiced_qty
              FROM consignment_sales
             WHERE tenant_id = ${tenantId} AND company_id = ${companyId}
               AND source_type = 'SALES_INVOICE'
               AND source_line_id IN (${Prisma.join(originalLineIds)})
             ORDER BY id FOR UPDATE`;
          const saleByLine = new Map(
            sales.map((sale) => [
              sale.source_line_id,
              {
                id: sale.id,
                qty: sale.qty,
                returnedQty: sale.returned_qty,
                invoicedQty: sale.invoiced_qty,
              },
            ]),
          );
          for (const line of draft.lines) {
            if (!stockItems.has(line.itemId)) continue;
            const sale = saleByLine.get(line.originalLineId);
            if (!sale) throw DomainError.notFound('ConsignmentSale', line.originalLineId.toString());
            const openQty = new Decimal(sale.qty.toString())
              .minus(sale.returnedQty.toString())
              .minus(sale.invoicedQty.toString());
            if (line.qtyBase.gt(openQty)) {
              throw new DomainError(
                ErrorCode.CONSIGNMENT_ALREADY_INVOICED,
                'The returned quantity exceeds the unsold-to-supplier quantity',
              );
            }
            await tx.consignmentSale.update({
              where: { id: sale.id },
              data: { returnedQty: { increment: line.qtyBase } },
            });
          }
        }

        // Stock IN at ORIGINAL unit cost (§8.4, §9.5).
        let costTotal = new Decimal(0);
        let writeOff = new Decimal(0);
        for (const line of draft.lines) {
          if (!stockItems.has(line.itemId)) continue;
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.warehouseId,
            itemId: line.itemId,
            movementDate: returnDate,
            type: 'IN',
            qty: line.qtyBase.toString(),
            unitCost: consignmentSupplierId !== null ? '0' : line.unitCost?.toString(),
            sourceType: SOURCE,
            sourceId: draft.id,
            sourceLineId: line.id,
            description: `Sales return ${draft.id}`,
          });
          costTotal = costTotal.plus(res.totalCost);
          writeOff = writeOff.plus(res.writeOff);
        }
        if (consignmentSupplierId !== null && (!costTotal.isZero() || !writeOff.isZero())) {
          throw new DomainError(ErrorCode.INTERNAL, 'Temporary-warehouse returns must have zero cost');
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'SALES_RETURNS',
          'OUTPUT_TAX',
          'CUSTOMERS_CONTROL',
          ...(consignmentSupplierId === null
            ? (['COGS', 'INVENTORY', 'INVENTORY_ADJUSTMENT'] as const)
            : []),
          ...(!invoiceDiscountNetTotal.isZero() ? ['SALES_DISCOUNTS' as const] : []),
        ]);

        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const net = draft.netTotal.plus(invoiceDiscountNetTotal);
        const tax = draft.taxTotal;

        if (net.gt(0)) {
          journalLines.push({ accountId: mapping.SALES_RETURNS, debit: net.toString() });
        }
        if (invoiceDiscountNetTotal.gt(0)) {
          journalLines.push({
            accountId: mapping.SALES_DISCOUNTS,
            credit: invoiceDiscountNetTotal.toString(),
          });
        } else if (invoiceDiscountNetTotal.lt(0)) {
          journalLines.push({
            accountId: mapping.SALES_DISCOUNTS,
            debit: invoiceDiscountNetTotal.abs().toString(),
          });
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.OUTPUT_TAX, debit: tax.toString() });
        }
        if (draft.refundType === 'CASH') {
          journalLines.push({
            accountId: draft.cashAccountId!,
            credit: grand.toString(),
            description: lineDescription('journal.line.cashRefund'),
          });
        } else {
          journalLines.push({
            accountId: mapping.CUSTOMERS_CONTROL,
            credit: grand.toString(),
            partyType: 'CUSTOMER',
            partyId: draft.customerId,
            description: lineDescription('journal.line.creditNote'),
          });
        }
        if (consignmentSupplierId !== null) {
          if (!costTotal.isZero() || !writeOff.isZero()) {
            throw new DomainError(ErrorCode.INTERNAL, 'Temporary-warehouse returns must have zero cost');
          }
        } else {
          if (costTotal.gt(0)) {
            journalLines.push({ accountId: mapping.INVENTORY, debit: costTotal.toString() });
            journalLines.push({ accountId: mapping.COGS, credit: costTotal.toString() });
          }
          journalLines.push(
            ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
          );
        }

        const returnNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'SALES_RETURN', returnDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId: original?.branchId ?? null,
          entryDate: returnDate,
          fiscalPeriodId: period.id,
          sourceType: SOURCE,
          sourceId: draft.id,
          description: draft.reason ?? `Sales return ${returnNo}`,
          descriptionKey: draft.reason == null ? 'journal.auto.salesReturn' : null,
          descriptionParams: draft.reason == null ? { number: returnNo } : undefined,
          lines: journalLines,
          postedBy: userId ?? null,
          // ADR-024 §1.2: onto the returns and cost lines (income statement).
          costCenterId: draft.costCenterId,
          // ADR-024 §1.3: the document has a centre field, so a flagged line needs one.
          requireCostCenters: true,
        });

        await tx.salesReturn.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            returnNo,
            costTotal,
            journalEntryId: entry.id,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        // Outbox (BUILD_PLAN §12.2); sent only after its original invoice is accepted.
        await this.einvoice.enqueue(tx, {
          companyId,
          documentType: 'SALES_RETURN',
          documentId: draft.id,
          documentNo: returnNo,
          branchId: original?.branchId ?? null,
          originalInvoiceId: draft.originalInvoiceId,
        });
        await this.audit.log({
          action: 'sales_return.post',
          entityType: 'sales_return',
          entityId: draft.id,
          after: { returnNo },
        }, tx);
        return { id: draft.id, returnNo };
      }, POSTING_TX_OPTIONS),
    );

    return this.get(result.id);
  }
}
