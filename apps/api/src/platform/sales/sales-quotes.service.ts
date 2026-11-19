import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { Prisma } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { CatalogService } from '../inventory/catalog.service.js';
import { WarehousesService } from '../inventory/warehouses.service.js';
import { PartiesService } from '../parties/parties.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { amountColumns, documentTotals, priceLine, resolveItem, type PricedLine } from '../procurement/procurement-lines.js';
import { assertStatus } from '../procurement/procurement-locks.js';
import type { CreateSalesQuoteDto, ListSalesQuotesQueryDto, SalesLineDto, UpdateSalesQuoteDto } from './dto/sales-cycle.dto.js';
import { defaultValidUntil, isQuoteExpired } from './sales-cycle.rules.js';
import { lockCompanySales, lockSalesQuote } from './sales-cycle.locks.js';

const itemRef = { select: { id: true, code: true, nameAr: true, nameEn: true, baseUnitId: true, itemKind: true } } as const;
const unitRef = { include: { unit: { select: { id: true, code: true, nameAr: true } } } } as const;
const customerRef = { select: { id: true, code: true, nameAr: true, nameEn: true, taxNumber: true, phone: true, address: true } } as const;

/** One priced line of a quote, as written (ADR-027 §2). */
interface QuoteLineInput {
  line: PricedLine;
  note: string | null;
}

/** A quote's header as written from a draft. */
interface QuoteHeader {
  customerId: bigint;
  warehouseId: bigint | null;
  costCenterId: bigint | null;
  quoteDate: Date;
  validUntil: Date | null;
  description: string | null;
}

/**
 * Sales quotations (ADR-027 §2): DRAFT → SENT (numbered SQ) → ACCEPTED or
 * REJECTED; CANCELLED from DRAFT or SENT. An expired SENT quote (valid_until
 * before today) cannot be accepted or converted. No journal entry, no stock
 * movement: the sales order and the invoice carry the effect.
 */
