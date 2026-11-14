import { Injectable } from '@nestjs/common';
import { Decimal, round3, sum } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, assertWarehouseBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { findPage } from '../../common/paging/find-page.js';
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
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type { CreatePurchaseReturnDto, ListPurchaseReturnsQueryDto } from './dto/purchases.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { computeReturnLines, returnedByLine } from '../shared/return-lines.js';
import { assertRefundType } from '../shared/refund-type.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';
import { GoodsNotesService } from '../goods-notes/goods-notes.service.js';

const SOURCE = 'PURCHASE_RETURN';

/**
 * ADR-016 §5 (owner, 2026-11-14): a purchase return's goods leave from the
 * original invoice's warehouse, where they came in (a GRN-billed invoice
 * already names its GRN's warehouse). A service-only invoice has no
 * warehouse, so nothing is checked there: no goods move.
 */
function assertReturnWarehouse(invoiceWarehouseId: bigint | null, warehouseId: bigint): void {
  if (invoiceWarehouseId !== null && invoiceWarehouseId !== warehouseId) {
    throw new DomainError(
      ErrorCode.RETURN_WAREHOUSE_MISMATCH,
      "A purchase return leaves from the original invoice's warehouse",
      { warehouseId: warehouseId.toString(), invoiceWarehouseId: invoiceWarehouseId.toString() },
    );
  }
}

/**
 * Purchase returns linked to a posted invoice (§7.7, §8.4, §9.5). Return qty
 * is in BASE units of the original line. Posting: stock OUT at the original
 * purchase cost + journal Dr supplier/cash, Cr inventory/purchases/input-tax.
 */
