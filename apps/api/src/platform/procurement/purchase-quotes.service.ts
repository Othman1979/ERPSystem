import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { Decimal, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { assertProcurementLevel, lockCompanyProcurement, lockProcurementLevel } from '../../common/procurement/procurement-level.js';
import { Prisma } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { CatalogService } from '../inventory/catalog.service.js';
import { PartiesService } from '../parties/parties.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type {
  CreatePurchaseQuoteDto,
  ListPurchaseQuotesQueryDto,
  PurchaseQuoteLineInputDto,
  ReceivePurchaseQuoteDto,
  UpdatePurchaseQuoteDto,
} from './dto/procurement.dto.js';
import { amountColumns, documentTotals, priceLine, remainingQty, resolvePurchaseItem } from './procurement-lines.js';
import { assertStatus, lockDocument, lockRequest } from './procurement-locks.js';

/** Statuses that count as open for the procurement level (ADR-025 §6). */
export const OPEN_QUOTE_STATUSES = ['DRAFT', 'SENT', 'RECEIVED'] as const;

const itemRef = { select: { id: true, code: true, nameAr: true, nameEn: true, baseUnitId: true, itemKind: true } } as const;
const unitRef = { include: { unit: { select: { id: true, code: true, nameAr: true } } } } as const;
const supplierRef = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;

/**
 * Requests for quotation (ADR-025 §1, FULL only): one supplier, lines of an
 * approved request. DRAFT → SENT (numbered RFQ, printed for the supplier) →
 * RECEIVED (the supplier's prices); CLOSED or CANCELLED. No ledger effect.
 */
