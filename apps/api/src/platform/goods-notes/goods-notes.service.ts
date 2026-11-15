import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, branchWhere, currentBranchId } from '../../common/branch/branch-context.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { OWNER_ROLE } from '../../common/permissions/member-permissions.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { readMemberGrant } from '../../common/procurement/approval.js';
import { assertProcurementLevel, lockProcurementLevel } from '../../common/procurement/procurement-level.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type {
  CreateGoodsNoteDto,
  GoodsNoteLineDto,
  IssueFromRequestDto,
  ReceivePurchaseOrderDto,
} from './dto/goods-notes.dto.js';
import type { ListGoodsNotesQueryDto } from '../inventory/dto/list-queries.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { Prisma, type ProcurementLevel } from '../../generated/prisma/client.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';
import { assertExpenseAccount } from '../shared/expense-account.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { CostCenterUsageRegistry } from '../cost-centers/cost-center-usage.registry.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';
import {
  orderLineUnitCost,
  PurchaseOrderReceiptsService,
  RECEIVABLE_ORDER_STATUSES,
  type LockedOrder,
} from '../procurement/purchase-order-receipts.service.js';
import { IssueRequestsService, type LockedIssueRequest } from '../procurement/issue-requests.service.js';

/** A goods receipt note as a purchase invoice bills it (TRADE-02, ADR-016). */
export interface GrnBillingSource {
  id: bigint;
  docNo: string | null;
  status: 'DRAFT' | 'POSTED';
  noteType: 'GRN' | 'GIN';
  warehouseId: bigint;
  /** The purchase order it received against (ADR-026); billed through its lines, not as a whole. */
  purchaseOrderId: bigint | null;
  /** Base quantity and value received per item; value = Σ round3(qty × unit cost), as the movements. */
  byItem: Map<bigint, { qty: Decimal; value: Decimal }>;
}

/** A GRN line received against an order, as an invoice bills it (ADR-026 §7). */
export interface ReceiptLine {
  id: bigint;
  noteId: bigint;
  docNo: string | null;
  noteStatus: 'DRAFT' | 'POSTED';
  noteType: 'GRN' | 'GIN';
  purchaseOrderId: bigint | null;
  warehouseId: bigint;
  itemId: bigint;
  poLineId: bigint | null;
  /** Base quantity received. */
  qty: Decimal;
  unitCost: Decimal;
  /** round3(qty × unit cost): the movement's value, what the GRN credited to 2104. */
  value: Decimal;
  billedQty: Decimal;
  clearedValue: Decimal;
}

/** A line as written to goods_note_lines. */
interface NoteLineRow {
  itemId: bigint;
  qty: Decimal;
  unitCost: Decimal | null;
  poLineId: bigint | null;
  issueRequestLineId: bigint | null;
}

/** A draft's header and lines, resolved and checked under the locks. */
interface PreparedNote {
  branchId: bigint | null;
  warehouseId: bigint;
  supplierId: bigint | null;
  expenseAccountId: bigint | null;
  costCenterId: bigint | null;
  lines: NoteLineRow[];
}

type Num = { toString(): string };
const dec = (v: Num) => new Decimal(v.toString());
const sumBy = <K>(rows: { key: K; qty: Decimal }[]) => {
  const out = new Map<K, Decimal>();
  for (const r of rows) out.set(r.key, (out.get(r.key) ?? new Decimal(0)).plus(r.qty));
  return out;
};

/**
 * Goods notes — GRN (استلام بضاعة) and GIN (صرف بضاعة): stock movements
 * without an invoice (§7.4-style documents).
 *  GRN: Dr INVENTORY / Cr GOODS_RECEIVED_NOT_INVOICED (2104)
 *  GIN: Dr INVENTORY_ADJUSTMENT / Cr INVENTORY, or Dr the department's
 *       expense account (with its cost centre) when one is given (ADR-026 §8)
 * Phase 13 (ADR-026): a GRN against an approved purchase order (§5) records
 * the order's supplier and takes the order's net price as its cost; a GIN
 * from an approved issue request (§9); at FULL a GIN without one needs
 * stock.issue_without_request.
 * Branch (ADR-003): the warehouse's branch, or the request branch when the
 * warehouse has none. Never taken from the body.
 *
 * Lock order (ADR-026 §10): company (shared) → order or issue request → its
 * lines by id → the note → item_costs → stock_balances.
 */
