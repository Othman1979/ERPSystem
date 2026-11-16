import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { ID_PATTERN } from '../../common/pipes/parse-id.pipe.js';
import { assertCanApprove, isAuthor, readApprover } from '../../common/procurement/approval.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { Prisma } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { ReportsService } from '../journal/reports.service.js';
import { CatalogService } from '../inventory/catalog.service.js';
import { WarehousesService } from '../inventory/warehouses.service.js';
import { PartiesService } from '../parties/parties.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { amountColumns, documentTotals, priceLine, resolveItem, type PricedLine } from '../procurement/procurement-lines.js';
import { assertStatus } from '../procurement/procurement-locks.js';
import type {
  ConvertSalesQuoteDto,
  CreateSalesOrderDto,
  ListSalesOrdersQueryDto,
  SalesLineDto,
  SalesOrderInputDto,
  SalesReservationQueryDto,
  UpdateSalesOrderDto,
} from './dto/sales-cycle.dto.js';
import { reservedByItem } from './sales-cycle.reservation.js';
import {
  availableQty,
  needsOrderApproval,
  neededPerItem,
  outstandingValue,
  overCreditLimit,
} from './sales-cycle.rules.js';
import {
  lockCompanySales,
  lockOrderLines,
  lockSalesOrder,
  lockSalesQuote,
  lockStockBalances,
  type LockedOrderLine,
  type LockedSalesOrderRow,
  type LockedSalesSettings,
} from './sales-cycle.locks.js';

const itemRef = { select: { id: true, code: true, nameAr: true, nameEn: true, baseUnitId: true, itemKind: true } } as const;
const unitRef = { include: { unit: { select: { id: true, code: true, nameAr: true } } } } as const;
const customerRef = { select: { id: true, code: true, nameAr: true, nameEn: true, taxNumber: true, phone: true, address: true } } as const;

/** Statuses whose lines reserve stock (ADR-027 §5). */
export const RESERVING_ORDER_STATUSES = ['CONFIRMED', 'PARTIALLY_INVOICED'] as const;

interface OrderLineInput {
  line: PricedLine;
  quoteLineId: bigint | null;
  note: string | null;
}

interface OrderHeader {
  orderDate: Date;
  expectedDate: Date | null;
  customerId: bigint;
  warehouseId: bigint;
  costCenterId: bigint | null;
  paymentTermsDays: number | null;
  description: string | null;
}

/** What an action sees once its locks are held (ADR-027 §8). */
interface OrderContext {
  tenantId: bigint;
  companyId: bigint;
  row: LockedSalesOrderRow;
  lines: LockedOrderLine[];
  settings: LockedSalesSettings;
  /** On-hand quantities of the lines' items in the order's warehouse, locked under HARD (ADR-027 §5). */
  onHand: Map<bigint, Decimal>;
}

/**
 * Sales orders (ADR-027 §3–§6): DRAFT → (PENDING_APPROVAL) → CONFIRMED (numbered
 * SO) → PARTIALLY_INVOICED → INVOICED; CLOSED with a reason when partly
 * invoiced; CANCELLED with a reason while nothing is invoiced. The reservation
 * is read from the open lines, never stored. No journal entry, no stock
 * movement: the sales invoice that bills the order moves the stock (part B).
 */