@Injectable()
export class PurchaseReturnsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly goodsNotes: GoodsNotesService,
  ) {}

  /**
   * Posted returns dated in the range (both ends inclusive), added up by
   * day, month, supplier, item or (tax category, rate) — the Phase 8 sales /
   * purchases / tax summaries and the dashboard. Header totals for day,
   * month and party; line amounts for item and tax (a header's totals are
   * the sums of its lines).
   */
  async summary(range: SummaryRange, groupBy: SummaryGroupBy): Promise<DocumentSummaryRow[]> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    // A return belongs to its original invoice's branch (ADR-003 §12). `where` also
    // filters the line groupBys through `purchaseReturn: where`, if any.
    const where = {
      companyId,
      status: 'POSTED' as const,
      returnDate: { gte: range.from, lte: range.to },
      AND: [{ originalInvoice: branchWhere() }],
    };
    if (groupBy === 'day' || groupBy === 'month') {
      const groups = await db.purchaseReturn.groupBy({
        by: ['returnDate'],
        where,
        _sum: { netTotal: true, taxTotal: true, grandTotal: true },
        _count: { _all: true },
      });
      const days = groups.map((g) =>
        summaryRow(dayKey(g.returnDate), g._count._all, {
          net: g._sum.netTotal,
          tax: g._sum.taxTotal,
          grand: g._sum.grandTotal,
        }),
      );
      return groupBy === 'month' ? foldMonths(days) : days;
    }
    if (groupBy === 'party') {
      const groups = await db.purchaseReturn.groupBy({
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
    const lines = { purchaseReturn: where };
    if (groupBy === 'item') {
      const groups = await db.purchaseReturnLine.groupBy({
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
    const groups = await db.purchaseReturnLine.groupBy({
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
   * `q` matches the return number, the original invoice number and the supplier's
   * code and names. The caller's branches are those of the original invoice (ADR-003 §10).
   */
  async list(query: ListPurchaseReturnsQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.PurchaseReturnWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplierId ? { supplierId: BigInt(query.supplierId) } : {}),
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
                { supplier: { code: { contains: q } } },
                { supplier: { nameAr: { contains: q } } },
                { supplier: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'returnDate' | 'returnNo' | 'grandTotal', Prisma.PurchaseReturnOrderByWithRelationInput>(
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
      rows: (tx, window) =>
        tx.purchaseReturn.findMany({
          where,
          include: {
            supplier: { select: { id: true, code: true, nameAr: true, nameEn: true } },
            originalInvoice: { select: { id: true, invoiceNo: true } },
            _count: { select: { lines: true } },
          },
          orderBy,
          ...window,
        }),
      count: (tx) => tx.purchaseReturn.count({ where }),
    });
  }

  /** One return; a return of another branch's invoice answers 404 (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const ret = await db.purchaseReturn.findFirst({
      where: { id, AND: [{ originalInvoice: branchWhere() }] },
      include: {
        supplier: true,
        originalInvoice: { select: { id: true, invoiceNo: true, invoiceDate: true } },
        warehouse: { select: { id: true, code: true, nameAr: true } },
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            item: { select: { id: true, code: true, nameAr: true } },
            originalLine: { select: { id: true, lineNo: true, qty: true, qtyBase: true } },
          },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
      },
    });
    if (!ret) throw DomainError.notFound('PurchaseReturn', id.toString());
    return ret;
  }

  async create(dto: CreatePurchaseReturnDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);

    const warehouse = await db.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);

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
      await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE tenant_id = ${tenantId} AND id = ${BigInt(dto.originalInvoiceId)} FOR UPDATE`;
      const invoice = await tx.purchaseInvoice.findFirst({
        where: { id: BigInt(dto.originalInvoiceId), companyId },
        include: { lines: true },
      });
      if (!invoice) throw DomainError.notFound('PurchaseInvoice', dto.originalInvoiceId);
      if (invoice.status !== 'POSTED') {
        throw new DomainError(ErrorCode.VALIDATION, 'Returns require a posted invoice');
      }
      // A return belongs to its original invoice's branch (ADR-003, TRADE-11).
      assertBranchAllowed(invoice.branchId);
      assertReturnWarehouse(invoice.warehouseId, warehouse.id);
      assertRefundType(invoice.paymentType, dto.refundType);
      // Drafts reserve their quantity too.
      const prior = await tx.purchaseReturnLine.findMany({
        where: { tenantId, originalLine: { invoiceId: invoice.id } },
        select: { originalLineId: true, qtyBase: true, discountAmount: true, netAmount: true, taxAmount: true },
      });
      const resolved = computeReturnLines(invoice.lines, dto.lines, returnedByLine(prior));
      const totals = {
        netTotal: sum(resolved.map((r) => r.netAmount)),
        taxTotal: sum(resolved.map((r) => r.taxAmount)),
        grandTotal: sum(resolved.map((r) => r.lineTotal)),
      };
      const created = await tx.purchaseReturn.create({
        data: {
          tenantId,
          companyId,
          returnDate: new Date(dto.returnDate),
          originalInvoiceId: invoice.id,
          supplierId: invoice.supplierId,
          warehouseId: warehouse.id,
          refundType: dto.refundType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          reason: dto.reason ?? null,
          ...totals,
          createdBy: this.support.userId() ?? null,
        },
      });
      await tx.purchaseReturnLine.createMany({
        data: resolved.map((r, i) => ({
          tenantId,
          returnId: created.id,
          lineNo: i + 1,
          originalLineId: r.orig.id,
          itemId: r.orig.itemId,
          qty: r.qty,
          qtyBase: r.qtyBase,
          unitCost: r.orig.unitCost,
          discountPct: r.orig.discountPct,
          discountAmount: r.discountAmount,
          netAmount: r.netAmount,
          taxCategoryId: r.orig.taxCategoryId,
          taxRate: r.orig.taxRate,
          taxAmount: r.taxAmount,
          lineTotal: r.lineTotal,
        })),
      });
      return { ret: created, invoiceId: invoice.id };
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'purchase_return.create',
      entityType: 'purchase_return',
      entityId: ret.id,
      after: { originalInvoiceId: invoiceId },
    });
    return this.get(ret.id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const ret = await db.purchaseReturn.findFirst({ where: { id } });
    if (!ret) throw DomainError.notFound('PurchaseReturn', id.toString());
    if (ret.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft returns can be deleted');
    }
    const original = await db.purchaseInvoice.findFirst({
      where: { id: ret.originalInvoiceId },
      select: { branchId: true },
    });
    assertBranchAllowed(original?.branchId);
    await db.purchaseReturn.delete({ where: { id } });
    return { deleted: true };
  }

  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    // The original invoice never changes on a return: read it first to lock it first.
    const head = await db.purchaseReturn.findFirst({ where: { id }, select: { originalInvoiceId: true } });
    if (!head) throw DomainError.notFound('PurchaseReturn', id.toString());

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // Lock the original invoice, then the return (§10.1 step 7), the order
        // every return path and voucher allocation follows. Every return of
        // the invoice is created and posted under the invoice lock (TRADE-01),
        // and as locking reads ahead of any plain read they make the reads
        // below see the latest committed state.
        await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE tenant_id = ${tenantId} AND id = ${head.originalInvoiceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM purchase_returns WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const draft = await tx.purchaseReturn.findFirst({
          where: { id },
          include: {
            lines: {
              orderBy: { lineNo: 'asc' },
              include: { originalLine: { select: { netAmount: true, qtyBase: true } } },
            },
          },
        });
        if (!draft) throw DomainError.notFound('PurchaseReturn', id.toString());
        await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Return is not a draft');
        }
        // A return belongs to its original invoice's branch (ADR-003).
        const original = await tx.purchaseInvoice.findFirst({
          where: { id: draft.originalInvoiceId },
          select: {
            branchId: true,
            paymentType: true,
            receivedGrnId: true,
            warehouseId: true,
            lines: { select: { id: true, lineNo: true, qtyBase: true } },
          },
        });
        assertBranchAllowed(original?.branchId);
        // Again at posting: a draft saved before the rule may name another warehouse.
        if (original) assertReturnWarehouse(original.warehouseId, draft.warehouseId);
        if (original) assertRefundType(original.paymentType, draft.refundType);
        // TRADE-01: posted returns of the invoice plus this one stay within each line.
        const posted = await tx.purchaseReturnLine.findMany({
          where: { tenantId, purchaseReturn: { originalInvoiceId: draft.originalInvoiceId, status: 'POSTED' } },
          select: { originalLineId: true, qtyBase: true, discountAmount: true, netAmount: true, taxAmount: true },
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

        // An invoice that billed a GRN received no stock itself: its goods
        // entered at the GRN's cost and its price difference was booked to
        // INVENTORY_ADJUSTMENT (ADR-016 §2).
        const received = original?.receivedGrnId ? await this.goodsNotes.billingSource(tx, original.receivedGrnId) : null;

        // Split stock vs service portions for the journal.
        let stockNet = new Decimal(0);
        let serviceNet = new Decimal(0);
        let writeOff = new Decimal(0);
        let variance = new Decimal(0);
        for (const line of draft.lines) {
          if (stockItems.has(line.itemId)) {
            // TRADE-03 (§9.5, ADR-016 §3): the goods leave at the cost they
            // entered at, the value the journal takes off INVENTORY, not at
            // today's average: the original purchase line's cost, or for a
            // billed GRN the received cost, the line's share of the price
            // difference going back out of INVENTORY_ADJUSTMENT.
            const grnItem = received?.byItem.get(line.itemId);
            const qtyBase = new Decimal(line.qtyBase.toString());
            const cost = grnItem
              ? {
                  unitCost: grnItem.value.div(grnItem.qty),
                  totalCost: qtyBase.eq(grnItem.qty) ? grnItem.value : round3(grnItem.value.times(qtyBase).div(grnItem.qty)),
                }
              : {
                  unitCost: new Decimal(line.originalLine.netAmount.toString()).div(line.originalLine.qtyBase.toString()),
                  totalCost: new Decimal(line.netAmount.toString()),
                };
            const res = await this.ledger.applyMovement(tx, companyId, {
              warehouseId: draft.warehouseId,
              itemId: line.itemId,
              movementDate: returnDate,
              type: 'OUT',
              qty: line.qtyBase.toString(),
              unitCost: cost.unitCost,
              totalCost: cost.totalCost,
              sourceType: SOURCE,
              sourceId: draft.id,
              sourceLineId: line.id,
              description: `Purchase return ${draft.id}`,
            });
            stockNet = stockNet.plus(res.totalCost);
            variance = variance.plus(new Decimal(line.netAmount.toString()).minus(res.totalCost));
            writeOff = writeOff.plus(res.writeOff);
          } else {
            serviceNet = serviceNet.plus(line.netAmount);
          }
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
          'INVENTORY_ADJUSTMENT',
          'PURCHASES',
          'INPUT_TAX',
          'SUPPLIERS_CONTROL',
        ]);

        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const tax = draft.taxTotal;

        if (draft.refundType === 'CASH') {
          journalLines.push({
            accountId: draft.cashAccountId!,
            debit: grand.toString(),
            description: 'Cash refund from supplier',
          });
        } else {
          journalLines.push({
            accountId: mapping.SUPPLIERS_CONTROL,
            debit: grand.toString(),
            partyType: 'SUPPLIER',
            partyId: draft.supplierId,
            description: 'Purchase return (credit note)',
          });
        }
        if (stockNet.gt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY, credit: stockNet.toString() });
        }
        // Return of a billed GRN: the line's price difference reversed.
        if (variance.gt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY_ADJUSTMENT, credit: variance.toString(), description: 'Invoice vs goods received' });
        } else if (variance.lt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY_ADJUSTMENT, debit: variance.abs().toString(), description: 'Invoice vs goods received' });
        }
        if (serviceNet.gt(0)) {
          journalLines.push({ accountId: mapping.PURCHASES, credit: serviceNet.toString() });
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.INPUT_TAX, credit: tax.toString() });
        }
        journalLines.push(
          ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
        );

        const returnNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'PURCHASE_RETURN', returnDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId: original?.branchId ?? null,
          entryDate: returnDate,
          fiscalPeriodId: period.id,
          sourceType: SOURCE,
          sourceId: draft.id,
          description: draft.reason ?? `Purchase return ${returnNo}`,
          lines: journalLines,
          postedBy: userId ?? null,
        });

        await tx.purchaseReturn.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            returnNo,
            journalEntryId: entry.id,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        return { id: draft.id, returnNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'purchase_return.post',
      entityType: 'purchase_return',
      entityId: result.id,
      after: { returnNo: result.returnNo },
    });
    return this.get(result.id);
  }
}