@Injectable()
export class GoodsNotesService implements OnModuleInit {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly costCenters: CostCentersService,
    private readonly orders: PurchaseOrderReceiptsService,
    private readonly issueRequests: IssueRequestsService,
    private readonly partyUsage: PartyUsageRegistry,
    private readonly costCenterUsage: CostCenterUsageRegistry,
  ) {}

  onModuleInit(): void {
    // ADR-021 / ADR-024 §1.7: a GRN against an order names its supplier; a GIN its department.
    this.partyUsage.register('goods-notes', async (tx, partyId) =>
      (await tx.goodsNote.findFirst({ where: { supplierId: partyId }, select: { id: true } })) ? 'goods_notes' : null,
    );
    this.costCenterUsage.register('goods-notes', async (tx, id) =>
      (await tx.goodsNote.findFirst({ where: { costCenterId: id }, select: { id: true } })) ? 'goods_notes' : null,
    );
  }

  /**
   * One numbered page of goods notes (ADR-022), newest first unless `sort` says
   * otherwise. A note belongs to its own branch (ADR-003 §10).
   */
  async list(query: ListGoodsNotesQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', {
        from: query.from,
        to: query.to,
      });
    }
    const q = query.q;
    const where: Prisma.GoodsNoteWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.noteType ? { noteType: query.noteType } : {}),
      ...(query.purchaseOrderId ? { purchaseOrderId: BigInt(query.purchaseOrderId) } : {}),
      ...(query.issueRequestId ? { issueRequestId: BigInt(query.issueRequestId) } : {}),
      ...(query.from || query.to
        ? {
            noteDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [
        branchWhere(),
        q ? { OR: [{ docNo: { contains: q } }, { description: { contains: q } }] } : {},
      ],
    };
    const orderBy = orderByOf<'date' | 'docNo', Prisma.GoodsNoteOrderByWithRelationInput>(
      query.sort,
      '-date',
      {
        date: (dir) => ({ noteDate: dir }),
        docNo: (dir) => ({ docNo: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) =>
        withLineCounts(
          await tx.goodsNote.findMany({
            where,
            include: {
              warehouse: { select: { id: true, code: true, nameAr: true } },
              branch: { select: { id: true, code: true, nameAr: true } },
            },
            orderBy,
            ...window,
          }),
          'noteId',
          // Line counts of this page only (see withLineCounts).
          (ids) => tx.goodsNoteLine.groupBy({ by: ['noteId'], where: { noteId: { in: ids } }, _count: { _all: true } }),
        ),
      count: (tx) => tx.goodsNote.count({ where }),
    });
  }

  /** One note; another branch's answers 404 like another tenant's (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const note = await db.goodsNote.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        warehouse: true,
        branch: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { item: { select: { id: true, code: true, nameAr: true } } },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
        purchaseOrder: { select: { id: true, orderNo: true, status: true } },
        supplier: { select: { id: true, code: true, nameAr: true } },
        expenseAccount: { select: { id: true, code: true, nameAr: true } },
        costCenter: { select: { id: true, code: true, nameAr: true } },
        issueRequest: { select: { id: true, requestNo: true, status: true } },
      },
    });
    if (!note) throw DomainError.notFound('GoodsNote', id.toString());
    return note;
  }

  async create(dto: CreateGoodsNoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    this.assertShape(dto);
    const orderId = dto.purchaseOrderId ? BigInt(dto.purchaseOrderId) : null;
    const requestId = dto.issueRequestId ? BigInt(dto.issueRequestId) : null;

    const note = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const locks = await this.lockSources(tx, tenantId, companyId, orderId, requestId, true);
        const p = await this.prepare(tx, tenantId, companyId, dto, locks, null);
        const created = await tx.goodsNote.create({
          data: {
            tenantId,
            companyId,
            branchId: p.branchId,
            warehouseId: p.warehouseId,
            noteDate: new Date(dto.noteDate),
            noteType: dto.noteType,
            description: dto.description ?? null,
            purchaseOrderId: orderId,
            supplierId: p.supplierId,
            expenseAccountId: p.expenseAccountId,
            costCenterId: p.costCenterId,
            issueRequestId: requestId,
          },
        });
        await this.writeLines(tx, tenantId, created.id, p.lines);
        return created;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({
      action: 'goods_note.create',
      entityType: 'goods_note',
      entityId: note.id,
      after: {
        noteType: dto.noteType,
        lines: dto.lines.length,
        ...(orderId ? { purchaseOrderId: orderId.toString() } : {}),
        ...(requestId ? { issueRequestId: requestId.toString() } : {}),
      },
    });
    return this.get(note.id);
  }

  async update(id: bigint, dto: CreateGoodsNoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    this.assertShape(dto);
    // The order or request never changes after creation (read before the
    // transaction to lock it first, ADR-026 §10); another tenant's id is 404.
    const head = await db.goodsNote.findFirst({ where: { id }, select: { purchaseOrderId: true, issueRequestId: true } });
    if (!head) throw DomainError.notFound('GoodsNote', id.toString());
    const orderId = dto.purchaseOrderId ? BigInt(dto.purchaseOrderId) : null;
    const requestId = dto.issueRequestId ? BigInt(dto.issueRequestId) : null;
    if (orderId !== head.purchaseOrderId || requestId !== head.issueRequestId) {
      throw new DomainError(ErrorCode.VALIDATION, "A note's purchase order and issue request are set when it is created and never change");
    }

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const locks = await this.lockSources(tx, tenantId, companyId, orderId, requestId, true);
        // The note after its order (ADR-026 §10), then re-checked under the lock:
        // a save racing a post of the same draft never rewrites a posted note.
        const note = await this.lockNote(tx, tenantId, id);
        if (note.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Only draft notes can be modified');
        }
        assertBranchAllowed(note.branch_id);
        const p = await this.prepare(tx, tenantId, companyId, dto, locks, note);
        await tx.goodsNoteLine.deleteMany({ where: { noteId: id } });
        await tx.goodsNote.update({
          where: { id },
          data: {
            noteDate: new Date(dto.noteDate),
            noteType: dto.noteType,
            branchId: p.branchId,
            warehouseId: p.warehouseId,
            description: dto.description ?? null,
            supplierId: p.supplierId,
            expenseAccountId: p.expenseAccountId,
            costCenterId: p.costCenterId,
          },
        });
        await this.writeLines(tx, tenantId, id, p.lines);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'goods_note.update', entityType: 'goods_note', entityId: id });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const note = await db.goodsNote.findFirst({ where: { id } });
    if (!note) throw DomainError.notFound('GoodsNote', id.toString());
    if (note.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft notes can be deleted');
    }
    assertBranchAllowed(note.branchId);
    await db.goodsNote.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * POST /purchase-orders/:id/receive (ADR-026 §5): a draft GRN against the
   * order, dated `noteDate`, for the given base quantities, or for what is
   * left on every line. Posting it receives the goods.
   */
  async receive(orderId: bigint, dto: ReceivePurchaseOrderDto) {
    // Another tenant's or branch's order answers 404 before anything else.
    const order = await this.orders.receivable(orderId);
    const byId = new Map(order.lines.map((l) => [l.id, l]));
    const wanted =
      dto.lines?.map((l) => {
        const line = byId.get(BigInt(l.poLineId));
        if (!line) throw DomainError.notFound('PurchaseOrderLine', l.poLineId);
        return { itemId: line.itemId.toString(), qty: l.qty, poLineId: l.poLineId };
      }) ??
      order.lines
        .filter((l) => l.remaining.gt(0))
        .map((l) => ({ itemId: l.itemId.toString(), qty: l.remaining.toString(), poLineId: l.id.toString() }));
    if (wanted.length === 0) {
      throw new DomainError(ErrorCode.PURCHASE_ORDER_OVER_RECEIPT, 'Nothing is left to receive on this order', { remaining: '0' });
    }
    return this.create({
      noteDate: dto.noteDate,
      noteType: 'GRN',
      warehouseId: order.warehouseId.toString(),
      description: dto.description,
      purchaseOrderId: orderId.toString(),
      lines: wanted,
    });
  }

  /**
   * POST /issue-requests/:id/issue (ADR-026 §9): a draft GIN from the approved
   * request, with its warehouse, department and expense account, for the
   * given base quantities or what is left on every line.
   */
  async issueFromRequest(requestId: bigint, dto: IssueFromRequestDto) {
    const req = await this.issueRequests.issuable(requestId);
    const byId = new Map(req.lines.map((l) => [l.id, l]));
    const wanted =
      dto.lines?.map((l) => {
        const line = byId.get(BigInt(l.issueRequestLineId));
        if (!line) throw DomainError.notFound('IssueRequestLine', l.issueRequestLineId);
        return { itemId: line.itemId.toString(), qty: l.qty, issueRequestLineId: l.issueRequestLineId };
      }) ??
      req.lines
        .filter((l) => l.remaining.gt(0))
        .map((l) => ({ itemId: l.itemId.toString(), qty: l.remaining.toString(), issueRequestLineId: l.id.toString() }));
    if (wanted.length === 0) {
      throw new DomainError(ErrorCode.ISSUE_REQUEST_QTY_EXCEEDED, 'Nothing is left to issue on this request', { remaining: '0' });
    }
    return this.create({
      noteDate: dto.noteDate,
      noteType: 'GIN',
      warehouseId: req.warehouseId.toString(),
      description: dto.description,
      issueRequestId: requestId.toString(),
      expenseAccountId: req.expenseAccountId?.toString(),
      costCenterId: req.costCenterId?.toString(),
      lines: wanted,
    });
  }

  // ------------------------------------------------------ billing (purchases)

  /**
   * The GRN a purchase invoice bills, locked FOR UPDATE on the caller's
   * transaction: two invoices billing the same GRN queue here, so it is
   * billed once (TRADE-02). Null when it does not exist.
   */
  async lockForBilling(tx: Prisma.TransactionClient, id: bigint): Promise<GrnBillingSource | null> {
    const { tenantId } = this.support.tenant();
    const [locked] = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM goods_notes WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!locked) return null;
    return this.billingSource(tx, id);
  }

  /**
   * A GRN's received quantity and value per item, without a lock: a posted
   * GRN never changes. A purchase return of the invoice that billed it takes
   * the goods out at this received cost (TRADE-02/03, ADR-016 §3).
   */
  async billingSource(tx: Prisma.TransactionClient, id: bigint): Promise<GrnBillingSource | null> {
    const note = await tx.goodsNote.findFirst({ where: { id }, include: { lines: true } });
    if (!note) return null;
    const byItem = new Map<bigint, { qty: Decimal; value: Decimal }>();
    for (const l of note.lines) {
      const cur = byItem.get(l.itemId) ?? { qty: new Decimal(0), value: new Decimal(0) };
      byItem.set(l.itemId, {
        qty: cur.qty.plus(l.qty.toString()),
        value: cur.value.plus(round3(new Decimal(l.qty.toString()).times(l.unitCost?.toString() ?? 0))),
      });
    }
    return {
      id: note.id,
      docNo: note.docNo,
      status: note.status,
      noteType: note.noteType,
      warehouseId: note.warehouseId,
      purchaseOrderId: note.purchaseOrderId,
      byItem,
    };
  }

  /**
   * ADR-026 §7/§10: the GRNs an invoice bills FOR UPDATE (ascending id),
   * then their lines FOR UPDATE (ascending id), on the posting transaction,
   * after the order and before the invoice. Locking reads: billed_qty and
   * cleared_value are the latest committed. Keyed by line id; only the
   * lines of `noteIds` (the caller checks every line it bills is here).
   */
  async lockReceiptLines(tx: Prisma.TransactionClient, noteIds: bigint[]): Promise<Map<bigint, ReceiptLine>> {
    const { tenantId } = this.support.tenant();
    const ids = [...new Set(noteIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (ids.length === 0) return new Map();
    const notes = await tx.$queryRaw<
      { id: bigint; doc_no: string | null; status: 'DRAFT' | 'POSTED'; note_type: 'GRN' | 'GIN'; purchase_order_id: bigint | null; warehouse_id: bigint }[]
    >`
      SELECT id, doc_no, status, note_type, purchase_order_id, warehouse_id FROM goods_notes
       WHERE tenant_id = ${tenantId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
    const rows = await tx.$queryRaw<
      { id: bigint; note_id: bigint; item_id: bigint; po_line_id: bigint | null; qty: Num; unit_cost: Num | null; billed_qty: Num; cleared_value: Num }[]
    >`
      SELECT id, note_id, item_id, po_line_id, qty, unit_cost, billed_qty, cleared_value FROM goods_note_lines
       WHERE tenant_id = ${tenantId} AND note_id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
    return this.receiptLines(notes, rows);
  }

  /**
   * The same lines without locks, for a draft invoice's checks and the
   * «billable» view: the posted GRN lines of `noteIds`, or of every GRN of
   * `orderId`. Posting checks them again under lockReceiptLines.
   */
  async receiptLinesOf(
    tx: Pick<Prisma.TransactionClient, 'goodsNote'>,
    where: { orderId: bigint } | { lineIds: bigint[] },
  ): Promise<Map<bigint, ReceiptLine>> {
    const notes = await tx.goodsNote.findMany({
      where:
        'orderId' in where
          ? { purchaseOrderId: where.orderId, noteType: 'GRN', status: 'POSTED' }
          : { lines: { some: { id: { in: where.lineIds } } } },
      include: { lines: true },
      orderBy: { id: 'asc' },
    });
    return this.receiptLines(
      notes.map((n) => ({
        id: n.id,
        doc_no: n.docNo,
        status: n.status,
        note_type: n.noteType,
        purchase_order_id: n.purchaseOrderId,
        warehouse_id: n.warehouseId,
      })),
      notes.flatMap((n) =>
        n.lines.map((l) => ({
          id: l.id,
          note_id: l.noteId,
          item_id: l.itemId,
          po_line_id: l.poLineId,
          qty: l.qty,
          unit_cost: l.unitCost,
          billed_qty: l.billedQty,
          cleared_value: l.clearedValue,
        })),
      ),
    );
  }

  /**
   * Records a posted invoice's billing on its GRN lines (locked by
   * lockReceiptLines on the same transaction): billed_qty and cleared_value
   * grow by what it billed and cleared (ADR-026 §7).
   */
  async recordBilling(tx: Prisma.TransactionClient, billed: Map<bigint, { qty: Decimal; cleared: Decimal }>): Promise<void> {
    for (const [lineId, b] of billed) {
      await tx.goodsNoteLine.update({
        where: { id: lineId },
        data: { billedQty: { increment: b.qty }, clearedValue: { increment: b.cleared } },
      });
    }
  }

  // ---------------------------------------------------------------- posting

  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    // The order and request never change after creation: read them first to lock them first (ADR-026 §10).
    const head = await db.goodsNote.findFirst({ where: { id }, select: { purchaseOrderId: true, issueRequestId: true } });
    if (!head) throw DomainError.notFound('GoodsNote', id.toString());

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // Company (shared), then the order or the issue request with its lines,
        // then the document itself (§10.1 step 7), all locking reads ahead of
        // the first plain read, so every later read sees the latest committed
        // state and two concurrent requests cannot both post it or both take
        // the same order quantity.
        const locks = await this.lockSources(tx, tenantId, companyId, head.purchaseOrderId, head.issueRequestId, false);
        await this.lockNote(tx, tenantId, id);
        const draft = await tx.goodsNote.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('GoodsNote', id.toString());
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Note is not a draft');
        }
        assertBranchAllowed(draft.branchId);
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Note has no lines');
        }
        if (draft.purchaseOrderId !== head.purchaseOrderId || draft.issueRequestId !== head.issueRequestId) {
          throw new DomainError(ErrorCode.CONFLICT, 'The note changed while posting; try again');
        }

        const noteDate = new Date(draft.noteDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, noteDate);
        const isGrn = draft.noteType === 'GRN';

        // ADR-026 §5/§9: checked again under the order's (or request's) locks.
        const received = locks.order ? this.checkReceipt(locks.order, draft.warehouseId, draft.lines) : null;
        const issued = locks.request ? this.checkIssue(locks, draft.warehouseId, draft.lines) : null;
        if (!isGrn && !locks.request) await this.assertIssueWithoutRequest(tx, tenantId, locks.level);
        if (draft.expenseAccountId) await assertExpenseAccount(tx, companyId, draft.expenseAccountId);

        // Lock every (item, warehouse) in the fixed order before any movement.
        await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
        );

        let totalCost = new Decimal(0);
        let writeOff = new Decimal(0);
        for (const line of draft.lines) {
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.warehouseId,
            itemId: line.itemId,
            movementDate: noteDate,
            type: isGrn ? 'IN' : 'OUT',
            qty: line.qty.toString(),
            unitCost: isGrn ? (line.unitCost?.toString() ?? undefined) : undefined,
            sourceType: isGrn ? 'GOODS_RECEIPT' : 'GOODS_ISSUE',
            sourceId: draft.id,
            sourceLineId: line.id,
            description: `${draft.noteType} ${draft.id}`,
          });
          totalCost = totalCost.plus(res.totalCost);
          writeOff = writeOff.plus(res.writeOff);
        }

        if (locks.order && received) await this.orders.recordReceipt(tx, locks.order, received);
        const closedRequest = locks.request && issued ? await this.issueRequests.recordIssue(tx, locks.request, issued) : false;

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
          'INVENTORY_ADJUSTMENT',
          'GOODS_RECEIVED_NOT_INVOICED',
        ]);

        const journalLines: JournalLineInput[] = [];
        if (totalCost.gt(0)) {
          if (isGrn) {
            journalLines.push({ accountId: mapping.INVENTORY, debit: totalCost.toString() });
            journalLines.push({
              accountId: mapping.GOODS_RECEIVED_NOT_INVOICED,
              credit: totalCost.toString(),
            });
          } else {
            // ADR-026 §8: the department's expense account, else the old INVENTORY_ADJUSTMENT.
            journalLines.push({ accountId: draft.expenseAccountId ?? mapping.INVENTORY_ADJUSTMENT, debit: totalCost.toString() });
            journalLines.push({ accountId: mapping.INVENTORY, credit: totalCost.toString() });
          }
        }
        journalLines.push(
          ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
        );

        const docType = isGrn ? 'GOODS_RECEIPT' : 'GOODS_ISSUE';
        const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, docType, noteDate);
        let entryId: bigint | null = null;
        if (journalLines.length > 0) {
          const entry = await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: noteDate,
            fiscalPeriodId: period.id,
            sourceType: docType,
            sourceId: draft.id,
            branchId: draft.branchId,
            description: draft.description ?? `${draft.noteType} ${docNo}`,
            lines: journalLines,
            postedBy: userId ?? null,
            // ADR-024 §1.2 / ADR-026 §8: the department onto the income-statement lines.
            costCenterId: draft.costCenterId,
            // ADR-024 §1.3: a GIN to a department has a centre field, so a flagged
            // expense account needs one; a note without one keeps the old rule.
            requireCostCenters: draft.expenseAccountId !== null,
          });
          entryId = entry.id;
        }

        await tx.goodsNote.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            docNo,
            journalEntryId: entryId,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        return { id: draft.id, docNo, closedRequest: closedRequest ? locks.request!.id : null };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'goods_note.post',
      entityType: 'goods_note',
      entityId: result.id,
      after: { docNo: result.docNo },
    });
    if (result.closedRequest) {
      await this.audit.log({ action: 'issue_request.close', entityType: 'issue_request', entityId: result.closedRequest, after: { reason: 'fully_issued' } });
    }
    return this.get(result.id);
  }

  // ------------------------------------------------------------- internals

  /** Body rules that need no database: which fields go with which note. */
  private assertShape(dto: CreateGoodsNoteDto): void {
    const isGrn = dto.noteType === 'GRN';
    if (isGrn && (dto.expenseAccountId || dto.costCenterId || dto.issueRequestId || dto.lines.some((l) => l.issueRequestLineId))) {
      throw new DomainError(ErrorCode.VALIDATION, 'A goods receipt takes no expense account, cost centre or issue request');
    }
    if (!isGrn && (dto.purchaseOrderId || dto.lines.some((l) => l.poLineId))) {
      throw new DomainError(ErrorCode.VALIDATION, 'A goods issue takes no purchase order');
    }
    if (!dto.purchaseOrderId && dto.lines.some((l) => l.poLineId)) {
      throw new DomainError(ErrorCode.VALIDATION, 'poLineId needs purchaseOrderId');
    }
    if (!dto.issueRequestId && dto.lines.some((l) => l.issueRequestLineId)) {
      throw new DomainError(ErrorCode.VALIDATION, 'issueRequestLineId needs issueRequestId');
    }
    for (const l of dto.lines) {
      if (new Decimal(l.qty).lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
      if (dto.purchaseOrderId) {
        if (!l.poLineId) throw new DomainError(ErrorCode.VALIDATION, 'Every line of a receipt against an order names its order line');
        if (l.unitCost) {
          throw new DomainError(ErrorCode.VALIDATION, "A receipt against an order takes the order's price; unitCost is not accepted", {
            field: 'unitCost',
          });
        }
      } else if (isGrn && !l.unitCost) {
        throw new DomainError(ErrorCode.VALIDATION, 'unitCost is required for GRN lines');
      }
      if (dto.issueRequestId && !l.issueRequestLineId) {
        throw new DomainError(ErrorCode.VALIDATION, 'Every line of an issue from a request names its request line');
      }
    }
  }

  /**
   * The locks ahead of the note (ADR-026 §10): the company row shared (the
   * level), then the order and its lines, or the issue request and its
   * lines. `draft`: a draft only reads the order, so it takes it shared.
   */
  private async lockSources(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    orderId: bigint | null,
    requestId: bigint | null,
    draft: boolean,
  ): Promise<{ level: ProcurementLevel; order: LockedOrder | null; request: LockedIssueRequest | null }> {
    const level = await lockProcurementLevel(tx, tenantId, companyId);
    const order = orderId !== null ? await this.orders.lockOrder(tx, orderId, draft) : null;
    let request: LockedIssueRequest | null = null;
    if (requestId !== null) {
      // Issue requests are a FULL-level document (ADR-026 §9).
      assertProcurementLevel(level, 'FULL');
      request = await this.issueRequests.lockForIssue(tx, requestId);
    }
    return { level, order, request };
  }

  private async lockNote(tx: Prisma.TransactionClient, tenantId: bigint, id: bigint) {
    const [row] = await tx.$queryRaw<{ id: bigint; status: string; branch_id: bigint | null; warehouse_id: bigint }[]>`
      SELECT id, status, branch_id, warehouse_id FROM goods_notes WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!row) throw DomainError.notFound('GoodsNote', id.toString());
    return { ...row, branch_id: row.branch_id === null ? null : BigInt(row.branch_id), warehouse_id: BigInt(row.warehouse_id) };
  }

  /**
   * A draft's header and lines, checked on the draft's transaction after the
   * locks. A plain GRN or GIN follows the rules it always had; a receipt
   * against an order or an issue from a request follows ADR-026 §5 / §9.
   */
  private async prepare(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    dto: CreateGoodsNoteDto,
    locks: { level: ProcurementLevel; order: LockedOrder | null; request: LockedIssueRequest | null },
    existing: { branch_id: bigint | null; warehouse_id: bigint } | null,
  ): Promise<PreparedNote> {
    const warehouse = await tx.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true, branchId: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);
    // A new note, or another warehouse: that warehouse's branch; same warehouse: the note keeps its branch.
    const branchId =
      existing && existing.warehouse_id === warehouse.id && existing.branch_id != null
        ? existing.branch_id
        : (warehouse.branchId ?? currentBranchId());
    assertBranchAllowed(branchId);

    const items = await tx.item.findMany({
      where: { tenantId, companyId, id: { in: dto.lines.map((l) => BigInt(l.itemId)) }, isActive: true },
      select: { id: true, code: true, itemKind: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of dto.lines) {
      const item = byId.get(BigInt(l.itemId));
      if (!item) throw DomainError.notFound('Item', l.itemId);
      if (item.itemKind !== 'STOCK') {
        throw new DomainError(ErrorCode.VALIDATION, `Item ${item.code} is a service — no stock note allowed`);
      }
    }

    if (locks.order) {
      const order = locks.order;
      assertBranchAllowed(order.branchId);
      this.assertReceivable(order);
      const lines = dto.lines.map((l) => ({ dto: l, poLine: this.orderLine(order, l) }));
      this.checkReceipt(order, warehouse.id, lines.map((l) => ({ itemId: BigInt(l.dto.itemId), qty: l.dto.qty, poLineId: l.poLine.id })));
      return {
        // ADR-026 §5: the order's branch (its warehouse's, ADR-025 §12).
        branchId: order.branchId ?? branchId,
        warehouseId: warehouse.id,
        supplierId: order.supplierId,
        expenseAccountId: null,
        costCenterId: null,
        lines: lines.map((l) => ({
          itemId: l.poLine.itemId,
          qty: new Decimal(l.dto.qty),
          // ADR-026 §5: the order's net price per base unit, 6 dp; never from the body.
          unitCost: orderLineUnitCost(l.poLine),
          poLineId: l.poLine.id,
          issueRequestLineId: null,
        })),
      };
    }

    let expenseAccountId: bigint | null = null;
    let costCenterId: bigint | null = null;
    if (dto.noteType === 'GIN') {
      if (locks.request) {
        assertBranchAllowed(locks.request.branchId);
        this.checkIssue(
          locks,
          warehouse.id,
          dto.lines.map((l) => ({ itemId: BigInt(l.itemId), qty: l.qty, issueRequestLineId: BigInt(l.issueRequestLineId!) })),
        );
      } else {
        await this.assertIssueWithoutRequest(tx, tenantId, locks.level);
      }
      // Share-lock the centre before the row that references it (ADR-024 §1.4).
      if (dto.costCenterId) {
        costCenterId = BigInt(dto.costCenterId);
        await this.costCenters.assertUsable(tx, tenantId, companyId, costCenterId);
      }
      if (dto.expenseAccountId) {
        expenseAccountId = BigInt(dto.expenseAccountId);
        await assertExpenseAccount(tx, companyId, expenseAccountId);
      }
    }
    return {
      branchId,
      warehouseId: warehouse.id,
      supplierId: null,
      expenseAccountId,
      costCenterId,
      lines: dto.lines.map((l) => ({
        itemId: BigInt(l.itemId),
        qty: new Decimal(l.qty),
        unitCost: dto.noteType === 'GRN' ? new Decimal(l.unitCost!) : null,
        poLineId: null,
        issueRequestLineId: l.issueRequestLineId ? BigInt(l.issueRequestLineId) : null,
      })),
    };
  }

  private orderLine(order: LockedOrder, l: GoodsNoteLineDto) {
    const poLine = order.lines.get(BigInt(l.poLineId!));
    if (!poLine) throw DomainError.notFound('PurchaseOrderLine', l.poLineId!);
    if (poLine.itemId !== BigInt(l.itemId)) {
      throw new DomainError(ErrorCode.VALIDATION, `Line ${poLine.lineNo} of the order is for another item`, { poLineId: l.poLineId });
    }
    return poLine;
  }

  private assertReceivable(order: LockedOrder): void {
    if (!(RECEIVABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
      throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, `A ${order.status} purchase order cannot be received`, {
        status: order.status,
        action: 'received',
        allowed: [...RECEIVABLE_ORDER_STATUSES],
      });
    }
  }

  /**
   * ADR-026 §4–5 under the order's locks: the order receivable, the note in
   * the order's warehouse, every line on an order line of the same item, and
   * the base quantities per order line within what is left. Returns them.
   */
  private checkReceipt(
    order: LockedOrder,
    warehouseId: bigint,
    lines: { itemId: bigint; qty: Num; poLineId: bigint | null }[],
  ): Map<bigint, Decimal> {
    this.assertReceivable(order);
    if (warehouseId !== order.warehouseId) {
      throw new DomainError(ErrorCode.VALIDATION, "A receipt against an order goes into the order's warehouse", {
        field: 'warehouseId',
        orderWarehouseId: order.warehouseId.toString(),
      });
    }
    for (const l of lines) {
      const poLine = l.poLineId !== null ? order.lines.get(l.poLineId) : undefined;
      if (!poLine) throw DomainError.notFound('PurchaseOrderLine', l.poLineId?.toString() ?? '');
      if (poLine.itemId !== l.itemId) {
        throw new DomainError(ErrorCode.VALIDATION, `Line ${poLine.lineNo} of the order is for another item`, { poLineId: poLine.id.toString() });
      }
    }
    const wanted = sumBy(lines.map((l) => ({ key: l.poLineId!, qty: dec(l.qty) })));
    this.orders.assertWithinOrder(order, wanted);
    return wanted;
  }

  /**
   * ADR-026 §9 under the request's locks: approved, the note in its
   * warehouse, every line on a request line of the same item, the base
   * quantities within what is left. Returns them per request line.
   */
  private checkIssue(
    locks: { level: ProcurementLevel; request: LockedIssueRequest | null },
    warehouseId: bigint,
    lines: { itemId: bigint; qty: Num; issueRequestLineId: bigint | null }[],
  ): Map<bigint, Decimal> {
    const req = locks.request!;
    assertProcurementLevel(locks.level, 'FULL');
    if (req.status !== 'APPROVED') {
      throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, `A ${req.status} issue request cannot be issued`, {
        status: req.status,
        action: 'issued',
        allowed: ['APPROVED'],
      });
    }
    if (warehouseId !== req.warehouseId) {
      throw new DomainError(ErrorCode.VALIDATION, "An issue from a request leaves from the request's warehouse", {
        field: 'warehouseId',
        requestWarehouseId: req.warehouseId.toString(),
      });
    }
    for (const l of lines) {
      const rl = l.issueRequestLineId !== null ? req.lines.get(l.issueRequestLineId) : undefined;
      if (!rl) throw DomainError.notFound('IssueRequestLine', l.issueRequestLineId?.toString() ?? '');
      if (rl.itemId !== l.itemId) {
        throw new DomainError(ErrorCode.VALIDATION, `Line ${rl.lineNo} of the request is for another item`, {
          issueRequestLineId: rl.id.toString(),
        });
      }
    }
    const wanted = sumBy(lines.map((l) => ({ key: l.issueRequestLineId!, qty: dec(l.qty) })));
    this.issueRequests.assertWithinRequest(req, wanted);
    return wanted;
  }

  /**
   * ADR-026 §9: at FULL, a goods issue without an approved issue request
   * needs stock.issue_without_request, read with a shared lock of the grant
   * on the caller's transaction; owners are exempt. SIMPLE and MEDIUM issue
   * directly as before.
   */
  private async assertIssueWithoutRequest(tx: Prisma.TransactionClient, tenantId: bigint, level: ProcurementLevel): Promise<void> {
    if (level !== 'FULL') return;
    if (ClsServiceManager.getClsService<RequestContext>().get('roleCode') === OWNER_ROLE) return;
    if (await readMemberGrant(tx, tenantId, PERMISSIONS.STOCK_ISSUE_WITHOUT_REQUEST)) return;
    throw new DomainError(
      ErrorCode.ISSUE_REQUEST_REQUIRED,
      `At the FULL procurement level a goods issue comes from an approved issue request, or needs ${PERMISSIONS.STOCK_ISSUE_WITHOUT_REQUEST}`,
      { level },
    );
  }

  private async writeLines(tx: Prisma.TransactionClient, tenantId: bigint, noteId: bigint, lines: NoteLineRow[]) {
    await tx.goodsNoteLine.createMany({
      data: lines.map((l, i) => ({
        tenantId,
        noteId,
        lineNo: i + 1,
        itemId: l.itemId,
        qty: l.qty,
        unitCost: l.unitCost,
        poLineId: l.poLineId,
        issueRequestLineId: l.issueRequestLineId,
      })),
    });
  }

  private receiptLines(
    notes: { id: bigint; doc_no: string | null; status: 'DRAFT' | 'POSTED'; note_type: 'GRN' | 'GIN'; purchase_order_id: bigint | null; warehouse_id: bigint }[],
    rows: { id: bigint; note_id: bigint; item_id: bigint; po_line_id: bigint | null; qty: Num; unit_cost: Num | null; billed_qty: Num; cleared_value: Num }[],
  ): Map<bigint, ReceiptLine> {
    const byNote = new Map(notes.map((n) => [BigInt(n.id), n]));
    const out = new Map<bigint, ReceiptLine>();
    for (const r of rows) {
      const n = byNote.get(BigInt(r.note_id))!;
      const qty = dec(r.qty);
      const unitCost = new Decimal(r.unit_cost?.toString() ?? 0);
      out.set(BigInt(r.id), {
        id: BigInt(r.id),
        noteId: BigInt(r.note_id),
        docNo: n.doc_no,
        noteStatus: n.status,
        noteType: n.note_type,
        purchaseOrderId: n.purchase_order_id === null ? null : BigInt(n.purchase_order_id),
        warehouseId: BigInt(n.warehouse_id),
        itemId: BigInt(r.item_id),
        poLineId: r.po_line_id === null ? null : BigInt(r.po_line_id),
        qty,
        unitCost,
        value: round3(qty.times(unitCost)),
        billedQty: dec(r.billed_qty),
        clearedValue: dec(r.cleared_value),
      });
    }
    return out;
  }
}
