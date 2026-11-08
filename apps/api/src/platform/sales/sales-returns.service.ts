import { Injectable } from '@nestjs/common';
import { Decimal, round3, sum } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type { CreateSalesReturnDto } from './dto/sales.dto.js';

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
  ) {}

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
    return ret;
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
    const resolved = dto.lines.map((l, i) => {
      const orig = origById.get(BigInt(l.originalLineId));
      if (!orig) {
        throw new DomainError(ErrorCode.VALIDATION, `Line ${i + 1}: originalLineId not on this invoice`);
      }
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
    });
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
        const draft = await tx.salesReturn.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('SalesReturn', id.toString());
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Return is not a draft');
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Return has no lines');
        }
        if (draft.refundType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash refunds');
        }

        const returnDate = new Date(draft.returnDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, returnDate);

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
        return { id: draft.id, returnNo };
      }),
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