@Injectable()
export class SalesQuotesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly warehouses: WarehousesService,
    private readonly parties: PartiesService,
    private readonly costCenters: CostCentersService,
  ) {}

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  async list(query: ListSalesQuotesQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.SalesQuoteWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: BigInt(query.customerId) } : {}),
      ...(query.from || query.to
        ? {
            quoteDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [
        branchWhere(),
        q
          ? {
              OR: [
                { quoteNo: { contains: q } },
                { customer: { code: { contains: q } } },
                { customer: { nameAr: { contains: q } } },
                { customer: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'quoteDate' | 'quoteNo' | 'grandTotal', Prisma.SalesQuoteOrderByWithRelationInput>(
      query.sort,
      '-quoteDate',
      {
        quoteDate: (dir) => ({ quoteDate: dir }),
        quoteNo: (dir) => ({ quoteNo: dir }),
        grandTotal: (dir) => ({ grandTotal: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) => {
        const page = await tx.salesQuote.findMany({
          where,
          include: { customer: customerRef },
          orderBy,
          ...window,
        });
        return withLineCounts(page, 'quoteId', (ids) =>
          tx.salesQuoteLine.groupBy({ by: ['quoteId'], where: { quoteId: { in: ids } }, _count: { _all: true } }),
        );
      },
      count: (tx) => tx.salesQuote.count({ where }),
    });
  }

  /** One quote; another branch's answers 404 (ADR-003 §11). `expired` is computed, not stored. */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const quote = await db.salesQuote.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        customer: customerRef,
        warehouse: { select: { id: true, code: true, nameAr: true } },
        costCenter: { select: { id: true, code: true, nameAr: true } },
        lines: { orderBy: { lineNo: 'asc' }, include: { item: itemRef, itemUnit: unitRef } },
        // The order it was converted to (at most one, sales_quote_id is unique): the link back (review #56).
        orders: { select: { id: true, orderNo: true, status: true } },
      },
    });
    if (!quote) throw DomainError.notFound('SalesQuote', id.toString());
    return { ...quote, expired: quote.status === 'SENT' && isQuoteExpired(quote.validUntil, (await this.support.companyTodayDate())) };
  }

  async create(dto: CreateSalesQuoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const customerId = BigInt(dto.customerId);
    await this.parties.assertActiveCustomer(customerId);
    const warehouseId = dto.warehouseId ? BigInt(dto.warehouseId) : null;
    const branchId = warehouseId ? await this.warehouseBranch(dto.warehouseId!) : null;

    const id = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const settings = await lockCompanySales(tx, tenantId, companyId);
        const lines = await this.priceLines(tx, dto.lines, settings.pricesIncludeTax);
        const quoteDate = dto.quoteDate ? new Date(dto.quoteDate) : (await this.support.companyTodayDate());
        const header = this.header(dto, quoteDate, customerId, warehouseId, dto.validUntil, settings.quoteValidityDays);
        return this.writeQuote(tx, tenantId, companyId, branchId, settings.pricesIncludeTax, header, lines);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'sales_quote.create', entityType: 'sales_quote', entityId: id });
    return this.get(id);
  }

  /** A draft's new content (ADR-027 §2): DRAFT only. */
  async update(id: bigint, dto: UpdateSalesQuoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.quoteOrNotFound(id);
    const customerId = BigInt(dto.customerId);
    await this.parties.assertActiveCustomer(customerId);
    const warehouseId = dto.warehouseId ? BigInt(dto.warehouseId) : null;
    const branchId = warehouseId ? await this.warehouseBranch(dto.warehouseId!) : null;

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const settings = await lockCompanySales(tx, tenantId, companyId);
        const row = await lockSalesQuote(tx, tenantId, id);
        assertBranchAllowed(row.branch_id);
        assertStatus('sales quote', row.status, ['DRAFT'], 'edited');
        const lines = await this.priceLines(tx, dto.lines, settings.pricesIncludeTax);
        const saved = await tx.salesQuote.findFirstOrThrow({ where: { id }, select: { quoteDate: true, validUntil: true } });
        const quoteDate = dto.quoteDate ? new Date(dto.quoteDate) : saved.quoteDate;
        // An edit that leaves validUntil out keeps the quote's own, not the company default (review #56).
        const validUntil = dto.validUntil !== undefined ? dto.validUntil : saved.validUntil ? saved.validUntil.toISOString().slice(0, 10) : null;
        const header = this.header(dto, quoteDate, customerId, warehouseId, validUntil, settings.quoteValidityDays);
        if (header.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, header.costCenterId);
        await tx.salesQuoteLine.deleteMany({ where: { quoteId: id } });
        await tx.salesQuote.update({
          where: { id },
          data: {
            ...this.headerColumns(header),
            branchId,
            pricesIncludeTax: settings.pricesIncludeTax,
            ...documentTotals(lines.map((l) => l.line)),
            updatedBy: this.support.userId() ?? null,
          },
        });
        await this.writeLines(tx, tenantId, id, lines);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'sales_quote.update', entityType: 'sales_quote', entityId: id });
    return this.get(id);
  }

  /** Deletes a draft (ADR-027 §2). */
  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    await this.quoteOrNotFound(id);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const row = await lockSalesQuote(tx, tenantId, id);
        assertBranchAllowed(row.branch_id);
        assertStatus('sales quote', row.status, ['DRAFT'], 'deleted');
        await tx.salesQuote.delete({ where: { id } });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'sales_quote.delete', entityType: 'sales_quote', entityId: id });
    return { deleted: true as const };
  }

  /** DRAFT → SENT: the quote gets its number SQ (ADR-027 §2, §8), from its date. */
  send(id: bigint) {
    return this.transition(id, 'send', ['DRAFT'], 'sent', async (tx, _row, tenantId, companyId) => {
      const quote = await tx.salesQuote.findFirstOrThrow({ where: { id }, select: { quoteDate: true } });
      if ((await tx.salesQuoteLine.count({ where: { quoteId: id } })) === 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'The quote has no lines');
      }
      const quoteNo = await allocateDocumentNo(tx, tenantId, companyId, 'SALES_QUOTE', quote.quoteDate);
      return { status: 'SENT', quoteNo, sentAt: new Date(), sentBy: this.support.userId() ?? null };
    });
  }

  /** SENT → ACCEPTED, refused once expired (QUOTE_EXPIRED, ADR-027 §2). */
  accept(id: bigint) {
    return this.transition(id, 'accept', ['SENT'], 'accepted', async (tx) => {
      const quote = await tx.salesQuote.findFirstOrThrow({ where: { id }, select: { validUntil: true } });
      if (isQuoteExpired(quote.validUntil, (await this.support.companyTodayDate()))) {
        throw new DomainError(ErrorCode.QUOTE_EXPIRED, 'The quote has expired', { validUntil: quote.validUntil?.toISOString().slice(0, 10) ?? null });
      }
      return { status: 'ACCEPTED', acceptedAt: new Date(), acceptedBy: this.support.userId() ?? null };
    });
  }

  /** SENT → REJECTED by the customer, with a written reason. */
  reject(id: bigint, reason: string) {
    return this.transition(id, 'reject', ['SENT'], 'rejected', async () => ({
      status: 'REJECTED',
      rejectReason: reason,
      rejectedAt: new Date(),
      rejectedBy: this.support.userId() ?? null,
    }));
  }

  /** DRAFT or SENT → CANCELLED with a written reason (ADR-027 §2). */
  cancel(id: bigint, reason: string) {
    return this.transition(id, 'cancel', ['DRAFT', 'SENT'], 'cancelled', async () => ({
      status: 'CANCELLED',
      cancelReason: reason,
      cancelledAt: new Date(),
      cancelledBy: this.support.userId() ?? null,
    }));
  }

  /**
   * A new draft from any quote (ADR-027 §2: a sent quote is not edited, it is
   * cancelled and copied). Same customer and lines with the stored prices; the
   * quote date is today and the validity is the company default.
   */
  async copy(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const src = await db.salesQuote.findFirst({
      where: { id, AND: [branchWhere()] },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!src) throw DomainError.notFound('SalesQuote', id.toString());
    await this.parties.assertActiveCustomer(src.customerId);
    const newId = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const settings = await lockCompanySales(tx, tenantId, companyId);
        const quoteDate = (await this.support.companyTodayDate());
        const header: QuoteHeader = {
          customerId: src.customerId,
          warehouseId: src.warehouseId,
          costCenterId: src.costCenterId,
          quoteDate,
          validUntil: defaultValidUntil(quoteDate, settings.quoteValidityDays),
          description: src.description,
        };
        const copy = await tx.salesQuote.create({
          data: {
            tenantId,
            companyId,
            branchId: src.branchId,
            ...this.headerColumns(header),
            pricesIncludeTax: src.pricesIncludeTax,
            netTotal: src.netTotal,
            taxTotal: src.taxTotal,
            grandTotal: src.grandTotal,
            createdBy: this.support.userId() ?? null,
          },
        });
        await tx.salesQuoteLine.createMany({
          data: src.lines.map((l) => ({
            tenantId,
            quoteId: copy.id,
            lineNo: l.lineNo,
            itemId: l.itemId,
            itemUnitId: l.itemUnitId,
            qty: l.qty,
            qtyBase: l.qtyBase,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            discountAmount: l.discountAmount,
            netAmount: l.netAmount,
            taxCategoryId: l.taxCategoryId,
            taxRate: l.taxRate,
            taxAmount: l.taxAmount,
            lineTotal: l.lineTotal,
            note: l.note,
          })),
        });
        await this.audit.log({
          action: 'sales_quote.copy',
          entityType: 'sales_quote',
          entityId: copy.id,
          after: { from: id.toString() },
        }, tx);
        return copy.id;
      }, POSTING_TX_OPTIONS),
    );
    return this.get(newId);
  }

  // ------------------------------------------------------------- internals

  /** Another branch's quote answers 404 before any body check (ADR-003 §11). */
  private async quoteOrNotFound(id: bigint): Promise<void> {
    const { db } = this.support.tenant();
    const row = await db.salesQuote.findFirst({ where: { id, AND: [branchWhere()] }, select: { id: true } });
    if (!row) throw DomainError.notFound('SalesQuote', id.toString());
  }

  /** The warehouse's branch, which the caller must be allowed (ADR-003). */
  private async warehouseBranch(warehouseId: string): Promise<bigint | null> {
    const wh = await this.warehouses.activeRef(BigInt(warehouseId));
    assertBranchAllowed(wh.branchId);
    return wh.branchId;
  }

  /** Header values from a draft; validUntil omitted takes the company default (ADR-027 §1). */
  private header(
    dto: { quoteDate?: string; description?: string; costCenterId?: string },
    quoteDate: Date,
    customerId: bigint,
    warehouseId: bigint | null,
    validUntil: string | null | undefined,
    validityDays: number,
  ): QuoteHeader {
    const until = validUntil === undefined ? defaultValidUntil(quoteDate, validityDays) : validUntil === null ? null : new Date(validUntil);
    // A quote is valid from its own date: an earlier validUntil would be expired at once (review #56).
    if (until !== null && until.getTime() < quoteDate.getTime()) {
      throw new DomainError(ErrorCode.VALIDATION, 'validUntil must not be before the quote date', { field: 'validUntil' });
    }
    return {
      customerId,
      warehouseId,
      costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
      quoteDate,
      validUntil: until,
      description: dto.description ?? null,
    };
  }

  private headerColumns(h: QuoteHeader) {
    return {
      customerId: h.customerId,
      warehouseId: h.warehouseId,
      costCenterId: h.costCenterId,
      quoteDate: h.quoteDate,
      validUntil: h.validUntil,
      description: h.description,
    };
  }

  /** Prices the lines on the server: items, units, tax from the catalog; never the client's amounts (ADR-027 §2). */
  private async priceLines(tx: Prisma.TransactionClient, dtos: SalesLineDto[], pricesIncludeTax: boolean): Promise<QuoteLineInput[]> {
    const refs = await this.catalog.itemsForLines(
      dtos.map((l) => BigInt(l.itemId)),
      dtos.filter((l) => l.itemUnitId).map((l) => BigInt(l.itemUnitId!)),
      tx,
    );
    return dtos.map((l) => ({
      line: priceLine(resolveItem(refs, l), l.unitPrice, l.discountPct, pricesIncludeTax),
      note: l.note ?? null,
    }));
  }

  private async writeQuote(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    branchId: bigint | null,
    pricesIncludeTax: boolean,
    header: QuoteHeader,
    lines: QuoteLineInput[],
  ): Promise<bigint> {
    // Share-lock the header centre before the row that references it (ADR-024 §1.4).
    if (header.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, header.costCenterId);
    const quote = await tx.salesQuote.create({
      data: {
        tenantId,
        companyId,
        branchId,
        pricesIncludeTax,
        ...this.headerColumns(header),
        ...documentTotals(lines.map((l) => l.line)),
        createdBy: this.support.userId() ?? null,
      },
    });
    await this.writeLines(tx, tenantId, quote.id, lines);
    return quote.id;
  }

  private async writeLines(tx: Prisma.TransactionClient, tenantId: bigint, quoteId: bigint, lines: QuoteLineInput[]) {
    await tx.salesQuoteLine.createMany({
      data: lines.map((l, i) => ({
        tenantId,
        quoteId,
        lineNo: i + 1,
        itemId: l.line.itemId,
        itemUnitId: l.line.itemUnitId,
        note: l.note,
        ...amountColumns(l.line),
      })),
    });
  }

  /**
   * One status change under the quote's lock (company shared first, then the
   * quote row, ADR-027 §8), retried on a lock conflict.
   */
  private async transition(
    id: bigint,
    action: 'send' | 'accept' | 'reject' | 'cancel',
    from: readonly string[],
    verb: string,
    apply: (
      tx: Prisma.TransactionClient,
      row: Awaited<ReturnType<typeof lockSalesQuote>>,
      tenantId: bigint,
      companyId: bigint,
    ) => Promise<Prisma.SalesQuoteUpdateInput>,
  ) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.quoteOrNotFound(id);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await lockCompanySales(tx, tenantId, companyId);
        const row = await lockSalesQuote(tx, tenantId, id);
        assertBranchAllowed(row.branch_id);
        assertStatus('sales quote', row.status, from, verb);
        const update = await apply(tx, row, tenantId, companyId);
        await tx.salesQuote.update({ where: { id }, data: update });
        await this.audit.log({
          action: `sales_quote.${action}`,
          entityType: 'sales_quote',
          entityId: id,
          after: {
            status: update.status,
            ...(update.quoteNo ? { quoteNo: update.quoteNo as string } : {}),
            ...(update.rejectReason ? { reason: update.rejectReason as string } : {}),
            ...(update.cancelReason ? { reason: update.cancelReason as string } : {}),
          },
        }, tx);
        return update;
      }, POSTING_TX_OPTIONS),
    );
    return this.get(id);
  }
}
