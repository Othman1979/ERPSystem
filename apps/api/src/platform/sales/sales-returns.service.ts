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
import { EInvoiceOutboxService } from '../einvoice/einvoice-outbox.service.js';
import type { CreateSalesReturnDto } from './dto/sales.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';

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
    const where = { companyId, status: 'POSTED' as const, returnDate: { gte: range.from, lte: range.to } };
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

  async list(status?: string) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.salesReturn.findMany({
      where: { companyId, ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}) },
      include: {
        customer: { select: { id: true, code: true, nameAr: true } },
        originalInvoice: { select: { id: true, invoiceNo: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ returnDate: 'desc' }, { id: 'desc' }],
      take: 300,
    });
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const ret = await db.salesReturn.findFirst({
      where: { id },
      include: {
        customer: true,
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
            netAmount: true,
            taxRate: true,
            taxAmount: true,
            originalLine: {
              select: {
                lineNo: true,
                qty: true,
                qtyBase: true,
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

    const invoice = await db.salesInvoice.findFirst({
      where: { id: BigInt(dto.originalInvoiceId), companyId },
      include: { lines: true },
    });
    if (!invoice) throw DomainError.notFound('SalesInvoice', dto.originalInvoiceId);
    if (invoice.status !== 'POSTED') {
      throw new DomainError(ErrorCode.VALIDATION, 'Returns require a posted invoice');
    }

    // Already-returned qty per original line (all statuses — drafts reserve qty).
    const priorReturns = await db.salesReturnLine.findMany({
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
      // Proportional amounts by qtyBase ratio.
      const ratio = qtyBase.div(orig.qtyBase.toString());
      const netAmount = round3(new Decimal(orig.netAmount.toString()).times(ratio));
      const taxAmount = round3(new Decimal(orig.taxAmount.toString()).times(ratio));
      return {
        dto: l,
        orig,
        qtyBase,
        netAmount,
        taxAmount,
        lineTotal: netAmount.plus(taxAmount),
      };
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
          qty: r.qtyBase,
          qtyBase: r.qtyBase,
          unitPrice: r.orig.unitPrice,
          discountPct: r.orig.discountPct,
          discountAmount: round3(new Decimal(r.orig.discountAmount.toString()).times(r.qtyBase.div(r.orig.qtyBase.toString()))),
          netAmount: r.netAmount,
          taxCategoryId: r.orig.taxCategoryId,
          taxRate: r.orig.taxRate,
          taxAmount: r.taxAmount,
          lineTotal: r.lineTotal,
          unitCost: r.orig.unitCost,
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'sales_return.create',
      entityType: 'sales_return',
      entityId: ret.id,
      after: { originalInvoiceId: invoice.id },
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
    await db.salesReturn.delete({ where: { id } });
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
        await tx.$queryRaw`SELECT id FROM sales_returns WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
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
          select: { branchId: true },
        });
        assertBranchAllowed(original?.branchId);
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Return has no lines');
        }
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
        await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
        );

        // Stock IN at ORIGINAL unit cost (§8.4, §9.5).
        let costTotal = new Decimal(0);
        for (const line of draft.lines) {
          const item = await tx.item.findFirst({
            where: { tenantId, id: line.itemId },
            select: { itemKind: true },
          });
          if (!item || item.itemKind !== 'STOCK') continue;
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.warehouseId,
            itemId: line.itemId,
            movementDate: returnDate,
            type: 'IN',
            qty: line.qtyBase.toString(),
            unitCost: line.unitCost?.toString(),
            sourceType: SOURCE,
            sourceId: draft.id,
            sourceLineId: line.id,
            description: `Sales return ${draft.id}`,
          });
          costTotal = costTotal.plus(res.totalCost);
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'SALES_RETURNS',
          'OUTPUT_TAX',
          'COGS',
          'INVENTORY',
          'CUSTOMERS_CONTROL',
        ]);

        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const net = draft.netTotal;
        const tax = draft.taxTotal;

        if (net.gt(0)) {
          journalLines.push({ accountId: mapping.SALES_RETURNS, debit: net.toString() });
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.OUTPUT_TAX, debit: tax.toString() });
        }
        if (draft.refundType === 'CASH') {
          journalLines.push({
            accountId: draft.cashAccountId!,
            credit: grand.toString(),
            description: 'Cash refund',
          });
        } else {
          journalLines.push({
            accountId: mapping.CUSTOMERS_CONTROL,
            credit: grand.toString(),
            partyType: 'CUSTOMER',
            partyId: draft.customerId,
            description: 'Credit note',
          });
        }
        if (costTotal.gt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY, debit: costTotal.toString() });
          journalLines.push({ accountId: mapping.COGS, credit: costTotal.toString() });
        }

        const returnNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'SALES_RETURN', returnDate,
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
          description: draft.reason ?? `Sales return ${returnNo}`,
          lines: journalLines,
          postedBy: userId ?? null,
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
          originalInvoiceId: draft.originalInvoiceId,
        });
        return { id: draft.id, returnNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'sales_return.post',
      entityType: 'sales_return',
      entityId: result.id,
      after: { returnNo: result.returnNo },
    });
    return this.get(result.id);
  }
}