@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly warehouses: WarehousesService,
    private readonly parties: PartiesService,
    private readonly costCenters: CostCentersService,
    private readonly ledger: ReportsService,
  ) {}

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  async list(query: ListSalesOrdersQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.SalesOrderWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: BigInt(query.customerId) } : {}),
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
                { customer: { code: { contains: q } } },
                { customer: { nameAr: { contains: q } } },
                { customer: { nameEn: { contains: q } } },
              ],
            }
          : {},
      ],
    };
    const orderBy = orderByOf<'orderDate' | 'orderNo' | 'grandTotal', Prisma.SalesOrderOrderByWithRelationInput>(
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
        const page = await tx.salesOrder.findMany({
          where,
          include: { customer: customerRef, quote: { select: { id: true, quoteNo: true } } },
          orderBy,
          ...window,
        });
        return withLineCounts(page, 'orderId', (ids) =>
          tx.salesOrderLine.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _count: { _all: true } }),
        );
      },
      count: (tx) => tx.salesOrder.count({ where }),
    });
  }

  /** One order; another branch's answers 404 (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const order = await db.salesOrder.findFirst({
      where: { id, AND: [branchWhere()] },
      include: {
        customer: customerRef,
        warehouse: { select: { id: true, code: true, nameAr: true } },
        costCenter: { select: { id: true, code: true, nameAr: true } },
        quote: { select: { id: true, quoteNo: true, status: true } },
        lines: { orderBy: { lineNo: 'asc' }, include: { item: itemRef, itemUnit: unitRef } },
      },
    });
    if (!order) throw DomainError.notFound('SalesOrder', id.toString());
    return order;
  }

  async create(dto: CreateSalesOrderDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const customerId = BigInt(dto.customerId);
    await this.parties.assertActiveCustomer(customerId);
    const branchId = await this.warehouseBranch(dto.warehouseId);

    const id = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const settings = await lockCompanySales(tx, tenantId, companyId);
        const lines = await this.priceLines(tx, dto.lines, settings.pricesIncludeTax);
        const header = this.header(dto, customerId);
        return this.writeOrder(tx, tenantId, companyId, branchId, settings.pricesIncludeTax, header, lines);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'sales_order.create', entityType: 'sales_order', entityId: id });
    return this.get(id);
  }

  /** A draft's new content (ADR-027 §3): DRAFT only. */
  async update(id: bigint, dto: UpdateSalesOrderDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.orderOrNotFound(id);
    const customerId = BigInt(dto.customerId);
    await this.parties.assertActiveCustomer(customerId);
    const branchId = await this.warehouseBranch(dto.warehouseId);

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const settings = await lockCompanySales(tx, tenantId, companyId);
        const row = await lockSalesOrder(tx, tenantId, id);
        assertBranchAllowed(row.branch_id);
        assertStatus('sales order', row.status, ['DRAFT'], 'edited');
        const lines = await this.priceLines(tx, dto.lines, settings.pricesIncludeTax);
        const header = this.header(dto, customerId);
        if (header.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, header.costCenterId);
        await this.parties.assertActiveCustomer(customerId, tx);
        await tx.salesOrderLine.deleteMany({ where: { orderId: id } });
        await tx.salesOrder.update({
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
    await this.audit.log({ action: 'sales_order.update', entityType: 'sales_order', entityId: id });
    return this.get(id);
  }

  /** Deletes a draft (ADR-027 §3). */
  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.orderOrNotFound(id);
    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await lockCompanySales(tx, tenantId, companyId);
        const row = await lockSalesOrder(tx, tenantId, id);
        assertBranchAllowed(row.branch_id);
        assertStatus('sales order', row.status, ['DRAFT'], 'deleted');
        await tx.salesOrder.delete({ where: { id } });
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'sales_order.delete', entityType: 'sales_order', entityId: id });
    return { deleted: true as const };
  }

  /**
   * DRAFT → CONFIRMED with its number SO, or → PENDING_APPROVAL when the
   * approval rule of ADR-027 §6 asks for one. Under HARD reservation the
   * stock is checked under the stock locks (ADR-027 §5).
   */
  confirm(id: bigint) {
    return this.transition(id, 'confirm', ['DRAFT'], 'confirmed', true, async (tx, ctx) => {
      if (await this.approvalNeeded(tx, ctx, id)) {
        return { status: 'PENDING_APPROVAL', submittedAt: new Date(), submittedBy: this.support.userId() ?? null };
      }
      await this.assertReservable(tx, ctx, id);
      return this.confirmedData(tx, ctx, { submittedAt: new Date(), submittedBy: this.support.userId() ?? null });
    });
  }

  /**
   * ADR-027 §6: an owner, or a member with sales.approve up to their limit on
   * the order total, never on an order they created, edited or submitted.
   * Numbered SO here, with the reservation checked again under HARD.
   */
  approve(id: bigint) {
    return this.transition(id, 'approve', ['PENDING_APPROVAL'], 'approved', true, async (tx, ctx) => {
      const row = await tx.salesOrder.findFirstOrThrow({ where: { id }, select: { grandTotal: true } });
      const approver = await readApprover(tx, ctx.tenantId, PERMISSIONS.SALES_APPROVE);
      assertCanApprove({
        permission: PERMISSIONS.SALES_APPROVE,
        ...approver,
        amount: new Decimal(row.grandTotal.toString()),
        isAuthor: isAuthor(ctx.row, approver.userId),
      });
      await this.assertReservable(tx, ctx, id);
      return this.confirmedData(tx, ctx, { approvedAt: new Date(), approvedBy: approver.userId });
    });
  }

  /** Back to DRAFT with the approver's written reason (ADR-027 §6). */
  rejectApproval(id: bigint, reason: string) {
    return this.transition(id, 'reject-approval', ['PENDING_APPROVAL'], 'rejected', false, async (tx, ctx) => {
      const approver = await readApprover(tx, ctx.tenantId, PERMISSIONS.SALES_APPROVE);
      assertCanApprove({ permission: PERMISSIONS.SALES_APPROVE, ...approver, amount: null, isAuthor: false });
      return { status: 'DRAFT', rejectReason: reason, rejectedAt: new Date(), rejectedBy: approver.userId, submittedAt: null, submittedBy: null };
    });
  }

  /**
   * Cancels a confirmed or pending order with a written reason, refused once
   * anything is invoiced (SALES_ORDER_NOT_CANCELLABLE, ADR-027 §3): a partly
   * invoiced order is closed instead.
   */
  cancel(id: bigint, reason: string) {
    return this.transition(id, 'cancel', ['CONFIRMED', 'PENDING_APPROVAL'], 'cancelled', false, async (tx, ctx) => {
      const invoiced = ctx.lines.filter((l) => l.invoicedQty.gt(0)).length;
      if (invoiced > 0) {
        throw new DomainError(ErrorCode.SALES_ORDER_NOT_CANCELLABLE, 'Invoices bill this order: close it instead', { invoicedLines: invoiced });
      }
      return { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date(), cancelledBy: this.support.userId() ?? null };
    });
  }

  /**
   * Closes a partly invoiced order with a written reason (ADR-027 §3): its
   * reservation is released and no more invoices are taken on it.
   */
  close(id: bigint, reason: string) {
    return this.transition(id, 'close', ['PARTIALLY_INVOICED'], 'closed', false, async () => ({
      status: 'CLOSED',
      closeReason: reason,
      closedAt: new Date(),
      closedBy: this.support.userId() ?? null,
    }));
  }

  /**
   * Converts an accepted quote into one draft order with all its lines and
   * prices (ADR-027 §2). Expiry refuses the acceptance of a sent quote, not its
   * conversion; a quote converts once (the quote is locked, and the order's
   * sales_quote_id is unique).
   */
  async fromQuote(quoteId: bigint, dto: ConvertSalesQuoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    // The quote first: another tenant's or branch's id answers 404 before any body check.
    const quote = await db.salesQuote.findFirst({ where: { id: quoteId, AND: [branchWhere()] }, select: { id: true, warehouseId: true } });
    if (!quote) throw DomainError.notFound('SalesQuote', quoteId.toString());
    const warehouseId = dto.warehouseId ?? quote.warehouseId?.toString();
    if (!warehouseId) {
      throw new DomainError(ErrorCode.VALIDATION, 'The order needs a warehouse: name one', { field: 'warehouseId' });
    }
    const branchId = await this.warehouseBranch(warehouseId);

    const id = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await lockCompanySales(tx, tenantId, companyId);
        const q = await lockSalesQuote(tx, tenantId, quoteId);
        assertBranchAllowed(q.branch_id);
        assertStatus('sales quote', q.status, ['ACCEPTED'], 'converted');
        const existing = await tx.salesOrder.findFirst({ where: { tenantId, salesQuoteId: quoteId }, select: { id: true } });
        if (existing) {
          throw new DomainError(ErrorCode.QUOTE_ALREADY_CONVERTED, 'The quote is already converted', { orderId: existing.id.toString() });
        }
        const sq = await tx.salesQuote.findFirstOrThrow({
          where: { id: quoteId },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        await this.parties.assertActiveCustomer(sq.customerId, tx);
        const costCenterId = dto.costCenterId ? BigInt(dto.costCenterId) : sq.costCenterId;
        if (costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, costCenterId);
        const order = await tx.salesOrder.create({
          data: {
            tenantId,
            companyId,
            branchId,
            orderDate: dto.orderDate ? new Date(dto.orderDate) : (await this.support.companyTodayDate()),
            expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
            customerId: sq.customerId,
            warehouseId: BigInt(warehouseId),
            costCenterId,
            salesQuoteId: quoteId,
            pricesIncludeTax: sq.pricesIncludeTax,
            paymentTermsDays: dto.paymentTermsDays ?? null,
            description: sq.description,
            netTotal: sq.netTotal,
            taxTotal: sq.taxTotal,
            grandTotal: sq.grandTotal,
            createdBy: this.support.userId() ?? null,
          },
        });
        await tx.salesOrderLine.createMany({
          data: sq.lines.map((l) => ({
            tenantId,
            orderId: order.id,
            lineNo: l.lineNo,
            quoteLineId: l.id,
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
        return order.id;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'sales_order.create', entityType: 'sales_order', entityId: id, after: { quoteId: quoteId.toString() } });
    return this.get(id);
  }

  /**
   * Reserved and available quantities of stock items in one warehouse (ADR-027
   * §5): computed from the open order lines, never stored. Under NONE the
   * reservation is not shown (null).
   */
  async reservation(query: SalesReservationQueryDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const wh = await this.warehouses.activeRef(BigInt(query.warehouseId));
    assertBranchAllowed(wh.branchId);
    const ids = [...new Set(query.itemIds.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
    if (ids.length === 0 || ids.length > 500 || ids.some((s) => !ID_PATTERN.test(s))) {
      throw new DomainError(ErrorCode.VALIDATION, 'itemIds must be 1 to 500 positive integer ids', { field: 'itemIds' });
    }
    const itemIds = ids.map((s) => BigInt(s));
    return db.$transaction(async (tx) => {
      const company = await tx.company.findFirstOrThrow({ where: { id: companyId }, select: { salesReservation: true } });
      const kinds = await tx.item.findMany({ where: { tenantId, id: { in: itemIds } }, select: { id: true, itemKind: true } });
      const stockIds = kinds.filter((k) => k.itemKind === 'STOCK').map((k) => k.id);
      const onHand = stockIds.length
        ? await tx.stockBalance.findMany({
            where: { tenantId, warehouseId: wh.id, itemId: { in: stockIds } },
            select: { itemId: true, qtyOnHand: true },
          })
        : [];
      const held = company.salesReservation === 'NONE' ? new Map<bigint, Decimal>() : await reservedByItem(tx, tenantId, companyId, wh.id, stockIds, null, false);
      const hand = new Map(onHand.map((b) => [b.itemId, new Decimal(b.qtyOnHand.toString())]));
      return {
        warehouseId: wh.id.toString(),
        mode: company.salesReservation,
        items: stockIds.map((itemId) => {
          const reserved = held.get(itemId) ?? new Decimal(0);
          const available = availableQty(hand.get(itemId) ?? null, reserved);
          return {
            itemId: itemId.toString(),
            onHand: (hand.get(itemId) ?? new Decimal(0)).toFixed(6),
            reserved: company.salesReservation === 'NONE' ? null : reserved.toFixed(6),
            available: company.salesReservation === 'NONE' ? null : available.toFixed(6),
          };
        }),
      };
    });
  }

  // ------------------------------------------------------------- internals

  /** Another branch's order answers 404 before any body check (ADR-003 §11). */
  private async orderOrNotFound(id: bigint): Promise<void> {
    const { db } = this.support.tenant();
    const row = await db.salesOrder.findFirst({ where: { id, AND: [branchWhere()] }, select: { id: true } });
    if (!row) throw DomainError.notFound('SalesOrder', id.toString());
  }

  /** The warehouse's branch, which the caller must be allowed (ADR-003). */
  private async warehouseBranch(warehouseId: string): Promise<bigint | null> {
    const wh = await this.warehouses.activeRef(BigInt(warehouseId));
    assertBranchAllowed(wh.branchId);
    return wh.branchId;
  }

  private header(dto: SalesOrderInputDto, customerId: bigint): OrderHeader {
    return {
      orderDate: new Date(dto.orderDate),
      expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
      customerId,
      warehouseId: BigInt(dto.warehouseId),
      costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
      paymentTermsDays: dto.paymentTermsDays ?? null,
      description: dto.description ?? null,
    };
  }

  private headerColumns(h: OrderHeader) {
    return {
      orderDate: h.orderDate,
      expectedDate: h.expectedDate,
      customerId: h.customerId,
      warehouseId: h.warehouseId,
      costCenterId: h.costCenterId,
      paymentTermsDays: h.paymentTermsDays,
      description: h.description,
    };
  }

  private async priceLines(tx: Prisma.TransactionClient, dtos: SalesLineDto[], pricesIncludeTax: boolean): Promise<OrderLineInput[]> {
    const refs = await this.catalog.itemsForLines(
      dtos.map((l) => BigInt(l.itemId)),
      dtos.filter((l) => l.itemUnitId).map((l) => BigInt(l.itemUnitId!)),
      tx,
    );
    return dtos.map((l) => ({
      line: priceLine(resolveItem(refs, l), l.unitPrice, l.discountPct, pricesIncludeTax),
      quoteLineId: null,
      note: l.note ?? null,
    }));
  }

  private async writeOrder(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    branchId: bigint | null,
    pricesIncludeTax: boolean,
    header: OrderHeader,
    lines: OrderLineInput[],
  ): Promise<bigint> {
    // Share-lock the header centre before the row that references it (ADR-024 §1.4).
    if (header.costCenterId) await this.costCenters.assertUsable(tx, tenantId, companyId, header.costCenterId);
    const order = await tx.salesOrder.create({
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
    await this.writeLines(tx, tenantId, order.id, lines);
    return order.id;
  }

  private async writeLines(tx: Prisma.TransactionClient, tenantId: bigint, orderId: bigint, lines: OrderLineInput[]) {
    await tx.salesOrderLine.createMany({
      data: lines.map((l, i) => ({
        tenantId,
        orderId,
        lineNo: i + 1,
        itemId: l.line.itemId,
        itemUnitId: l.line.itemUnitId,
        quoteLineId: l.quoteLineId,
        note: l.note,
        ...amountColumns(l.line),
      })),
    });
  }

  /**
   * Locks in the order of ADR-027 §8: company settings (shared), the order, its
   * lines, then the stock balances of the lines' items when `stock` is set and
   * the reservation is HARD. Plain reads come after these locks.
   */
  private async lockOrder(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, id: bigint, stock: boolean): Promise<OrderContext> {
    const settings = await lockCompanySales(tx, tenantId, companyId);
    const row = await lockSalesOrder(tx, tenantId, id);
    assertBranchAllowed(row.branch_id);
    const lines = await lockOrderLines(tx, tenantId, id);
    const onHand =
      stock && settings.salesReservation === 'HARD'
        ? await lockStockBalances(tx, tenantId, row.warehouse_id, [...new Set(lines.map((l) => l.itemId))])
        : new Map<bigint, Decimal>();
    return { tenantId, companyId, row, lines, settings, onHand };
  }

  /**
   * One status change under the locks above, retried on a lock conflict. A
   * stock-checking action (confirm, approve) takes the stock locks under HARD.
   */
  private async transition(
    id: bigint,
    action: 'confirm' | 'approve' | 'reject-approval' | 'cancel' | 'close',
    from: readonly string[],
    verb: string,
    stock: boolean,
    apply: (tx: Prisma.TransactionClient, ctx: OrderContext) => Promise<Prisma.SalesOrderUpdateInput>,
  ) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.orderOrNotFound(id);
    const data = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const ctx = await this.lockOrder(tx, tenantId, companyId, id, stock);
        assertStatus('sales order', ctx.row.status, from, verb);
        const update = await apply(tx, ctx);
        await tx.salesOrder.update({ where: { id }, data: update });
        return update;
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({
      action: `sales_order.${action}`,
      entityType: 'sales_order',
      entityId: id,
      after: {
        status: data.status as string,
        ...(data.orderNo ? { orderNo: data.orderNo as string } : {}),
        ...(data.cancelReason ? { reason: data.cancelReason as string } : {}),
        ...(data.closeReason ? { reason: data.closeReason as string } : {}),
        ...(data.rejectReason ? { reason: data.rejectReason as string } : {}),
      },
    });
    return this.get(id);
  }

  /** The update of a confirmed order: its number, from the order date (ADR-027 §3). */
  private async confirmedData(tx: Prisma.TransactionClient, ctx: OrderContext, extra: Prisma.SalesOrderUpdateInput) {
    const { orderDate } = await tx.salesOrder.findFirstOrThrow({ where: { id: ctx.row.id }, select: { orderDate: true } });
    const orderNo = await allocateDocumentNo(tx, ctx.tenantId, ctx.companyId, 'SALES_ORDER', orderDate);
    return { status: 'CONFIRMED', orderNo, confirmedAt: new Date(), confirmedBy: this.support.userId() ?? null, ...extra } as Prisma.SalesOrderUpdateInput;
  }

  /**
   * ADR-027 §6: whether the order waits for approval. OVER_CREDIT_LIMIT compares
   * the customer's whole exposure (its receivable from the ledger, its other
   * confirmed unbilled orders, and this order) with its credit limit.
   */
  private async approvalNeeded(tx: Prisma.TransactionClient, ctx: OrderContext, id: bigint): Promise<boolean> {
    const mode = ctx.settings.salesOrderApproval;
    if (mode === 'NONE') return false;
    if (mode === 'ALWAYS') return true;
    const order = await tx.salesOrder.findFirstOrThrow({ where: { id }, select: { customerId: true, grandTotal: true } });
    const party = await tx.party.findFirst({ where: { tenantId: ctx.tenantId, id: order.customerId }, select: { creditLimit: true } });
    const limit = party?.creditLimit ? new Decimal(party.creditLimit.toString()) : null;
    if (limit === null) return false;
    // The ledger read is company-wide: a restricted member must not see less exposure (ADR-003).
    const receivable = (await this.ledger.controlBalancesByParty('CUSTOMER', (await this.support.companyTodayDate()), undefined, { allBranches: true })).get(order.customerId) ?? new Decimal(0);
    const others = await tx.salesOrder.findMany({
      where: { companyId: ctx.companyId, customerId: order.customerId, status: { in: [...RESERVING_ORDER_STATUSES] }, id: { not: id } },
      select: { lines: { select: { lineTotal: true, qtyBase: true, invoicedQty: true } } },
    });
    let unbilled = new Decimal(0);
    for (const o of others) {
      unbilled = unbilled.plus(outstandingValue(o.lines.map((l) => ({ lineTotal: new Decimal(l.lineTotal.toString()), qtyBase: new Decimal(l.qtyBase.toString()), invoicedQty: new Decimal(l.invoicedQty.toString()) }))));
    }
    const exposure = receivable.plus(unbilled).plus(new Decimal(order.grandTotal.toString()));
    return needsOrderApproval(mode, overCreditLimit(limit, exposure));
  }

  /**
   * HARD reservation (ADR-027 §5): the order's stock lines must fit in what is
   * available: on hand less what other confirmed orders still hold. Runs
   * under the stock locks taken by lockOrder.
   */
  private async assertReservable(tx: Prisma.TransactionClient, ctx: OrderContext, orderId: bigint): Promise<void> {
    if (ctx.settings.salesReservation !== 'HARD') return;
    const kinds = await tx.item.findMany({
      where: { tenantId: ctx.tenantId, id: { in: [...new Set(ctx.lines.map((l) => l.itemId))] } },
      select: { id: true, itemKind: true },
    });
    const stock = new Set(kinds.filter((k) => k.itemKind === 'STOCK').map((k) => k.id));
    const needed = neededPerItem(ctx.lines.filter((l) => stock.has(l.itemId)).map((l) => ({ itemId: l.itemId, qtyBase: l.qtyBase })));
    if (needed.size === 0) return;
    const warehouseId = ctx.row.warehouse_id;
    const held = await reservedByItem(tx, ctx.tenantId, ctx.companyId, warehouseId, [...needed.keys()], orderId, false);
    for (const [itemId, need] of needed) {
      const available = availableQty(ctx.onHand.get(itemId) ?? null, held.get(itemId) ?? new Decimal(0));
      if (need.gt(available)) {
        throw new DomainError(ErrorCode.STOCK_RESERVED, 'The quantity is above what is available after the other orders reserve their stock', {
          itemId: itemId.toString(),
          needed: need.toFixed(6),
          available: available.toFixed(6),
        });
      }
    }
  }
}
