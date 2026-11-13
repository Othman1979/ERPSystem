import { Injectable } from '@nestjs/common';
import { Decimal, round3, sum } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, assertWarehouseBranchAllowed } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
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
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type { CreatePurchaseReturnDto } from './dto/purchases.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';

const SOURCE = 'PURCHASE_RETURN';

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
    const where = { companyId, status: 'POSTED' as const, returnDate: { gte: range.from, lte: range.to } };
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

  async list(status?: string) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.purchaseReturn.findMany({
      where: { companyId, ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}) },
      include: {
        supplier: { select: { id: true, code: true, nameAr: true } },
        originalInvoice: { select: { id: true, invoiceNo: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ returnDate: 'desc' }, { id: 'desc' }],
      take: 300,
    });
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const ret = await db.purchaseReturn.findFirst({
      where: { id },
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

    const invoice = await db.purchaseInvoice.findFirst({
      where: { id: BigInt(dto.originalInvoiceId), companyId },
      include: { lines: true },
    });
    if (!invoice) throw DomainError.notFound('PurchaseInvoice', dto.originalInvoiceId);
    if (invoice.status !== 'POSTED') {
      throw new DomainError(ErrorCode.VALIDATION, 'Returns require a posted invoice');
    }

    const warehouse = await db.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);

    const priorReturns = await db.purchaseReturnLine.findMany({
      where: { tenantId, originalLine: { invoiceId: invoice.id } },
      select: { originalLineId: true, qtyBase: true },
    });
    const returnedByLine = new Map<bigint, Decimal>();
    for (const r of priorReturns) {
      returnedByLine.set(
        r.originalLineId,
        (returnedByLine.get(r.originalLineId) ?? new Decimal(0)).plus(r.qtyBase),
      );
    }

    const origById = new Map(invoice.lines.map((l) => [l.id, l]));
    // Each original line at most once per return: the remaining-qty check below
    // only counts earlier returns, so a repeated line would slip past it.
    const seenLines = new Set<bigint>();
    const resolved = dto.lines.map((l, i) => {
      const orig = origById.get(BigInt(l.originalLineId));
      if (!orig) {
        throw new DomainError(ErrorCode.VALIDATION, `Line ${i + 1}: originalLineId not on this invoice`);
      }
      if (seenLines.has(orig.id)) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Line ${i + 1}: invoice line ${orig.lineNo} appears more than once in this return`,
        );
      }
      seenLines.add(orig.id);
      const qtyBase = new Decimal(l.qty);
      if (qtyBase.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Return qty must be > 0');
      const already = returnedByLine.get(orig.id) ?? new Decimal(0);
      const remaining = new Decimal(orig.qtyBase.toString()).minus(already);
      if (qtyBase.gt(remaining)) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Return qty exceeds remaining qty for line ${orig.lineNo} (remaining ${remaining.toString()})`,
        );
      }
      const ratio = qtyBase.div(orig.qtyBase.toString());
      const netAmount = round3(new Decimal(orig.netAmount.toString()).times(ratio));
      const taxAmount = round3(new Decimal(orig.taxAmount.toString()).times(ratio));
      return { dto: l, orig, qtyBase, netAmount, taxAmount, lineTotal: netAmount.plus(taxAmount) };
    });

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

    const totals = {
      netTotal: sum(resolved.map((r) => r.netAmount)),
      taxTotal: sum(resolved.map((r) => r.taxAmount)),
      grandTotal: sum(resolved.map((r) => r.lineTotal)),
    };

    const ret = await db.$transaction(async (tx) => {
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
          qty: r.qtyBase,
          qtyBase: r.qtyBase,
          unitCost: r.orig.unitCost,
          discountPct: r.orig.discountPct,
          discountAmount: round3(new Decimal(r.orig.discountAmount.toString()).times(r.qtyBase.div(r.orig.qtyBase.toString()))),
          netAmount: r.netAmount,
          taxCategoryId: r.orig.taxCategoryId,
          taxRate: r.orig.taxRate,
          taxAmount: r.taxAmount,
          lineTotal: r.lineTotal,
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'purchase_return.create',
      entityType: 'purchase_return',
      entityId: ret.id,
      after: { originalInvoiceId: invoice.id },
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
    await db.purchaseReturn.delete({ where: { id } });
    return { deleted: true };
  }

  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // Lock the document first (§10.1 step 7). As the first statement it also
        // makes every later read see the latest committed state, so two
        // concurrent requests cannot both post or reverse it.
        await tx.$queryRaw`SELECT id FROM purchase_returns WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const draft = await tx.purchaseReturn.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('PurchaseReturn', id.toString());
        await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Return is not a draft');
        }
        // A return belongs to its original invoice's branch (ADR-003).
        const original = await tx.purchaseInvoice.findFirst({
          where: { id: draft.originalInvoiceId },
          select: { branchId: true },
        });
        assertBranchAllowed(original?.branchId);
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Return has no lines');
        }
        if (draft.refundType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash refunds');
        }

        const returnDate = new Date(draft.returnDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, returnDate);

        // Lock every (item, warehouse) in the fixed order before any movement.
        await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
        );

        // Split stock vs service portions for the journal.
        let stockNet = new Decimal(0);
        let serviceNet = new Decimal(0);
        for (const line of draft.lines) {
          const item = await tx.item.findFirst({
            where: { tenantId, id: line.itemId },
            select: { itemKind: true },
          });
          if (!item) throw DomainError.notFound('Item', line.itemId.toString());
          if (item.itemKind === 'STOCK') {
            // OUT exits at current weighted-average cost (ledger rule §9.2).
            await this.ledger.applyMovement(tx, companyId, {
              warehouseId: draft.warehouseId,
              itemId: line.itemId,
              movementDate: returnDate,
              type: 'OUT',
              qty: line.qtyBase.toString(),
              sourceType: SOURCE,
              sourceId: draft.id,
              sourceLineId: line.id,
              description: `Purchase return ${draft.id}`,
            });
            stockNet = stockNet.plus(line.netAmount);
          } else {
            serviceNet = serviceNet.plus(line.netAmount);
          }
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
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
        if (serviceNet.gt(0)) {
          journalLines.push({ accountId: mapping.PURCHASES, credit: serviceNet.toString() });
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.INPUT_TAX, credit: tax.toString() });
        }

        const returnNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'PURCHASE_RETURN', returnDate,
        );
        const entryNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'JOURNAL_ENTRY', returnDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId: original?.branchId ?? null,
          entryDate: returnDate,
          fiscalPeriodId: period.id,
          entryNo,
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