@Injectable()
export class PurchaseQuotesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly parties: PartiesService,
  ) {}

  countOpen(tx: Prisma.TransactionClient): Promise<number> {
    return tx.purchaseQuote.count({ where: { status: { in: [...OPEN_QUOTE_STATUSES] } } });
  }

  async list(query: ListPurchaseQuotesQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const q = query.q;
    const where: Prisma.PurchaseQuoteWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.requestId ? { requestId: BigInt(query.requestId) } : {}),
      ...(query.supplierId ? { supplierId: BigInt(query.supplierId) } : {}),
      AND: [
        branchWhere(),
        q
          ? {
              OR: [
                { quoteNo: { contains: q } },
                { supplierRef: { contains: q } },
                { supplier: { code: { contains: q } } },
                { supplier: { nameAr: { contains: q } } },
                { supplier: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'quoteDate' | 'quoteNo' | 'grandTotal', Prisma.PurchaseQuoteOrderByWithRelationInput>(
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
        const page = await tx.purchaseQuote.findMany({
          where,
          include: { supplier: supplierRef, request: { select: { id: true, requestNo: true } } },
          orderBy,
          ...window,
        });
        return withLineCounts(page, 'quoteId', (ids) =>
          tx.purchaseQuoteLine.groupBy({ by: ['quoteId'], where: { quoteId: { in: ids } }, _count: { _all: true } }),
        );
      },
      count: (tx) => tx.purchaseQuote.count({ where }),
    });
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const quote = await db.purchaseQuote.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        supplier: { select: { id: true, code: true, nameAr: true, nameEn: true, taxNumber: true, phone: true, address: true } },
        request: { select: { id: true, requestNo: true, status: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { item: itemRef, itemUnit: unitRef, requestLine: { select: { id: true, lineNo: true } } },
        },
      },
    });
    if (!quote) throw DomainError.notFound('PurchaseQuote', id.toString());
    return quote;
  }

  async create(dto: CreatePurchaseQuoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const requestId = BigInt(dto.requestId);
    await this.parties.assertActiveSupplier(BigInt(dto.supplierId));
    const created = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const req = await this.lockApprovedRequest(tx, tenantId, companyId, requestId);
        const pricesIncludeTax = req.pricesIncludeTax;
        const lines = await this.quoteLines(tx, requestId, dto.lines);
        const quote = await tx.purchaseQuote.create({
          data: {
            tenantId,
            companyId,
            branchId: req.branch_id,
            requestId,
            supplierId: BigInt(dto.supplierId),
            quoteDate: new Date(dto.quoteDate),
            validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
            notes: dto.notes ?? null,
            pricesIncludeTax,
            createdBy: this.support.userId() ?? null,
          },
        });
        await tx.purchaseQuoteLine.createMany({ data: lines.map((l, i) => ({ tenantId, quoteId: quote.id, lineNo: i + 1, ...l })) });
        return quote;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_quote.create', entityType: 'purchase_quote', entityId: created.id });
    return this.get(created.id);
  }

  /** A draft's supplier, dates, notes and (when given) lines. */
  async update(id: bigint, dto: UpdatePurchaseQuoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const requestId = await this.requestIdOf(id);
    await this.parties.assertActiveSupplier(BigInt(dto.supplierId));
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const { pricesIncludeTax } = await this.lockApprovedRequest(tx, tenantId, companyId, requestId);
        const quote = await lockDocument(tx, 'purchase_quotes', tenantId, id);
        assertBranchAllowed(quote.branch_id);
        assertStatus('quote', quote.status, ['DRAFT'], 'edited');
        await tx.purchaseQuote.update({
          where: { id },
          data: {
            supplierId: BigInt(dto.supplierId),
            quoteDate: new Date(dto.quoteDate),
            validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
            notes: dto.notes ?? null,
            pricesIncludeTax,
            updatedBy: this.support.userId() ?? null,
          },
        });
        if (dto.lines) {
          const lines = await this.quoteLines(tx, requestId, dto.lines);
          await tx.purchaseQuoteLine.deleteMany({ where: { quoteId: id } });
          await tx.purchaseQuoteLine.createMany({ data: lines.map((l, i) => ({ tenantId, quoteId: id, lineNo: i + 1, ...l })) });
        }
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_quote.update', entityType: 'purchase_quote', entityId: id });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const requestId = await this.requestIdOf(id);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        await lockRequest(tx, tenantId, requestId, true);
        const quote = await lockDocument(tx, 'purchase_quotes', tenantId, id);
        assertBranchAllowed(quote.branch_id);
        assertStatus('quote', quote.status, ['DRAFT'], 'deleted');
        await tx.purchaseQuote.delete({ where: { id } });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_quote.delete', entityType: 'purchase_quote', entityId: id });
    return { deleted: true as const };
  }

  /** DRAFT → SENT: numbered RFQ (ADR-025 §8), the request still approved. */
  send(id: bigint) {
    return this.transition(id, 'send', ['DRAFT'], true, async (tx, tenantId, companyId) => {
      const row = await tx.purchaseQuote.findFirstOrThrow({ where: { id }, select: { quoteDate: true } });
      if ((await tx.purchaseQuoteLine.count({ where: { quoteId: id } })) === 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'The quote has no lines');
      }
      const quoteNo = await allocateDocumentNo(tx, tenantId, companyId, 'PURCHASE_QUOTE', row.quoteDate);
      return { status: 'SENT', quoteNo, sentAt: new Date(), sentBy: this.support.userId() ?? null };
    });
  }

  /**
   * SENT → RECEIVED with the supplier's price for every line; the amounts and
   * totals are computed here (ADR-017, tax from the item), never taken from the client.
   */
  receive(id: bigint, dto: ReceivePurchaseQuoteDto) {
    return this.transition(id, 'receive', ['SENT'], true, async (tx) => {
      const quote = await tx.purchaseQuote.findFirstOrThrow({
        where: { id },
        select: { pricesIncludeTax: true, lines: { orderBy: { lineNo: 'asc' } } },
      });
      const prices = new Map<bigint, (typeof dto.lines)[number]>();
      for (const l of dto.lines) {
        const lineId = BigInt(l.lineId);
        if (prices.has(lineId)) throw new DomainError(ErrorCode.VALIDATION, `Line ${l.lineId} is priced twice`);
        prices.set(lineId, l);
      }
      const unknown = [...prices.keys()].filter((k) => !quote.lines.some((l) => l.id === k));
      if (unknown.length > 0) throw DomainError.notFound('PurchaseQuoteLine', unknown[0].toString());
      const missing = quote.lines.filter((l) => !prices.has(l.id));
      if (missing.length > 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'Every line of the quote needs a price', { lineNo: missing[0].lineNo });
      }
      const refs = await this.catalog.itemsForLines(
        quote.lines.map((l) => l.itemId),
        quote.lines.filter((l) => l.itemUnitId).map((l) => l.itemUnitId!),
        tx,
      );
      const priced = quote.lines.map((l) => {
        const item = resolvePurchaseItem(refs, { itemId: l.itemId.toString(), itemUnitId: l.itemUnitId?.toString() ?? null, qty: l.qty.toString() });
        const p = prices.get(l.id)!;
        return { id: l.id, line: priceLine(item, p.unitPrice, p.discountPct, quote.pricesIncludeTax) };
      });
      for (const p of priced) {
        const { qty: _qty, ...cols } = amountColumns(p.line);
        await tx.purchaseQuoteLine.update({ where: { id: p.id }, data: cols });
      }
      return {
        status: 'RECEIVED',
        ...documentTotals(priced.map((p) => p.line)),
        supplierRef: dto.supplierRef ?? null,
        ...(dto.validUntil ? { validUntil: new Date(dto.validUntil) } : {}),
        receivedAt: new Date(),
        receivedBy: this.support.userId() ?? null,
      };
    });
  }

  close(id: bigint) {
    return this.transition(id, 'close', ['SENT', 'RECEIVED'], false, async () => ({
      status: 'CLOSED',
      closedAt: new Date(),
      closedBy: this.support.userId() ?? null,
    }));
  }

  cancel(id: bigint, reason: string) {
    return this.transition(id, 'cancel', ['SENT', 'RECEIVED'], false, async () => ({
      status: 'CANCELLED',
      cancelReason: reason,
      cancelledAt: new Date(),
      cancelledBy: this.support.userId() ?? null,
    }));
  }

  /**
   * The comparison (ADR-025 §10): every line of an approved (or closed)
   * request, what is left to order on it, and the prices of the received
   * quotes for it; `lowest` marks the lowest price per unit, tax included.
   */
  async comparison(requestId: bigint) {
    const { db } = this.support.tenant();
    const req = await db.purchaseRequest.findFirst({
      where: { id: requestId, AND: [branchWhere()] },
      include: { lines: { orderBy: { lineNo: 'asc' }, include: { item: itemRef, itemUnit: unitRef } } },
    });
    if (!req) throw DomainError.notFound('PurchaseRequest', requestId.toString());
    const quotes = await db.purchaseQuote.findMany({
      where: { requestId, status: 'RECEIVED' },
      orderBy: { id: 'asc' },
      include: { supplier: supplierRef, lines: true },
    });
    return {
      request: { id: req.id, requestNo: req.requestNo, status: req.status, requestDate: req.requestDate },
      lines: req.lines.map((l) => {
        const offers = quotes.flatMap((q) =>
          q.lines
            .filter((ql) => ql.requestLineId === l.id && ql.unitPrice !== null)
            .map((ql) => ({
              quoteId: q.id,
              quoteNo: q.quoteNo,
              quoteLineId: ql.id,
              supplier: q.supplier,
              qty: ql.qty,
              unitPrice: ql.unitPrice!,
              discountPct: ql.discountPct,
              netAmount: ql.netAmount,
              taxAmount: ql.taxAmount,
              lineTotal: ql.lineTotal,
              pricesIncludeTax: q.pricesIncludeTax,
              perUnit: new Decimal(ql.lineTotal.toString()).div(ql.qty.toString()),
            })),
        );
        const lowest = offers.reduce<Decimal | null>((m, o) => (m === null || o.perUnit.lt(m) ? o.perUnit : m), null);
        return {
          requestLineId: l.id,
          lineNo: l.lineNo,
          item: l.item,
          itemUnit: l.itemUnit,
          qty: l.qty,
          orderedQty: l.orderedQty,
          remainingQty: remainingQty(l).toString(),
          offers: offers.map(({ perUnit, ...o }) => ({ ...o, unitTotal: round6(perUnit).toString(), lowest: lowest !== null && perUnit.eq(lowest) })),
        };
      }),
    };
  }

  // ------------------------------------------------------------- internals

  private async requestIdOf(id: bigint): Promise<bigint> {
    const { db } = this.support.tenant();
    const row = await db.purchaseQuote.findFirst({ where: { id, AND: [branchWhere()] }, select: { requestId: true } });
    if (!row) throw DomainError.notFound('PurchaseQuote', id.toString());
    return row.requestId;
  }

  /** The level (FULL) and the request (shared lock) it quotes for, approved and in the caller's branches. */
  private async lockApprovedRequest(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, requestId: bigint) {
    // The level and the tax-inclusive setting in one read of the share-locked company row (frozen on the quote).
    const company = await lockCompanyProcurement(tx, tenantId, companyId);
    assertProcurementLevel(company.level, 'FULL');
    const req = await lockRequest(tx, tenantId, requestId, true);
    assertBranchAllowed(req.branch_id);
    assertStatus('purchase request', req.status, ['APPROVED'], 'quoted');
    return { ...req, pricesIncludeTax: company.pricesIncludeTax };
  }

  /** Quote lines from request lines: the given ones (each once), or every line with something left. */
  private async quoteLines(tx: Prisma.TransactionClient, requestId: bigint, wanted: PurchaseQuoteLineInputDto[] | undefined) {
    const reqLines = await tx.purchaseRequestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' } });
    const byId = new Map(reqLines.map((l) => [l.id, l]));
    const picks = wanted
      ? wanted.map((w) => {
          const line = byId.get(BigInt(w.requestLineId));
          if (!line) throw DomainError.notFound('PurchaseRequestLine', w.requestLineId);
          return { line, qty: w.qty ? new Decimal(w.qty) : remainingQty(line), note: w.note ?? null };
        })
      : reqLines.filter((l) => remainingQty(l).gt(0)).map((line) => ({ line, qty: remainingQty(line), note: null }));
    if (picks.length === 0) throw new DomainError(ErrorCode.VALIDATION, 'Nothing is left to quote on this request');
    if (new Set(picks.map((p) => p.line.id)).size !== picks.length) {
      throw new DomainError(ErrorCode.VALIDATION, 'A request line appears twice on the quote');
    }
    const refs = await this.catalog.itemsForLines(
      picks.map((p) => p.line.itemId),
      picks.filter((p) => p.line.itemUnitId).map((p) => p.line.itemUnitId!),
      tx,
    );
    return picks.map((p) => {
      const item = resolvePurchaseItem(refs, { itemId: p.line.itemId.toString(), itemUnitId: p.line.itemUnitId?.toString() ?? null, qty: p.qty.toString() });
      return {
        requestLineId: p.line.id,
        itemId: item.itemId,
        itemUnitId: item.itemUnitId,
        qty: item.qty,
        qtyBase: item.qtyBase,
        taxCategoryId: item.taxCategoryId,
        taxRate: item.taxRate,
        note: p.note,
      };
    });
  }

  /**
   * One status change: the level (FULL), the request (shared; approved when
   * `needsApprovedRequest`), then the quote, retried on a lock conflict.
   */
  private async transition(
    id: bigint,
    action: 'send' | 'receive' | 'close' | 'cancel',
    from: readonly string[],
    needsApprovedRequest: boolean,
    apply: (tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint) => Promise<Prisma.PurchaseQuoteUpdateInput>,
  ) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const requestId = await this.requestIdOf(id);
    const verb = { send: 'sent', receive: 'received', close: 'closed', cancel: 'cancelled' }[action];
    const data = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        if (needsApprovedRequest) {
          await this.lockApprovedRequest(tx, tenantId, companyId, requestId);
        } else {
          assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
          await lockRequest(tx, tenantId, requestId, true);
        }
        const quote = await lockDocument(tx, 'purchase_quotes', tenantId, id);
        assertBranchAllowed(quote.branch_id);
        assertStatus('quote', quote.status, from, verb);
        const set = await apply(tx, tenantId, companyId);
        await tx.purchaseQuote.update({ where: { id }, data: { ...set, updatedBy: this.support.userId() ?? null } });
        return set;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({
      action: `purchase_quote.${action}`,
      entityType: 'purchase_quote',
      entityId: id,
      after: { status: data.status, ...(data.quoteNo ? { quoteNo: data.quoteNo } : {}) },
    });
    return this.get(id);
  }
}
