import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { assertCanApprove, isAuthor, readApprover } from '../../common/procurement/approval.js';
import { assertProcurementLevel, lockProcurementLevel } from '../../common/procurement/procurement-level.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { CatalogService } from '../inventory/catalog.service.js';
import { WarehousesService } from '../inventory/warehouses.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { assertExpenseAccount } from '../shared/expense-account.js';
import type { CreateIssueRequestDto, ListIssueRequestsQueryDto } from './dto/issue-requests.dto.js';
import { assertStatus } from './procurement-locks.js';
import { isStocked } from '../../common/inventory/item-kind.js';

/** Statuses that count as open for the procurement level (ADR-026 §9). */
export const OPEN_ISSUE_REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED'] as const;

const itemRef = { select: { id: true, code: true, nameAr: true, nameEn: true, baseUnitId: true, itemKind: true } } as const;

type Num = { toString(): string };
const big = (v: bigint | number | null) => (v === null ? null : BigInt(v));

/** An issue request as an issue reads it, under its lock. */
export interface LockedIssueRequest {
  id: bigint;
  requestNo: string | null;
  status: string;
  branchId: bigint | null;
  warehouseId: bigint;
  costCenterId: bigint | null;
  expenseAccountId: bigint | null;
  /** By id, ascending; quantities in base units. */
  lines: Map<bigint, { id: bigint; lineNo: number; itemId: bigint; qty: Decimal; issuedQty: Decimal }>;
}

interface LockedRow {
  id: bigint;
  status: string;
  branch_id: bigint | null;
  created_by: bigint | null;
  updated_by: bigint | null;
  submitted_by: bigint | null;
  request_date: Date;
}

/**
 * Issue requests (ADR-026 §9, FULL level only): a department asks the store
 * for items. DRAFT → SUBMITTED → APPROVED (numbered IRQ, purchase.approve, no
 * self-approval but the owner's, no amount limit), or REJECTED / CANCELLED;
 * CLOSED by hand or once its goods issues take every line. The issues
 * themselves are goods notes (GIN): the goods-notes module locks the request
 * and records what it issued through lockForIssue / recordIssue. No journal
 * entry or stock movement here.
 */
