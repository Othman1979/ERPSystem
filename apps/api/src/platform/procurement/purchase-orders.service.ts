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
import { assertProcurementLevel, lockCompanyProcurement } from '../../common/procurement/procurement-level.js';
import { Prisma, type ProcurementLevel } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { CatalogService } from '../inventory/catalog.service.js';
import { WarehousesService } from '../inventory/warehouses.service.js';
import { PartiesService } from '../parties/parties.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type {
  ConvertPurchaseRequestDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  PurchaseOrderLineDto,
  UpdatePurchaseOrderDto,
} from './dto/procurement.dto.js';
import { amountColumns, assertWithinRemaining, documentTotals, priceLine, type PricedLine, resolvePurchaseItem } from './procurement-lines.js';
import { assertStatus, lockDocument, lockRequest, lockRequestLines, type LockedRequestLine } from './procurement-locks.js';
import { PurchaseOrderReceiptsService } from './purchase-order-receipts.service.js';
import { PurchaseRequestsService } from './purchase-requests.service.js';

/**
 * Statuses that count as open for the procurement level (ADR-025 §6, ADR-026 §6):
 * everything but RECEIVED, CLOSED and CANCELLED.
 */
export const OPEN_ORDER_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED'] as const;

const itemRef = { select: { id: true, code: true, nameAr: true, nameEn: true, baseUnitId: true, itemKind: true } } as const;
const unitRef = { include: { unit: { select: { id: true, code: true, nameAr: true } } } } as const;
const supplierRef = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;

interface OrderLineInput {
  line: PricedLine;
  requestLineId: bigint | null;
  quoteLineId: bigint | null;
  note: string | null;
}

/** The header an order is written with. */
interface OrderHeader {
  orderDate: string;
  expectedDate?: string;
  supplierId: bigint;
  warehouseId: string;
  costCenterId?: string;
  notes?: string;
}

