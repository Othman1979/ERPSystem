import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Row locks of the sales quotes and orders (ADR-027 §8), always in one order
 * so two transactions never wait on each other in a cycle:
 *
 *   the order (or quote) → its lines (id order) → stock balances (item, warehouse)
 *   → member_permissions (shared, approvals) → sequence.
 *
 * Every lock here is a locking read. A transaction that takes these locks
 * must not run a plain read before them: a plain read fixes the REPEATABLE
 * READ snapshot, and a stale snapshot would miss the commit it waited for
 * (the reservation check of HARD mode depends on it).
 */

export interface LockedSalesOrderRow {
  id: bigint;
  status: string;
  branch_id: bigint | null;
  created_by: bigint | null;
  updated_by: bigint | null;
  submitted_by: bigint | null;
  warehouse_id: bigint;
}

/** The order row FOR UPDATE; NOT_FOUND when absent. */
export async function lockSalesOrder(tx: Prisma.TransactionClient, tenantId: bigint, id: bigint): Promise<LockedSalesOrderRow> {
  const [row] = await tx.$queryRaw<LockedSalesOrderRow[]>`
    SELECT id, status, branch_id, created_by, updated_by, submitted_by, warehouse_id
      FROM sales_orders WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  if (!row) throw DomainError.notFound('SalesOrder', id.toString());
  return {
    ...row,
    id: BigInt(row.id),
    warehouse_id: BigInt(row.warehouse_id),
    branch_id: row.branch_id === null ? null : BigInt(row.branch_id),
    created_by: row.created_by === null ? null : BigInt(row.created_by),
    updated_by: row.updated_by === null ? null : BigInt(row.updated_by),
    submitted_by: row.submitted_by === null ? null : BigInt(row.submitted_by),
  };
}

export interface LockedSalesQuoteRow {
  id: bigint;
  status: string;
  branch_id: bigint | null;
  created_by: bigint | null;
  updated_by: bigint | null;
}

/** The quote row FOR UPDATE; NOT_FOUND when absent. */
export async function lockSalesQuote(tx: Prisma.TransactionClient, tenantId: bigint, id: bigint): Promise<LockedSalesQuoteRow> {
  const [row] = await tx.$queryRaw<LockedSalesQuoteRow[]>`
    SELECT id, status, branch_id, created_by, updated_by
      FROM sales_quotes WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  if (!row) throw DomainError.notFound('SalesQuote', id.toString());
  return {
    ...row,
    id: BigInt(row.id),
    branch_id: row.branch_id === null ? null : BigInt(row.branch_id),
    created_by: row.created_by === null ? null : BigInt(row.created_by),
    updated_by: row.updated_by === null ? null : BigInt(row.updated_by),
  };
}

export interface LockedOrderLine {
  id: bigint;
  itemId: bigint;
  qtyBase: Decimal;
  invoicedQty: Decimal;
  lineTotal: Decimal;
}

/** The order's lines FOR UPDATE, in id order: the invoiced quantities a confirmation reads are current. */
export async function lockOrderLines(tx: Prisma.TransactionClient, tenantId: bigint, orderId: bigint): Promise<LockedOrderLine[]> {
  const rows = await tx.$queryRaw<
    { id: bigint; item_id: bigint; qty_base: { toString(): string }; invoiced_qty: { toString(): string }; line_total: { toString(): string } }[]
  >`
    SELECT id, item_id, qty_base, invoiced_qty, line_total FROM sales_order_lines
     WHERE tenant_id = ${tenantId} AND order_id = ${orderId} ORDER BY id FOR UPDATE`;
  return rows.map((r) => ({
    id: BigInt(r.id),
    itemId: BigInt(r.item_id),
    qtyBase: new Decimal(r.qty_base.toString()),
    invoicedQty: new Decimal(r.invoiced_qty.toString()),
    lineTotal: new Decimal(r.line_total.toString()),
  }));
}

export interface LockedSalesSettings {
  pricesIncludeTax: boolean;
  quoteValidityDays: number;
  salesOrderRequired: boolean;
  salesReservation: 'NONE' | 'SOFT' | 'HARD';
  salesOrderApproval: 'NONE' | 'OVER_CREDIT_LIMIT' | 'ALWAYS';
  salesPriceLocked: boolean;
}

/**
 * The company's sales settings read under a shared lock of its row (ADR-027
 * §1): the first lock of every sales transaction, so a settings change
 * committed meanwhile is seen, and a concurrent change waits for this one.
 */
export async function lockCompanySales(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint): Promise<LockedSalesSettings> {
  const [row] = await tx.$queryRaw<
    {
      prices_include_tax: boolean | number;
      quote_validity_days: number;
      sales_order_required: boolean | number;
      sales_reservation: LockedSalesSettings['salesReservation'];
      sales_order_approval: LockedSalesSettings['salesOrderApproval'];
      sales_price_locked: boolean | number;
    }[]
  >`
    SELECT prices_include_tax, quote_validity_days, sales_order_required, sales_reservation,
           sales_order_approval, sales_price_locked
      FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} LOCK IN SHARE MODE`;
  if (!row) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
  return {
    pricesIncludeTax: Boolean(Number(row.prices_include_tax)),
    quoteValidityDays: Number(row.quote_validity_days),
    salesOrderRequired: Boolean(Number(row.sales_order_required)),
    salesReservation: row.sales_reservation,
    salesOrderApproval: row.sales_order_approval,
    salesPriceLocked: Boolean(Number(row.sales_price_locked)),
  };
}

/**
 * The stock balance rows of the items in one warehouse, FOR UPDATE in item
 * order (ADR-027 §5). A row that does not exist is not locked: its quantity
 * is 0 on hand, and nothing can be reserved on it.
 */
export async function lockStockBalances(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  warehouseId: bigint,
  itemIds: bigint[],
): Promise<Map<bigint, Decimal>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ item_id: bigint; qty_on_hand: { toString(): string } }[]>`
    SELECT item_id, qty_on_hand FROM stock_balances
     WHERE tenant_id = ${tenantId} AND warehouse_id = ${warehouseId}
       AND item_id IN (${Prisma.join(itemIds)})
     ORDER BY item_id, warehouse_id FOR UPDATE`;
  return new Map(rows.map((r) => [BigInt(r.item_id), new Decimal(r.qty_on_hand.toString())]));
}
