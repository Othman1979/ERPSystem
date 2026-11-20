import { Injectable } from '@nestjs/common';
import { branchWhere } from '../../common/branch/branch-context.js';
import { Decimal, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { currentCompanySqlFilter } from '../../common/cls/current-company.js';
import { Prisma } from '../../generated/prisma/client.js';
import { DocumentSupportService } from '../shared/document-support.service.js';

/** Order statuses a GRN may receive against (ADR-026 §6): approved, or received in part. */
export const RECEIVABLE_ORDER_STATUSES = ['APPROVED', 'PARTIALLY_RECEIVED'] as const;
/** Order statuses whose posted receipts may be billed (§7): anything received, closed included. */
export const BILLABLE_ORDER_STATUSES = ['PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const;

type Num = { toString(): string };

/** An order line as receiving and billing read it, under the order's lock. */
export interface LockedOrderLine {
  id: bigint;
  lineNo: number;
  itemId: bigint;
  itemUnitId: bigint | null;
  qtyBase: Decimal;
  receivedQty: Decimal;
  netAmount: Decimal;
  unitPrice: Decimal;
  discountPct: Decimal;
  taxCategoryId: bigint | null;
  taxRate: Decimal;
  /** Base units per line unit (qty_base / qty). */
  factorToBase: Decimal;
}

/** A purchase order as receiving and billing read it, under its lock. */
export interface LockedOrder {
  id: bigint;
  orderNo: string | null;
  status: string;
  branchId: bigint | null;
  supplierId: bigint;
  warehouseId: bigint;
  costCenterId: bigint | null;
  pricesIncludeTax: boolean;
  /** By id, ascending. */
  lines: Map<bigint, LockedOrderLine>;
}

const big = (v: bigint | number | null) => (v === null ? null : BigInt(v));

/**
 * The receipt cost of an order line (ADR-026 §5): its net amount per base
 * unit, tax extracted already when the order prices include tax (ADR-017,
 * as the order's net amount was computed), at 6 dp.
 */
export function orderLineUnitCost(line: Pick<LockedOrderLine, 'netAmount' | 'qtyBase'>): Decimal {
  return round6(line.netAmount.div(line.qtyBase));
}

/**
 * Net price per base unit, exactly (no rounding): price less the discount
 * percentage, per base unit, net of tax when the price includes it. The
 * order and the invoice are compared on it (ADR-026 §2), so the same price,
 * discount, unit and tax basis compare equal whatever the quantity.
 */
export function netUnitPrice(p: {
  unitPrice: Decimal.Value;
  discountPct: Decimal.Value;
  factorToBase: Decimal.Value;
  taxRate: Decimal.Value;
  pricesIncludeTax: boolean;
}): Decimal {
  const afterDiscount = new Decimal(p.unitPrice).times(new Decimal(100).minus(p.discountPct)).div(100);
  const perBase = afterDiscount.div(p.factorToBase);
  return p.pricesIncludeTax ? perBase.div(new Decimal(p.taxRate).div(100).plus(1)) : perBase;
}

/**
 * Receiving against purchase orders (ADR-026 §5–6), for the goods-notes and
 * purchases modules: the order and its lines locked in the fixed order
 * (§10: the order, then its lines by id), the received quantities recorded
 * and checked under those locks, and the order's receipt status. It owns
 * purchase_orders / purchase_order_lines; callers never read them directly.
 */
@Injectable()
export class PurchaseOrderReceiptsService {
  constructor(private readonly support: DocumentSupportService) {}

  /**
   * The order FOR UPDATE, then its lines FOR UPDATE in id order, on the
   * caller's transaction (ADR-026 §10). Locking reads, so the received
   * quantities are the latest committed ones even after waiting; call it
   * before the transaction's first plain read. `shared` takes LOCK IN SHARE
   * MODE instead (a draft that only reads the order). NOT_FOUND when absent.
   */
  async lockOrder(tx: Prisma.TransactionClient, orderId: bigint, shared = false): Promise<LockedOrder> {
    const { tenantId } = this.support.tenant();
    const mode = shared ? Prisma.sql`LOCK IN SHARE MODE` : Prisma.sql`FOR UPDATE`;
    const [o] = await tx.$queryRaw<
      {
        id: bigint;
        order_no: string | null;
        status: string;
        branch_id: bigint | null;
        supplier_id: bigint;
        warehouse_id: bigint;
        cost_center_id: bigint | null;
        prices_include_tax: boolean | number;
      }[]
    >`
      SELECT id, order_no, status, branch_id, supplier_id, warehouse_id, cost_center_id, prices_include_tax
        FROM purchase_orders WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${orderId} ${mode}`;
    if (!o) throw DomainError.notFound('PurchaseOrder', orderId.toString());
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        line_no: number;
        item_id: bigint;
        item_unit_id: bigint | null;
        qty: Num;
        qty_base: Num;
        received_qty: Num;
        net_amount: Num;
        unit_price: Num;
        discount_pct: Num;
        tax_category_id: bigint | null;
        tax_rate: Num;
      }[]
    >`
      SELECT id, line_no, item_id, item_unit_id, qty, qty_base, received_qty, net_amount, unit_price,
             discount_pct, tax_category_id, tax_rate
        FROM purchase_order_lines WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
       ORDER BY id ${mode}`;
    const lines = new Map<bigint, LockedOrderLine>();
    for (const r of rows) {
      const qty = new Decimal(r.qty.toString());
      const qtyBase = new Decimal(r.qty_base.toString());
      lines.set(BigInt(r.id), {
        id: BigInt(r.id),
        lineNo: Number(r.line_no),
        itemId: BigInt(r.item_id),
        itemUnitId: big(r.item_unit_id),
        qtyBase,
        receivedQty: new Decimal(r.received_qty.toString()),
        netAmount: new Decimal(r.net_amount.toString()),
        unitPrice: new Decimal(r.unit_price.toString()),
        discountPct: new Decimal(r.discount_pct.toString()),
        taxCategoryId: big(r.tax_category_id),
        taxRate: new Decimal(r.tax_rate.toString()),
        factorToBase: qty.isZero() ? new Decimal(1) : qtyBase.div(qty),
      });
    }
    return {
      id: BigInt(o.id),
      orderNo: o.order_no,
      status: o.status,
      branchId: big(o.branch_id),
      supplierId: BigInt(o.supplier_id),
      warehouseId: BigInt(o.warehouse_id),
      costCenterId: big(o.cost_center_id),
      pricesIncludeTax: Boolean(Number(o.prices_include_tax)),
      lines,
    };
  }

  /**
   * ADR-026 §4: the base quantities a receipt takes, per order line, within
   * what is left (qty_base − received_qty). PURCHASE_ORDER_OVER_RECEIPT when
   * a line would be received above its order; NOT_FOUND for a line of
   * another order. Pure: `order` is the locked state.
   */
  assertWithinOrder(order: LockedOrder, wanted: Map<bigint, Decimal>): void {
    for (const [lineId, qty] of wanted) {
      const line = order.lines.get(lineId);
      if (!line) throw DomainError.notFound('PurchaseOrderLine', lineId.toString());
      const left = line.qtyBase.minus(line.receivedQty);
      if (qty.gt(left)) {
        throw new DomainError(
          ErrorCode.PURCHASE_ORDER_OVER_RECEIPT,
          `Line ${line.lineNo} of the order has ${left.toFixed(6)} left to receive`,
          { poLineId: lineId.toString(), lineNo: line.lineNo, remaining: left.toFixed(6), wanted: qty.toFixed(6) },
        );
      }
    }
  }

  /**
   * Records a posted GRN on the order, on the posting transaction that holds
   * the order's locks (lockOrder): received_qty grows by the quantities
   * (checked again here, ADR-026 §4), and the order becomes RECEIVED once
   * every line is received in full, PARTIALLY_RECEIVED otherwise. Returns
   * the new status.
   */
  async recordReceipt(tx: Prisma.TransactionClient, order: LockedOrder, received: Map<bigint, Decimal>): Promise<string> {
    this.assertWithinOrder(order, received);
    for (const [lineId, qty] of received) {
      if (qty.isZero()) continue;
      await tx.purchaseOrderLine.update({ where: { id: lineId }, data: { receivedQty: { increment: qty } } });
    }
    const full = [...order.lines.values()].every((l) => l.receivedQty.plus(received.get(l.id) ?? 0).gte(l.qtyBase));
    const status = full ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    if (status !== order.status) {
      await tx.purchaseOrder.update({ where: { id: order.id }, data: { status } });
    }
    return status;
  }

  /**
   * What is left to receive on each line of an order of the caller's
   * branches (another tenant's or branch's answers 404), for the «Receive»
   * action's defaults. No lock: the receipt checks it all again under them.
   */
  async receivable(orderId: bigint) {
    const { db } = this.support.tenant();
    const order = await db.purchaseOrder.findFirst({
      where: { id: orderId, AND: [branchWhere()] },
      select: {
        id: true,
        warehouseId: true,
        lines: { orderBy: { lineNo: 'asc' }, select: { id: true, itemId: true, qtyBase: true, receivedQty: true } },
      },
    });
    if (!order) throw DomainError.notFound('PurchaseOrder', orderId.toString());
    return {
      warehouseId: order.warehouseId,
      lines: order.lines.map((l) => ({ id: l.id, itemId: l.itemId, remaining: new Decimal(l.qtyBase.toString()).minus(l.receivedQty.toString()) })),
    };
  }

  /**
   * An order of the caller's branches with its lines, for an invoice drafted
   * from its receipts (header defaults, prices to compare with). No lock:
   * an approved order's lines never change; posting locks it.
   */
  async forBilling(orderId: bigint, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.support.tenant().db;
    const order = await db.purchaseOrder.findFirst({
      where: { id: orderId, AND: [branchWhere()] },
      select: {
        id: true,
        orderNo: true,
        status: true,
        branchId: true,
        supplierId: true,
        warehouseId: true,
        costCenterId: true,
        pricesIncludeTax: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            id: true,
            lineNo: true,
            itemId: true,
            itemUnitId: true,
            qty: true,
            qtyBase: true,
            receivedQty: true,
            netAmount: true,
            unitPrice: true,
            discountPct: true,
            taxCategoryId: true,
            taxRate: true,
          },
        },
      },
    });
    if (!order) throw DomainError.notFound('PurchaseOrder', orderId.toString());
    return {
      ...order,
      lines: new Map(
        order.lines.map((l) => {
          const qty = new Decimal(l.qty.toString());
          const qtyBase = new Decimal(l.qtyBase.toString());
          const line: LockedOrderLine = {
            id: l.id,
            lineNo: l.lineNo,
            itemId: l.itemId,
            itemUnitId: l.itemUnitId,
            qtyBase,
            receivedQty: new Decimal(l.receivedQty.toString()),
            netAmount: new Decimal(l.netAmount.toString()),
            unitPrice: new Decimal(l.unitPrice.toString()),
            discountPct: new Decimal(l.discountPct.toString()),
            taxCategoryId: l.taxCategoryId,
            taxRate: new Decimal(l.taxRate.toString()),
            factorToBase: qty.isZero() ? new Decimal(1) : qtyBase.div(qty),
          };
          return [l.id, line];
        }),
      ),
    };
  }
}