/**
 * Purchase orders (ADR-025 §4, MEDIUM and FULL): at FULL from an approved
 * request (directly or through the comparison), at MEDIUM direct. DRAFT →
 * SUBMITTED → APPROVED (numbered PO, approval limit per §2); a rejection
 * returns it to DRAFT; CANCELLED with a reason gives its quantity back to the
 * request. No journal entry, no stock movement: receiving is phase 13.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly warehouses: WarehousesService,
    private readonly parties: PartiesService,
    private readonly costCenters: CostCentersService,
    private readonly requests: PurchaseRequestsService,
    private readonly receipts: PurchaseOrderReceiptsService,
  ) {}

  countOpen(tx: Prisma.TransactionClient): Promise<number> {
    return tx.purchaseOrder.count({ where: { status: { in: [...OPEN_ORDER_STATUSES] } } });
  }

  async list(query: ListPurchaseOrdersQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.PurchaseOrderWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplierId ? { supplierId: BigInt(query.supplierId) } : {}),
      ...(query.requestId ? { requestId: BigInt(query.requestId) } : {}),
      ...(query.from || query.to
        ? {
            orderDate: {
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
                { orderNo: { contains: q } },
                { supplier: { code: { contains: q } } },
                { supplier: { nameAr: { contains: q } } },
                { supplier: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'orderDate' | 'orderNo' | 'grandTotal', Prisma.PurchaseOrderOrderByWithRelationInput>(
      query.sort,
      '-orderDate',
      {
        orderDate: (dir) => ({ orderDate: dir }),
        orderNo: (dir) => ({ orderNo: dir }),
        grandTotal: (dir) => ({ grandTotal: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) => {
        const page = await tx.purchaseOrder.findMany({
          where,
          include: { supplier: supplierRef, request: { select: { id: true, requestNo: true } } },
          orderBy,
          ...window,
        });
        return withLineCounts(page, 'orderId', (ids) =>
          tx.purchaseOrderLine.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _count: { _all: true } }),
        );
      },
      count: (tx) => tx.purchaseOrder.count({ where }),
    });
  }

  /** One order; another branch's answers 404 (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const order = await db.purchaseOrder.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        supplier: { select: { id: true, code: true, nameAr: true, nameEn: true, taxNumber: true, phone: true, address: true } },
        warehouse: { select: { id: true, code: true, nameAr: true } },
        costCenter: { select: { id: true, code: true, nameAr: true } },
        request: { select: { id: true, requestNo: true, status: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            item: itemRef,
            itemUnit: unitRef,
            requestLine: { select: { id: true, lineNo: true } },
            quoteLine: { select: { id: true, quoteId: true } },
          },
        },
      },
    });
    if (!order) throw DomainError.notFound('PurchaseOrder', id.toString());
    return order;
  }

  async create(dto: CreatePurchaseOrderDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const supplierId = BigInt(dto.supplierId);
    await this.parties.assertActiveSupplier(supplierId);
    const branchId = await this.warehouseBranch(dto.warehouseId);
    const requestId = dto.requestId ? BigInt(dto.requestId) : null;

    const created = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const { level, pricesIncludeTax } = await this.lockCompany(tx, tenantId, companyId);
        const reqLines = await this.lockRequestForOrder(tx, tenantId, level, requestId, dto.lines, branchId);
        const lines = await this.priceLines(tx, dto.lines, pricesIncludeTax);
        if (reqLines) await this.takeQty(tx, lines, reqLines, new Map());
        return this.writeOrder(tx, tenantId, companyId, branchId, requestId, pricesIncludeTax, { ...dto, supplierId }, lines);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_order.create', entityType: 'purchase_order', entityId: created, after: { requestId: requestId?.toString() ?? null } });
    return this.get(created);
  }

  /** A draft's new header and lines; its request stays the same, the quantities it holds are given back and taken again. */
  async update(id: bigint, dto: UpdatePurchaseOrderDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    // The order first: another tenant's or branch's id answers 404 before any body check.
    const requestId = await this.requestIdOf(id);
    const supplierId = BigInt(dto.supplierId);
    await this.parties.assertActiveSupplier(supplierId);
    const branchId = await this.warehouseBranch(dto.warehouseId);

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const { level, pricesIncludeTax } = await this.lockCompany(tx, tenantId, companyId);
        const reqLines = await this.lockRequestForOrder(tx, tenantId, level, requestId, dto.lines, branchId);
        const order = await lockDocument(tx, 'purchase_orders', tenantId, id);
        assertBranchAllowed(order.branch_id);
        assertStatus('purchase order', order.status, ['DRAFT'], 'edited');
        const lines = await this.priceLines(tx, dto.lines, pricesIncludeTax);
        if (reqLines) await this.takeQty(tx, lines, reqLines, await this.heldQty(tx, id));
        // Share-lock the header centre before the row that references it (ADR-024 §1.4).
        if (dto.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, BigInt(dto.costCenterId));
        await tx.purchaseOrderLine.deleteMany({ where: { orderId: id } });
        await tx.purchaseOrder.update({
          where: { id },
          data: {
            ...this.headerColumns({ ...dto, supplierId }),
            branchId,
            pricesIncludeTax,
            ...documentTotals(lines.map((l) => l.line)),
            updatedBy: this.support.userId() ?? null,
          },
        });
        await this.writeLines(tx, tenantId, id, lines);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_order.update', entityType: 'purchase_order', entityId: id });
    return this.get(id);
  }

  /** Deletes a draft and gives its quantities back to the request (ADR-025 §7). */
  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const requestId = await this.requestIdOf(id);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await this.lockLevel(tx, tenantId, companyId);
        if (requestId) {
          await lockRequest(tx, tenantId, requestId);
          await lockRequestLines(tx, tenantId, requestId);
        }
        const order = await lockDocument(tx, 'purchase_orders', tenantId, id);
        assertBranchAllowed(order.branch_id);
        assertStatus('purchase order', order.status, ['DRAFT'], 'deleted');
        if (requestId) await this.giveBack(tx, await this.heldQty(tx, id));
        await tx.purchaseOrder.delete({ where: { id } });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'purchase_order.delete', entityType: 'purchase_order', entityId: id });
    return { deleted: true as const };
  }

  submit(id: bigint) {
    return this.transition(id, 'submit', ['DRAFT'], async (tx) => {
      if ((await tx.purchaseOrderLine.count({ where: { orderId: id } })) === 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'The order has no lines');
      }
      // Review #47: an order worth nothing is a mistake (a price left blank), not something to approve.
      const { grandTotal } = await tx.purchaseOrder.findFirstOrThrow({ where: { id }, select: { grandTotal: true } });
      if (new Decimal(grandTotal.toString()).lte(0)) {
        throw new DomainError(ErrorCode.PURCHASE_ORDER_ZERO_TOTAL, 'The order total is zero: enter the prices first');
      }
      return { status: 'SUBMITTED', submittedAt: new Date(), submittedBy: this.support.userId() ?? null };
    });
  }

  /**
   * ADR-025 §2: an owner, or a member with purchase.approve up to their limit
   * on the order total, never on an order they created, last edited or
   * submitted. Numbered PO here; closes the request once approved orders cover it.
   */
  approve(id: bigint) {
    return this.transition(id, 'approve', ['SUBMITTED'], async (tx, order, tenantId, companyId) => {
      const row = await tx.purchaseOrder.findFirstOrThrow({ where: { id }, select: { grandTotal: true, orderDate: true } });
      const approver = await readApprover(tx, tenantId);
      assertCanApprove({
        ...approver,
        amount: new Decimal(row.grandTotal.toString()),
        isAuthor: isAuthor(order, approver.userId),
      });
      const orderNo = await allocateDocumentNo(tx, tenantId, companyId, 'PURCHASE_ORDER', row.orderDate);
      return { status: 'APPROVED', orderNo, approvedAt: new Date(), approvedBy: approver.userId };
    }, async (tx, tenantId, requestId) => (await this.requests.closeIfFullyOrdered(tx, tenantId, requestId)) ? requestId : null);
  }

  /** Back to DRAFT with the approver's reason (ADR-025 §7): purchase.approve (or an owner), one's own order included. */
  reject(id: bigint, reason: string) {
    return this.transition(id, 'reject', ['SUBMITTED'], async (tx, _order, tenantId) => {
      const approver = await readApprover(tx, tenantId);
      assertCanApprove({ ...approver, amount: null, isAuthor: false });
      return { status: 'DRAFT', rejectReason: reason, rejectedAt: new Date(), rejectedBy: approver.userId, submittedAt: null, submittedBy: null };
    });
  }

  /**
   * Cancels a submitted or approved order with a written reason (ADR-025 §3):
   * its quantities go back to the request; a request closed because it was
   * fully ordered opens again. Refused once anything is received (ADR-026 §6):
   * a posted GRN makes the order PARTIALLY_RECEIVED or RECEIVED, and the
   * received quantities are checked again under the order lines' locks.
   */
  cancel(id: bigint, reason: string) {
    return this.transition(id, 'cancel', ['SUBMITTED', 'APPROVED'], async (tx, order) => {
      const locked = await this.receipts.lockOrder(tx, id);
      if ([...locked.lines.values()].some((l) => l.receivedQty.gt(0))) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Goods are received on this order: close it instead', {
          status: order.status,
          action: 'cancelled',
          reason: 'HAS_RECEIPTS',
        });
      }
      if (order.request_id) {
        await this.giveBack(tx, await this.heldQty(tx, id));
        // An automatic close is undone with the quotes closed by it; a close by hand stays.
        await this.requests.reopenIfAutoClosed(tx, order.request_id);
      }
      return { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date(), cancelledBy: this.support.userId() ?? null };
    });
  }

  /**
   * Closes an approved or partly received order by hand with a written reason
   * (ADR-026 §6): nothing more is received on it; its receipts stay billable.
   * purchase.manage (the route) or an owner. The order lines are locked too,
   * so a GRN posting at the same time queues before or after the close.
   */
  close(id: bigint, reason: string) {
    return this.transition(id, 'close', ['APPROVED', 'PARTIALLY_RECEIVED'], async (tx) => {
      await this.receipts.lockOrder(tx, id);
      return { status: 'CLOSED', closeReason: reason, closedAt: new Date(), closedBy: this.support.userId() ?? null };
    });
  }

  /**
   * «Create orders» from the comparison (ADR-025 §10): the chosen quote lines
   * grouped by supplier, one draft order each, within what is left on every
   * request line. FULL only, the request approved.
   */
  async convert(requestId: bigint, dto: ConvertPurchaseRequestDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const branchId = await this.warehouseBranch(dto.warehouseId);
    const quoteLineIds = dto.selections.map((s) => BigInt(s.quoteLineId));
    if (new Set(quoteLineIds).size !== quoteLineIds.length) {
      throw new DomainError(ErrorCode.VALIDATION, 'A quote line is chosen twice');
    }

    const ids = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const level = await this.lockLevel(tx, tenantId, companyId);
        assertProcurementLevel(level, 'FULL');
        const req = await lockRequest(tx, tenantId, requestId);
        assertBranchAllowed(req.branch_id);
        assertStatus('purchase request', req.status, ['APPROVED'], 'ordered from');
        this.assertWarehouseInRequestBranch(req.branch_id, branchId);
        const reqLines = await lockRequestLines(tx, tenantId, requestId);
        // Quotes change only under this request's lock, so these reads are current.
        const quoteLines = await tx.purchaseQuoteLine.findMany({
          where: { id: { in: quoteLineIds } },
          include: { quote: { select: { id: true, requestId: true, supplierId: true, status: true, pricesIncludeTax: true } } },
        });
        const byId = new Map(quoteLines.map((l) => [l.id, l]));
        const refs = await this.catalog.itemsForLines(
          quoteLines.map((l) => l.itemId),
          quoteLines.filter((l) => l.itemUnitId).map((l) => l.itemUnitId!),
          tx,
        );
        const groups = new Map<bigint, { pricesIncludeTax: boolean; lines: OrderLineInput[] }>();
        for (const s of dto.selections) {
          const ql = byId.get(BigInt(s.quoteLineId));
          if (!ql || ql.quote.requestId !== requestId) throw DomainError.notFound('PurchaseQuoteLine', s.quoteLineId);
          if (ql.quote.status !== 'RECEIVED' || ql.unitPrice === null) {
            throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, `Quote line ${s.quoteLineId} is not on a received quote`, {
              status: ql.quote.status,
              action: 'ordered from',
            });
          }
          const reqLine = reqLines.get(ql.requestLineId)!;
          const left = reqLine.qty.minus(reqLine.ordered_qty);
          const qty = s.qty ? new Decimal(s.qty) : Decimal.min(new Decimal(ql.qty.toString()), left);
          if (qty.lte(0)) {
            throw new DomainError(ErrorCode.PURCHASE_REQUEST_QTY_EXCEEDED, `Nothing is left to order on request line ${reqLine.line_no}`, {
              requestLineId: reqLine.id.toString(),
              remaining: left.toFixed(6),
              wanted: qty.toFixed(6),
            });
          }
          // The quoted price, discount and tax category exactly (review #47): the order
          // costs per unit what the comparison showed, whatever the item's tax is today.
          const item = {
            ...resolvePurchaseItem(refs, { itemId: ql.itemId.toString(), itemUnitId: ql.itemUnitId?.toString() ?? null, qty: qty.toString() }),
            taxCategoryId: ql.taxCategoryId,
            taxRate: new Decimal(ql.taxRate.toString()),
          };
          const line = priceLine(item, ql.unitPrice.toString(), ql.discountPct.toString(), ql.quote.pricesIncludeTax);
          const group = groups.get(ql.quote.supplierId) ?? { pricesIncludeTax: ql.quote.pricesIncludeTax, lines: [] };
          if (group.pricesIncludeTax !== ql.quote.pricesIncludeTax) {
            throw new DomainError(ErrorCode.VALIDATION, "The supplier's quotes were priced on different tax bases; order them separately");
          }
          group.lines.push({ line, requestLineId: ql.requestLineId, quoteLineId: ql.id, note: ql.note });
          groups.set(ql.quote.supplierId, group);
        }
        // A supplier deactivated since its quote takes no new order (ADR-021).
        for (const supplierId of groups.keys()) await this.parties.assertActiveSupplier(supplierId, tx);
        await this.takeQty(tx, [...groups.values()].flatMap((g) => g.lines), reqLines, new Map());
        const created: bigint[] = [];
        for (const [supplierId, group] of groups) {
          created.push(
            await this.writeOrder(tx, tenantId, companyId, branchId, requestId, group.pricesIncludeTax, { ...dto, supplierId }, group.lines),
          );
        }
        for (const id of created) {
          await this.audit.log({
            action: 'purchase_order.create',
            entityType: 'purchase_order',
            entityId: id,
            after: { requestId: requestId.toString(), from: 'comparison' },
          }, tx);
        }
        return created;
      }, POSTING_TX_OPTIONS),
    );
    return { orders: await Promise.all(ids.map((id) => this.get(id))) };
  }

  // ------------------------------------------------------------- internals

  private async requestIdOf(id: bigint): Promise<bigint | null> {
    const { db } = this.support.tenant();
    const row = await db.purchaseOrder.findFirst({ where: { id, AND: [branchWhere()] }, select: { requestId: true } });
    if (!row) throw DomainError.notFound('PurchaseOrder', id.toString());
    return row.requestId;
  }

  /** MEDIUM or above, read under the company row's shared lock (ADR-025 §5). */
  private async lockLevel(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint): Promise<ProcurementLevel> {
    return (await this.lockCompany(tx, tenantId, companyId)).level;
  }

  /**
   * MEDIUM or above, and the tax-inclusive prices setting, from one read of
   * the share-locked company row (ADR-025 §5, ADR-017): the setting a draft
   * is written with is the one current when it commits, frozen on the order.
   */
  private async lockCompany(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint) {
    const company = await lockCompanyProcurement(tx, tenantId, companyId);
    assertProcurementLevel(company.level, 'MEDIUM');
    return company;
  }

  /**
   * An order from a request receives in the request's branch (review #47):
   * its warehouse is one of that branch, or a company-wide one (no branch,
   * ADR-003). VALIDATION otherwise.
   */
  private assertWarehouseInRequestBranch(requestBranchId: bigint | null, warehouseBranchId: bigint | null): void {
    if (requestBranchId === null || warehouseBranchId === null || requestBranchId === warehouseBranchId) return;
    throw new DomainError(ErrorCode.VALIDATION, "The receiving warehouse must be in the purchase request's branch", {
      field: 'warehouseId',
      requestBranchId: requestBranchId.toString(),
      warehouseBranchId: warehouseBranchId.toString(),
    });
  }

  /** The receiving warehouse's branch, which the caller must be allowed (ADR-003, ADR-025 §12). */
  private async warehouseBranch(warehouseId: string): Promise<bigint | null> {
    const wh = await this.warehouses.activeOwnedRef(BigInt(warehouseId));
    assertBranchAllowed(wh.branchId);
    return wh.branchId;
  }

  /**
   * ADR-025 §1: at FULL an order comes from an approved request and every
   * line names a line of it, with the same item and unit; at MEDIUM there are
   * no requests. Locks the request and its lines; null at MEDIUM.
   */
  private async lockRequestForOrder(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    level: ProcurementLevel,
    requestId: bigint | null,
    lines: PurchaseOrderLineDto[],
    warehouseBranchId: bigint | null,
  ): Promise<Map<bigint, LockedRequestLine> | null> {
    if (level !== 'FULL') {
      if (requestId !== null || lines.some((l) => l.requestLineId)) {
        throw new DomainError(ErrorCode.PROCUREMENT_LEVEL_REQUIRED, 'Purchase requests need the FULL procurement level', {
          required: 'FULL',
          current: level,
        });
      }
      return null;
    }
    if (requestId === null) {
      throw new DomainError(ErrorCode.PURCHASE_REQUEST_REQUIRED, 'At the FULL procurement level an order comes from an approved purchase request');
    }
    const req = await lockRequest(tx, tenantId, requestId);
    assertBranchAllowed(req.branch_id);
    assertStatus('purchase request', req.status, ['APPROVED'], 'ordered from');
    this.assertWarehouseInRequestBranch(req.branch_id, warehouseBranchId);
    const reqLines = await lockRequestLines(tx, tenantId, requestId);
    for (const l of lines) {
      if (!l.requestLineId) {
        throw new DomainError(ErrorCode.PURCHASE_REQUEST_REQUIRED, 'Every line of the order names a line of its purchase request');
      }
      const rl = reqLines.get(BigInt(l.requestLineId));
      if (!rl) throw DomainError.notFound('PurchaseRequestLine', l.requestLineId);
      if (rl.item_id !== BigInt(l.itemId) || (rl.item_unit_id?.toString() ?? null) !== (l.itemUnitId ?? null)) {
        throw new DomainError(ErrorCode.VALIDATION, `Line ${rl.line_no} of the request is for another item or unit`, {
          requestLineId: l.requestLineId,
        });
      }
    }
    return reqLines;
  }

  private async priceLines(tx: Prisma.TransactionClient, dtos: PurchaseOrderLineDto[], pricesIncludeTax: boolean): Promise<OrderLineInput[]> {
    const refs = await this.catalog.itemsForLines(
      dtos.map((l) => BigInt(l.itemId)),
      dtos.filter((l) => l.itemUnitId).map((l) => BigInt(l.itemUnitId!)),
      tx,
    );
    return dtos.map((l) => ({
      line: priceLine(resolvePurchaseItem(refs, l), l.unitPrice, l.discountPct, pricesIncludeTax),
      requestLineId: l.requestLineId ? BigInt(l.requestLineId) : null,
      quoteLineId: null,
      note: l.note ?? null,
    }));
  }

  /** Quantity this order holds per request line. */
  private async heldQty(tx: Prisma.TransactionClient, orderId: bigint): Promise<Map<bigint, Decimal>> {
    const rows = await tx.purchaseOrderLine.findMany({ where: { orderId, requestLineId: { not: null } }, select: { requestLineId: true, qty: true } });
    const out = new Map<bigint, Decimal>();
    for (const r of rows) out.set(r.requestLineId!, (out.get(r.requestLineId!) ?? new Decimal(0)).plus(r.qty.toString()));
    return out;
  }

  /**
   * Takes the lines' quantities from the request lines (locked), refusing more
   * than is left (ADR-025 §9); `held` is what this order already holds, given
   * back first on an edit.
   */
  private async takeQty(
    tx: Prisma.TransactionClient,
    lines: OrderLineInput[],
    reqLines: Map<bigint, LockedRequestLine>,
    held: Map<bigint, Decimal>,
  ): Promise<void> {
    const remaining = new Map([...reqLines].map(([id, l]) => [id, l.qty.minus(l.ordered_qty).plus(held.get(id) ?? 0)]));
    const wanted = assertWithinRemaining(
      lines.map((l) => ({ requestLineId: l.requestLineId!, qty: l.line.qty })),
      remaining,
    );
    for (const id of new Set([...wanted.keys(), ...held.keys()])) {
      const delta = (wanted.get(id) ?? new Decimal(0)).minus(held.get(id) ?? 0);
      if (!delta.isZero()) await tx.purchaseRequestLine.update({ where: { id }, data: { orderedQty: { increment: delta } } });
    }
  }

  private async giveBack(tx: Prisma.TransactionClient, held: Map<bigint, Decimal>): Promise<void> {
    for (const [id, qty] of held) {
      await tx.purchaseRequestLine.update({ where: { id }, data: { orderedQty: { decrement: qty } } });
    }
  }

  private headerColumns(h: OrderHeader) {
    return {
      orderDate: new Date(h.orderDate),
      expectedDate: h.expectedDate ? new Date(h.expectedDate) : null,
      supplierId: h.supplierId,
      warehouseId: BigInt(h.warehouseId),
      costCenterId: h.costCenterId ? BigInt(h.costCenterId) : null,
      notes: h.notes ?? null,
    };
  }

  private async writeOrder(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    branchId: bigint | null,
    requestId: bigint | null,
    pricesIncludeTax: boolean,
    header: OrderHeader,
    lines: OrderLineInput[],
  ): Promise<bigint> {
    // Share-lock the header centre before the row that references it (ADR-024 §1.4).
    if (header.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, BigInt(header.costCenterId));
    const order = await tx.purchaseOrder.create({
      data: {
        tenantId,
        companyId,
        branchId,
        requestId,
        pricesIncludeTax,
        ...this.headerColumns(header),
        ...documentTotals(lines.map((l) => l.line)),
        createdBy: this.support.userId() ?? null,
      },
    });
    await this.writeLines(tx, tenantId, order.id, lines);
    return order.id;
  }

  private async writeLines(tx: Prisma.TransactionClient, tenantId: bigint, orderId: bigint, lines: OrderLineInput[]) {
    await tx.purchaseOrderLine.createMany({
      data: lines.map((l, i) => ({
        tenantId,
        orderId,
        lineNo: i + 1,
        itemId: l.line.itemId,
        itemUnitId: l.line.itemUnitId,
        requestLineId: l.requestLineId,
        quoteLineId: l.quoteLineId,
        note: l.note,
        ...amountColumns(l.line),
      })),
    });
  }

  /**
   * One status change under the locks (level, then the request and its lines
   * when the order has one, then the order), retried on a lock conflict.
   * `after` runs on the same transaction once the order is updated (the
   * approval's request close); it returns the request it closed, if any.
   */
  private async transition(
    id: bigint,
    action: 'submit' | 'approve' | 'reject' | 'cancel' | 'close',
    from: readonly string[],
    apply: (
      tx: Prisma.TransactionClient,
      order: Awaited<ReturnType<typeof lockDocument>>,
      tenantId: bigint,
      companyId: bigint,
    ) => Promise<Prisma.PurchaseOrderUpdateInput>,
    after?: (tx: Prisma.TransactionClient, tenantId: bigint, requestId: bigint) => Promise<bigint | null>,
  ) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const requestId = await this.requestIdOf(id);
    const verb = { submit: 'submitted', approve: 'approved', reject: 'rejected', cancel: 'cancelled', close: 'closed' }[action];
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await this.lockLevel(tx, tenantId, companyId);
        if (requestId) {
          await lockRequest(tx, tenantId, requestId);
          await lockRequestLines(tx, tenantId, requestId);
        }
        const order = await lockDocument(tx, 'purchase_orders', tenantId, id);
        assertBranchAllowed(order.branch_id);
        assertStatus('purchase order', order.status, from, verb);
        const data = await apply(tx, order, tenantId, companyId);
        // updated_by stays the last editor of the content: a status change has its own *_by column.
        await tx.purchaseOrder.update({ where: { id }, data });
        const closed = after && requestId ? await after(tx, tenantId, requestId) : null;
        await this.audit.log({
          action: `purchase_order.${action}`,
          entityType: 'purchase_order',
          entityId: id,
          after: {
            status: data.status,
            ...(data.orderNo ? { orderNo: data.orderNo } : {}),
            ...(data.cancelReason ? { reason: data.cancelReason } : {}),
            ...(data.closeReason ? { reason: data.closeReason } : {}),
          },
        }, tx);
        if (closed) {
          await this.audit.log({
            action: 'purchase_request.close',
            entityType: 'purchase_request',
            entityId: closed,
            after: { reason: 'fully_ordered' },
          }, tx);
        }
        return { set: data, closedRequest: closed };
      }, POSTING_TX_OPTIONS),
    );
    return this.get(id);
  }
}