@Injectable()
export class IssueRequestsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly warehouses: WarehousesService,
    private readonly costCenters: CostCentersService,
  ) {}

  /** Open requests of the tenant, for the level change (ADR-026 §9). */
  countOpen(tx: Prisma.TransactionClient): Promise<number> {
    return tx.issueRequest.count({ where: { status: { in: [...OPEN_ISSUE_REQUEST_STATUSES] } } });
  }

  /** ADR-024 §1.7: a cost centre on an issue request is in use. */
  async costCenterInUse(tx: Prisma.TransactionClient, costCenterId: bigint): Promise<string | null> {
    return (await tx.issueRequest.findFirst({ where: { costCenterId }, select: { id: true } })) ? 'issue_requests' : null;
  }

  async list(query: ListIssueRequestsQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.IssueRequestWhereInput = {
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
    const orderBy = orderByOf<'requestDate' | 'requestNo', Prisma.IssueRequestOrderByWithRelationInput>(
      query.sort,
      '-requestDate',
      { requestDate: (dir) => ({ requestDate: dir }), requestNo: (dir) => ({ requestNo: dir }) },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) => {
        const page = await tx.issueRequest.findMany({
          where,
          include: {
            warehouse: { select: { id: true, code: true, nameAr: true } },
            costCenter: { select: { id: true, code: true, nameAr: true } },
          },
          orderBy,
          ...window,
        });
        return withLineCounts(page, 'requestId', (ids) =>
          tx.issueRequestLine.groupBy({ by: ['requestId'], where: { requestId: { in: ids } }, _count: { _all: true } }),
        );
      },
      count: (tx) => tx.issueRequest.count({ where }),
    });
  }

  /** One request with its lines (and what is left to issue on each); another branch's answers 404. */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const req = await db.issueRequest.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        warehouse: { select: { id: true, code: true, nameAr: true } },
        costCenter: { select: { id: true, code: true, nameAr: true } },
        expenseAccount: { select: { id: true, code: true, nameAr: true } },
        lines: { orderBy: { lineNo: 'asc' }, include: { item: itemRef } },
      },
    });
    if (!req) throw DomainError.notFound('IssueRequest', id.toString());
    return {
      ...req,
      // As a Decimal column serializes (toString), like qty and issuedQty.
      lines: req.lines.map((l) => ({ ...l, remainingQty: new Decimal(l.qty.toString()).minus(l.issuedQty.toString()).toString() })),
    };
  }

  async create(dto: CreateIssueRequestDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const wh = await this.warehouses.activeRef(BigInt(dto.warehouseId));
    assertBranchAllowed(wh.branchId);
    const lines = await this.resolveLines(dto);
    const created = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        await this.assertHeader(tx, tenantId, companyId, dto);
        const req = await tx.issueRequest.create({
          data: {
            tenantId,
            companyId,
            // The issuing warehouse's branch (ADR-003); a company-wide warehouse takes none.
            branchId: wh.branchId,
            warehouseId: wh.id,
            ...this.headerColumns(dto),
            createdBy: this.support.userId() ?? null,
          },
        });
        await tx.issueRequestLine.createMany({ data: lines.map((l, i) => ({ tenantId, requestId: req.id, lineNo: i + 1, ...l })) });
        return req;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'issue_request.create', entityType: 'issue_request', entityId: created.id, after: { lines: lines.length } });
    return this.get(created.id);
  }

  async update(id: bigint, dto: CreateIssueRequestDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const wh = await this.warehouses.activeRef(BigInt(dto.warehouseId));
    assertBranchAllowed(wh.branchId);
    const lines = await this.resolveLines(dto);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        const req = await this.lockRow(tx, tenantId, id);
        assertBranchAllowed(req.branch_id);
        assertStatus('issue request', req.status, ['DRAFT'], 'edited');
        await this.assertHeader(tx, tenantId, companyId, dto);
        await tx.issueRequestLine.deleteMany({ where: { requestId: id } });
        await tx.issueRequest.update({
          where: { id },
          data: {
            branchId: wh.branchId,
            warehouseId: wh.id,
            ...this.headerColumns(dto),
            updatedBy: this.support.userId() ?? null,
          },
        });
        await tx.issueRequestLine.createMany({ data: lines.map((l, i) => ({ tenantId, requestId: id, lineNo: i + 1, ...l })) });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'issue_request.update', entityType: 'issue_request', entityId: id });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        const req = await this.lockRow(tx, tenantId, id);
        assertBranchAllowed(req.branch_id);
        assertStatus('issue request', req.status, ['DRAFT'], 'deleted');
        await tx.issueRequest.delete({ where: { id } });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'issue_request.delete', entityType: 'issue_request', entityId: id });
    return { deleted: true as const };
  }

  submit(id: bigint) {
    return this.transition(id, 'submit', ['DRAFT'], async (tx) => {
      if ((await tx.issueRequestLine.count({ where: { requestId: id } })) === 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'The request has no lines');
      }
      return { status: 'SUBMITTED', submittedAt: new Date(), submittedBy: this.support.userId() ?? null };
    });
  }

  /**
   * ADR-026 §9: purchase.approve with no amount limit, never on a request one
   * created, last edited or submitted (owners aside). Numbered IRQ here.
   */
  approve(id: bigint) {
    return this.transition(id, 'approve', ['SUBMITTED'], async (tx, req, tenantId, companyId) => {
      const approver = await readApprover(tx, tenantId);
      assertCanApprove({ ...approver, amount: null, isAuthor: isAuthor(req, approver.userId) });
      const requestNo = await allocateDocumentNo(tx, tenantId, companyId, 'ISSUE_REQUEST', new Date(req.request_date));
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

  /** Cancels a submitted or approved request with a reason, while nothing is issued from it. */
  cancel(id: bigint, reason: string) {
    return this.transition(id, 'cancel', ['SUBMITTED', 'APPROVED'], async (tx, req, tenantId) => {
      const lines = await this.lockLines(tx, tenantId, id);
      if ([...lines.values()].some((l) => l.issuedQty.gt(0))) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Goods are issued on this request: close it instead', {
          status: req.status,
          action: 'cancelled',
          reason: 'HAS_ISSUES',
        });
      }
      return { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date(), cancelledBy: this.support.userId() ?? null };
    });
  }

  /** Closes an approved request by hand: nothing more is issued from it. */
  close(id: bigint) {
    return this.transition(id, 'close', ['APPROVED'], async (tx, _req, tenantId) => {
      await this.lockLines(tx, tenantId, id);
      return { status: 'CLOSED', closedAt: new Date(), closedBy: this.support.userId() ?? null };
    });
  }

  // ------------------------------------------------ for the goods-notes module

  /**
   * What is left to issue on each line of a request of the caller's branches
   * (another tenant's or branch's answers 404), with its warehouse,
   * department and expense account, for the «Issue» action's defaults. No
   * lock: the issue checks it again under them.
   */
  async issuable(id: bigint) {
    const { db } = this.support.tenant();
    const req = await db.issueRequest.findFirst({
      where: { id, AND: [branchWhere()] },
      select: {
        warehouseId: true,
        costCenterId: true,
        expenseAccountId: true,
        lines: { orderBy: { lineNo: 'asc' }, select: { id: true, itemId: true, qty: true, issuedQty: true } },
      },
    });
    if (!req) throw DomainError.notFound('IssueRequest', id.toString());
    return {
      warehouseId: req.warehouseId,
      costCenterId: req.costCenterId,
      expenseAccountId: req.expenseAccountId,
      lines: req.lines.map((l) => ({ id: l.id, itemId: l.itemId, remaining: new Decimal(l.qty.toString()).minus(l.issuedQty.toString()) })),
    };
  }

  /**
   * The request FOR UPDATE, then its lines FOR UPDATE in id order, on the
   * caller's transaction (ADR-026 §10: the request takes the order's place
   * for a goods issue). Locking reads: call before the first plain read.
   */
  async lockForIssue(tx: Prisma.TransactionClient, id: bigint): Promise<LockedIssueRequest> {
    const { tenantId } = this.support.tenant();
    const [row] = await tx.$queryRaw<
      {
        id: bigint;
        request_no: string | null;
        status: string;
        branch_id: bigint | null;
        warehouse_id: bigint;
        cost_center_id: bigint | null;
        expense_account_id: bigint | null;
      }[]
    >`
      SELECT id, request_no, status, branch_id, warehouse_id, cost_center_id, expense_account_id
        FROM issue_requests WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!row) throw DomainError.notFound('IssueRequest', id.toString());
    return {
      id: BigInt(row.id),
      requestNo: row.request_no,
      status: row.status,
      branchId: big(row.branch_id),
      warehouseId: BigInt(row.warehouse_id),
      costCenterId: big(row.cost_center_id),
      expenseAccountId: big(row.expense_account_id),
      lines: await this.lockLines(tx, tenantId, id),
    };
  }

  /**
   * ADR-026 §9: the base quantities an issue takes, per request line, within
   * what is left (qty − issued_qty); ISSUE_REQUEST_QTY_EXCEEDED otherwise.
   * Pure: `req` is the locked state.
   */
  assertWithinRequest(req: LockedIssueRequest, wanted: Map<bigint, Decimal>): void {
    for (const [lineId, qty] of wanted) {
      const line = req.lines.get(lineId);
      if (!line) throw DomainError.notFound('IssueRequestLine', lineId.toString());
      const left = line.qty.minus(line.issuedQty);
      if (qty.gt(left)) {
        throw new DomainError(ErrorCode.ISSUE_REQUEST_QTY_EXCEEDED, `Line ${line.lineNo} of the request has ${left.toFixed(6)} left to issue`, {
          requestLineId: lineId.toString(),
          lineNo: line.lineNo,
          remaining: left.toFixed(6),
          wanted: qty.toFixed(6),
        });
      }
    }
  }

  /**
   * Records a posted goods issue on the request, on the posting transaction
   * that holds its locks: issued_qty grows (checked again), and the request
   * closes once every line is issued in full (closed_by null: automatic).
   * True when it closed it.
   */
  async recordIssue(tx: Prisma.TransactionClient, req: LockedIssueRequest, issued: Map<bigint, Decimal>): Promise<boolean> {
    this.assertWithinRequest(req, issued);
    for (const [lineId, qty] of issued) {
      if (!qty.isZero()) await tx.issueRequestLine.update({ where: { id: lineId }, data: { issuedQty: { increment: qty } } });
    }
    const full = [...req.lines.values()].every((l) => l.issuedQty.plus(issued.get(l.id) ?? 0).gte(l.qty));
    if (!full) return false;
    await tx.issueRequest.update({ where: { id: req.id }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: null } });
    return true;
  }

  // ------------------------------------------------------------- internals

  private async lockRow(tx: Prisma.TransactionClient, tenantId: bigint, id: bigint): Promise<LockedRow> {
    const [row] = await tx.$queryRaw<LockedRow[]>`
      SELECT id, status, branch_id, created_by, updated_by, submitted_by, request_date FROM issue_requests
       WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!row) throw DomainError.notFound('IssueRequest', id.toString());
    return {
      ...row,
      id: BigInt(row.id),
      branch_id: big(row.branch_id),
      created_by: big(row.created_by),
      updated_by: big(row.updated_by),
      submitted_by: big(row.submitted_by),
    };
  }

  private async lockLines(tx: Prisma.TransactionClient, tenantId: bigint, requestId: bigint): Promise<LockedIssueRequest['lines']> {
    const rows = await tx.$queryRaw<{ id: bigint; line_no: number; item_id: bigint; qty: Num; issued_qty: Num }[]>`
      SELECT id, line_no, item_id, qty, issued_qty FROM issue_request_lines
       WHERE tenant_id = ${tenantId} AND request_id = ${requestId}
       ORDER BY id FOR UPDATE`;
    return new Map(
      rows.map((r) => [
        BigInt(r.id),
        {
          id: BigInt(r.id),
          lineNo: Number(r.line_no),
          itemId: BigInt(r.item_id),
          qty: new Decimal(r.qty.toString()),
          issuedQty: new Decimal(r.issued_qty.toString()),
        },
      ]),
    );
  }

  /** The department centre (share-locked, ADR-024 §1.4) and the expense account (ADR-026 §8). */
  private async assertHeader(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, dto: CreateIssueRequestDto) {
    if (dto.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, BigInt(dto.costCenterId));
    if (dto.expenseAccountId) await assertExpenseAccount(tx, companyId, BigInt(dto.expenseAccountId));
  }

  private headerColumns(dto: CreateIssueRequestDto) {
    return {
      requestDate: new Date(dto.requestDate),
      costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
      expenseAccountId: dto.expenseAccountId ? BigInt(dto.expenseAccountId) : null,
      notes: dto.notes ?? null,
    };
  }

  /** Stocked, active items of the company, base quantities above 0. */
  private async resolveLines(dto: CreateIssueRequestDto) {
    const refs = await this.catalog.itemsForLines(dto.lines.map((l) => BigInt(l.itemId)), []);
    return dto.lines.map((l) => {
      const item = refs.items.get(BigInt(l.itemId));
      if (!item) throw DomainError.notFound('Item', l.itemId);
      if (!isStocked(item.itemKind)) {
        throw new DomainError(ErrorCode.VALIDATION, `Item ${item.code} is a service — nothing to issue`);
      }
      const qty = new Decimal(l.qty);
      if (qty.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
      return { itemId: item.id, qty, note: l.note ?? null };
    });
  }

  /**
   * One status change under the locks (company level shared, then the
   * request), retried on a lock conflict. Audited as issue_request.<action>.
   */
  private async transition(
    id: bigint,
    action: 'submit' | 'approve' | 'reject' | 'cancel' | 'close',
    from: readonly string[],
    apply: (tx: Prisma.TransactionClient, req: LockedRow, tenantId: bigint, companyId: bigint) => Promise<Prisma.IssueRequestUpdateInput>,
  ) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const verb = { submit: 'submitted', approve: 'approved', reject: 'rejected', cancel: 'cancelled', close: 'closed' }[action];
    const data = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        assertProcurementLevel(await lockProcurementLevel(tx, tenantId, companyId), 'FULL');
        const req = await this.lockRow(tx, tenantId, id);
        assertBranchAllowed(req.branch_id);
        assertStatus('issue request', req.status, from, verb);
        const set = await apply(tx, req, tenantId, companyId);
        // updated_by stays the last editor of the content: a status change has its own *_by column.
        await tx.issueRequest.update({ where: { id }, data: set });
        return set;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({
      action: `issue_request.${action}`,
      entityType: 'issue_request',
      entityId: id,
      after: {
        status: data.status,
        ...(data.requestNo ? { requestNo: data.requestNo } : {}),
        ...(data.cancelReason ? { reason: data.cancelReason } : {}),
        ...(data.rejectReason ? { reason: data.rejectReason } : {}),
      },
    });
    return this.get(id);
  }
}
