import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed, branchWhere, currentBranchId } from '../../common/branch/branch-context.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { assertCanApprove, isAuthor, readApprover } from '../../common/procurement/approval.js';
import { assertProcurementLevel, lockProcurementLevel } from '../../common/procurement/procurement-level.js';
import { Prisma } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { CatalogService } from '../inventory/catalog.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { CreatePurchaseRequestDto, ListPurchaseRequestsQueryDto } from './dto/procurement.dto.js';
import { assertStatus, lockRequest, lockRequestLines } from './procurement-locks.js';
import { remainingQty, resolvePurchaseItem } from './procurement-lines.js';

/** Statuses that count as open for the procurement level (ADR-025 §6). */
export const OPEN_REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED'] as const;

const itemRef = { select: { id: true, code: true, nameAr: true, nameEn: true, baseUnitId: true, itemKind: true } } as const;
const unitRef = { include: { unit: { select: { id: true, code: true, nameAr: true } } } } as const;
const supplierRef = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;

/**
 * Purchase requests (ADR-025 §1, FULL level only): DRAFT → SUBMITTED →
 * APPROVED (numbered PRQ), or REJECTED / CANCELLED; CLOSED by hand or once
 * approved orders cover every line. No journal entry, no stock movement.
 */
@Injectable()
export class PurchaseRequestsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  /** Open requests of the tenant, for the level change (ADR-025 §6). */
  countOpen(tx: Prisma.TransactionClient): Promise<number> {
    return tx.purchaseRequest.count({ where: { status: { in: [...OPEN_REQUEST_STATUSES] } } });
  }

  async list(query: ListPurchaseRequestsQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.PurchaseRequestWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            requestDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [branchWhere(), q ? { OR: [{ requestNo: { contains: q } }, { notes: { contains: q } }] } : {}],
    };
    const orderBy = orderByOf<'requestDate' | 'requestNo', Prisma.PurchaseRequestOrderByWithRelationInput>(
      query.sort,
      '-requestDate',
      { requestDate: (dir) => ({ requestDate: dir }), requestNo: (dir) => ({ requestNo: dir }) },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) => {
        const page = await tx.purchaseRequest.findMany({ where, orderBy, ...window });
        return withLineCounts(page, 'requestId', (ids) =>
          tx.purchaseRequestLine.groupBy({ by: ['requestId'], where: { requestId: { in: ids } }, _count: { _all: true } }),
        );
      },
      count: (tx) => tx.purchaseRequest.count({ where }),
    });
  }

  /** One request with its lines (and what is left to order on each), quotes and orders; another branch's answers 404. */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const req = await db.purchaseRequest.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        lines: { orderBy: { lineNo: 'asc' }, include: { item: itemRef, itemUnit: unitRef } },
        // Only the quotes and orders of the caller's branches (ADR-003 §11).
        quotes: {
          where: branchWhere(),
          orderBy: { id: 'asc' },
          select: { id: true, quoteNo: true, status: true, quoteDate: true, grandTotal: true, supplier: supplierRef },
        },
        orders: {
          where: branchWhere(),
          orderBy: { id: 'asc' },
          select: { id: true, orderNo: true, status: true, orderDate: true, grandTotal: true, supplier: supplierRef },
        },
      },
    });
    if (!req) throw DomainError.notFound('PurchaseRequest', id.toString());
    return {
      ...req,
      // As a Decimal column serializes (toString), like qty and orderedQty.
      lines: req.lines.map((l) => ({ ...l, remainingQty: remainingQty(l).toString() })),
    };
  }

  async create(dto: CreatePurchaseRequestDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const lines = await this.resolveLines(dto);
    const created = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        const req = await tx.purchaseRequest.create({
          data: {
            tenantId,
            companyId,
            // Branch from the request context (BranchGuard), never the body (ADR-003).
            branchId: currentBranchId(),
            requestDate: new Date(dto.requestDate),
            neededBy: dto.neededBy ? new Date(dto.neededBy) : null,
            notes: dto.notes ?? null,
            createdBy: this.support.userId() ?? null,
          },
        });
        await tx.purchaseRequestLine.createMany({ data: lines.map((l, i) => ({ tenantId, requestId: req.id, lineNo: i + 1, ...l })) });
        return req;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_request.create', entityType: 'purchase_request', entityId: created.id, after: { lines: lines.length } });
    return this.get(created.id);
  }

  async update(id: bigint, dto: CreatePurchaseRequestDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const lines = await this.resolveLines(dto);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        const req = await lockRequest(tx, tenantId, id);
        assertBranchAllowed(req.branch_id);
        assertStatus('purchase request', req.status, ['DRAFT'], 'edited');
        await tx.purchaseRequestLine.deleteMany({ where: { requestId: id } });
        await tx.purchaseRequest.update({
          where: { id },
          data: {
            requestDate: new Date(dto.requestDate),
            neededBy: dto.neededBy ? new Date(dto.neededBy) : null,
            notes: dto.notes ?? null,
            updatedBy: this.support.userId() ?? null,
          },
        });
        await tx.purchaseRequestLine.createMany({ data: lines.map((l, i) => ({ tenantId, requestId: id, lineNo: i + 1, ...l })) });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_request.update', entityType: 'purchase_request', entityId: id });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        const req = await lockRequest(tx, tenantId, id);
        assertBranchAllowed(req.branch_id);
        assertStatus('purchase request', req.status, ['DRAFT'], 'deleted');
        await tx.purchaseRequest.delete({ where: { id } });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_request.delete', entityType: 'purchase_request', entityId: id });
    return { deleted: true as const };
  }

  submit(id: bigint) {
    return this.transition(id, 'submit', ['DRAFT'], async (tx) => {
      if ((await tx.purchaseRequestLine.count({ where: { requestId: id } })) === 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'The request has no lines');
      }
      return { status: 'SUBMITTED', submittedAt: new Date(), submittedBy: this.support.userId() ?? null };
    });
  }

  /**
   * ADR-025 §2: purchase.approve, never on a request one created, last edited
   * or submitted (owners aside); no limit (no binding prices). Numbered here.
   */
  approve(id: bigint) {
    return this.transition(id, 'approve', ['SUBMITTED'], async (tx, req, tenantId, companyId) => {
      const approver = await readApprover(tx, tenantId);
      assertCanApprove({ ...approver, amount: null, isAuthor: isAuthor(req, approver.userId) });
      const requestNo = await allocateDocumentNo(tx, tenantId, companyId, 'PURCHASE_REQUEST', new Date(req.request_date));
      return { status: 'APPROVED', requestNo, approvedAt: new Date(), approvedBy: approver.userId };
    });
  }

  /** The approver's no: purchase.approve (or an owner), one's own request included; it ends REJECTED. */
  reject(id: bigint, reason: string) {
    return this.transition(id, 'reject', ['SUBMITTED'], async (tx, _req, tenantId) => {
      const approver = await readApprover(tx, tenantId);
      assertCanApprove({ ...approver, amount: null, isAuthor: false });
      return { status: 'REJECTED', rejectReason: reason, rejectedAt: new Date(), rejectedBy: approver.userId };
    });
  }

  /**
   * Cancels a submitted or approved request with a reason. An approved one
   * only while no order (not cancelled) holds any of it; its open quotes are
   * cancelled with it.
   */
  cancel(id: bigint, reason: string) {
    return this.transition(id, 'cancel', ['SUBMITTED', 'APPROVED'], async (tx, _req, tenantId) => {
      const lines = await lockRequestLines(tx, tenantId, id);
      if ([...lines.values()].some((l) => l.ordered_qty.gt(0))) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Orders hold part of this request: cancel them, or close the request', {
          status: 'APPROVED',
          action: 'cancelled',
          reason: 'HAS_ORDERS',
        });
      }
      await this.closeOpenQuotes(tx, id, 'CANCELLED', reason);
      return { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date(), cancelledBy: this.support.userId() ?? null };
    });
  }

  /** Closes an approved request by hand: nothing more is ordered from it; its open quotes close too. */
  close(id: bigint) {
    return this.transition(id, 'close', ['APPROVED'], async (tx) => {
      await this.closeOpenQuotes(tx, id, 'CLOSED');
      return { status: 'CLOSED', closedAt: new Date(), closedBy: this.support.userId() ?? null };
    });
  }

  /**
   * After an order of the request is approved, on the approving transaction
   * (which holds the request and its lines locked): closes the request once
   * approved orders cover every line (ADR-025 §7), and its open quotes.
   * True when it closed it; the caller audits that after COMMIT.
   */
  async closeIfFullyOrdered(tx: Prisma.TransactionClient, tenantId: bigint, requestId: bigint): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: bigint; qty: { toString(): string }; approved: { toString(): string } | null }[]>`
      SELECT rl.id, rl.qty,
             (SELECT SUM(ol.qty) FROM purchase_order_lines ol
                JOIN purchase_orders o ON o.tenant_id = ol.tenant_id AND o.id = ol.order_id
               WHERE ol.tenant_id = ${tenantId} AND ol.request_line_id = rl.id AND o.status = 'APPROVED') AS approved
        FROM purchase_request_lines rl
       WHERE rl.tenant_id = ${tenantId} AND rl.request_id = ${requestId}`;
    const covered = rows.every((r) => new Decimal(r.approved?.toString() ?? '0').gte(r.qty.toString()));
    if (!covered) return false;
    // closed_by stays null on the request and its quotes: the mark of an automatic close.
    await this.closeOpenQuotes(tx, requestId, 'CLOSED', undefined, true);
    await tx.purchaseRequest.update({ where: { id: requestId }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: null } });
    return true;
  }

  /**
   * Undoes an automatic close when a cancelled order gives quantity back
   * (review #47), on the cancelling transaction, which holds the request lock:
   * the request is APPROVED again, and its quotes closed with it (closed_by
   * null) return to the status they had: RECEIVED, SENT or DRAFT. A request
   * or quote closed by hand stays closed. True when it reopened the request.
   */
  async reopenIfAutoClosed(tx: Prisma.TransactionClient, requestId: bigint): Promise<boolean> {
    const req = await tx.purchaseRequest.findFirstOrThrow({ where: { id: requestId }, select: { status: true, closedBy: true, closedAt: true } });
    if (req.status !== 'CLOSED' || req.closedBy !== null || req.closedAt === null) return false;
    await tx.purchaseRequest.update({ where: { id: requestId }, data: { status: 'APPROVED', closedAt: null } });
    const auto = { requestId, status: 'CLOSED' as const, closedBy: null, closedAt: { not: null } };
    const reopened = { closedAt: null };
    await tx.purchaseQuote.updateMany({ where: { ...auto, receivedAt: { not: null } }, data: { ...reopened, status: 'RECEIVED' } });
    await tx.purchaseQuote.updateMany({ where: { ...auto, receivedAt: null, sentAt: { not: null } }, data: { ...reopened, status: 'SENT' } });
    await tx.purchaseQuote.updateMany({ where: { ...auto, sentAt: null }, data: { ...reopened, status: 'DRAFT' } });
    return true;
  }

  // ------------------------------------------------------------- internals

  /** `automatic`: the system closes them (closed_by null), see reopenIfAutoClosed. */
  private async closeOpenQuotes(
    tx: Prisma.TransactionClient,
    requestId: bigint,
    to: 'CLOSED' | 'CANCELLED',
    reason?: string,
    automatic = false,
  ) {
    const userId = automatic ? null : (this.support.userId() ?? null);
    await tx.purchaseQuote.updateMany({
      where: { requestId, status: { in: ['DRAFT', 'SENT', 'RECEIVED'] } },
      data:
        to === 'CLOSED'
          ? { status: 'CLOSED', closedAt: new Date(), closedBy: userId }
          : { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason ?? null },
    });
  }

  /**
   * One status change under the locks (company level shared, then the
   * request), retried on a lock conflict: `apply` checks and returns the
   * columns to set. Audited as purchase_request.<action>.
   */
  private async transition(
    id: bigint,
    action: 'submit' | 'approve' | 'reject' | 'cancel' | 'close',
    from: readonly string[],
    apply: (
      tx: Prisma.TransactionClient,
      req: Awaited<ReturnType<typeof lockRequest>>,
      tenantId: bigint,
      companyId: bigint,
    ) => Promise<Prisma.PurchaseRequestUpdateInput>,
  ) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const verb = { submit: 'submitted', approve: 'approved', reject: 'rejected', cancel: 'cancelled', close: 'closed' }[action];
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        const req = await lockRequest(tx, tenantId, id);
        assertBranchAllowed(req.branch_id);
        assertStatus('purchase request', req.status, from, verb);
        const set = await apply(tx, req, tenantId, companyId);
        // updated_by stays the last editor of the content: a status change has its own *_by column.
        await tx.purchaseRequest.update({ where: { id }, data: set });
        await this.audit.log({
          action: `purchase_request.${action}`,
          entityType: 'purchase_request',
          entityId: id,
          after: { status: set.status, ...(set.requestNo ? { requestNo: set.requestNo } : {}) },
        }, tx);
        return set;
      }, POSTING_TX_OPTIONS),
    );
    return this.get(id);
  }

  private async resolveLines(dto: CreatePurchaseRequestDto) {
    const refs = await this.catalog.itemsForLines(
      dto.lines.map((l) => BigInt(l.itemId)),
      dto.lines.filter((l) => l.itemUnitId).map((l) => BigInt(l.itemUnitId!)),
    );
    return dto.lines.map((l) => {
      const item = resolvePurchaseItem(refs, l);
      return {
        itemId: item.itemId,
        itemUnitId: item.itemUnitId,
        qty: item.qty,
        qtyBase: item.qtyBase,
        estimatedPrice: l.estimatedPrice ?? null,
        note: l.note ?? null,
      };
    });
  }
}
