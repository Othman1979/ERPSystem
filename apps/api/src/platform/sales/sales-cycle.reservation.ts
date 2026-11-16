import { Decimal } from '../../common/decimal/decimal.utils.js';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Base quantity held per item by the open lines of one warehouse's orders, not
 * counting `excludeOrderId` (ADR-027 §5). Computed from the lines, never stored.
 *
 * `lock` takes a shared locking read: the latest committed quantities, whatever
 * snapshot the transaction holds. A HARD check of an invoice post needs it: the
 * post reads its reservations after its stock locks, and a plain read there
 * would return the snapshot of an earlier read in the same transaction.
 * Every read names the tenant and the company.
 */
export async function reservedByItem(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  companyId: bigint,
  warehouseId: bigint,
  itemIds: bigint[],
  excludeOrderId: bigint | null,
  lock: boolean,
): Promise<Map<bigint, Decimal>> {
  const out = new Map<bigint, Decimal>();
  if (itemIds.length === 0) return out;
  const excluded = excludeOrderId ?? BigInt(0);
  const lockClause = lock ? Prisma.sql` LOCK IN SHARE MODE` : Prisma.empty;
  const rows = await tx.$queryRaw<{ item_id: bigint; reserved: { toString(): string } }[]>`
    SELECT l.item_id AS item_id, COALESCE(SUM(GREATEST(l.qty_base - l.invoiced_qty, 0)), 0) AS reserved
      FROM sales_order_lines l
      JOIN sales_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
     WHERE l.tenant_id = ${tenantId} AND o.company_id = ${companyId} AND o.warehouse_id = ${warehouseId}
       AND o.status IN ('CONFIRMED', 'PARTIALLY_INVOICED') AND o.id <> ${excluded}
       AND l.item_id IN (${Prisma.join(itemIds)})
     GROUP BY l.item_id${lockClause}`;
  for (const r of rows) out.set(BigInt(r.item_id), new Decimal(r.reserved.toString()));
  return out;
}
