import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface MovementInput {
  warehouseId: bigint;
  itemId: bigint;
  movementDate: Date;
  /** IN adds qty, OUT removes qty — qty is always in BASE units. */
  type: 'IN' | 'OUT';
  qty: Decimal.Value;
  /**
   * Cost per base unit. Required for cost-bearing IN movements (purchase,
   * opening, manual IN); ignored for OUT (uses current average) and for
   * transfers where the caller passes the current avg explicitly.
   */
  unitCost?: Decimal.Value;
  sourceType: string;
  sourceId?: bigint | null;
  sourceLineId?: bigint | null;
  reversalOfId?: bigint | null;
  description?: string | null;
}

export interface MovementResult {
  movementId: bigint;
  unitCost: Decimal;
  totalCost: Decimal;
  balanceQtyAfter: Decimal;
  avgCostAfter: Decimal;
}

interface CostRow {
  id: bigint;
  totalQty: Decimal;
  totalValue: Decimal;
  avgCost: Decimal;
  lastMovementDate: Date | null;
}

interface BalanceRow {
  id: bigint;
  qtyOnHand: Decimal;
}

/** One (item, warehouse) pair a stock document moves. */
export interface StockKey {
  itemId: bigint;
  warehouseId: bigint;
}

/** Fixed lock order (§10.1 step 12): item_id, then warehouse_id, ascending. */
export function compareStockKeys(a: StockKey, b: StockKey): number {
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  if (a.warehouseId !== b.warehouseId) return a.warehouseId < b.warehouseId ? -1 : 1;
  return 0;
}

/**
 * StockLedgerService — the ONLY place stock movements are created and the
 * qty/cost projections (stock_balances, item_costs) are updated
 * (docs/BUILD_PLAN.md §9.1). Weighted-average costing per §9.2.
 * All methods run inside the caller's interactive transaction.
 */
@Injectable()
export class StockLedgerService {
  /**
   * Projection rows already created and locked in a transaction (keyed by the
   * transaction client, which is one object for the whole callback): a
   * document's applyMovement calls skip the create-if-missing read for them.
   */
  private readonly ensured = new WeakMap<object, Set<string>>();

  constructor(private readonly prisma: PrismaService) {}

  /** true the first time `key` is seen in this transaction. */
  private firstInTx(tx: Prisma.TransactionClient, key: string): boolean {
    let seen = this.ensured.get(tx);
    if (!seen) {
      seen = new Set<string>();
      this.ensured.set(tx, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  /**
   * Locks the projections of every (item, warehouse) a document will move,
   * before its first movement, in one fixed order (§10.1 step 12): the
   * item_costs rows by item_id, then the stock_balances rows by item_id and
   * warehouse_id, ascending. Two documents with the same items in a different
   * line order then queue on the first shared row instead of deadlocking.
   * Missing rows are created first (race-safe, see ensureCost/ensureBalance).
   * Service items are skipped: they have no projections. Every caller of
   * applyMovement calls this first with all of the document's pairs
   * (test/static/posting-transactions.spec.ts).
   */
  async lockForDocument(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    keys: StockKey[],
  ): Promise<void> {
    const { tenantId } = this.tenant();
    const itemIds = [...new Set(keys.map((k) => k.itemId))];
    if (itemIds.length === 0) return;
    const stockItems = await tx.item.findMany({
      where: { tenantId, companyId, id: { in: itemIds }, itemKind: 'STOCK' },
      select: { id: true },
    });
    const isStock = new Set(stockItems.map((i) => i.id));

    const pairs = new Map<string, StockKey>();
    for (const k of keys) {
      if (isStock.has(k.itemId)) pairs.set(`${k.itemId}:${k.warehouseId}`, k);
    }
    const sorted = [...pairs.values()].sort(compareStockKeys);
    const items = [...isStock].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const itemId of items) await this.lockCost(tx, tenantId, companyId, itemId);
    for (const k of sorted) await this.lockBalance(tx, tenantId, k.warehouseId, k.itemId);
  }

  /**
   * Applies one stock movement and updates projections atomically. A
   * document locks all its pairs with lockForDocument first; the locks taken
   * here are then already held and only re-read the current values.
   */
  async applyMovement(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    input: MovementInput,
  ): Promise<MovementResult> {
    const { tenantId } = this.tenant();
    const qty = new Decimal(input.qty);
    if (qty.lte(0)) {
      throw new DomainError(ErrorCode.VALIDATION, 'Movement qty must be > 0');
    }

    // Validate item is a stocked item of this company.
    const item = await tx.item.findFirst({
      where: { id: input.itemId, companyId, isActive: true },
      select: { id: true, code: true, nameAr: true, itemKind: true },
    });
    if (!item) throw DomainError.notFound('Item', input.itemId.toString());
    if (item.itemKind !== 'STOCK') {
      throw new DomainError(
        ErrorCode.VALIDATION,
        `Item ${item.code} is a service — it produces no stock movements`,
      );
    }

    const company = await tx.company.findFirst({
      where: { id: companyId },
      select: { allowNegativeStock: true },
    });

    // Lock projections FOR UPDATE in a fixed order (item_costs then
    // stock_balances) — same order everywhere prevents deadlocks (§10 step 12).
    const cost = await this.lockCost(tx, tenantId, companyId, input.itemId);
    const balance = await this.lockBalance(tx, tenantId, input.warehouseId, input.itemId);

    // §9.4 backdating: a stock document may not post before the item's
    // latest movement date.
    if (
      cost.lastMovementDate &&
      input.movementDate < new Date(cost.lastMovementDate.toISOString().slice(0, 10))
    ) {
      throw new DomainError(
        ErrorCode.BACKDATED_STOCK_POSTING,
        `Cannot post on ${input.movementDate.toISOString().slice(0, 10)} — item ${item.code} has movements dated ${cost.lastMovementDate.toISOString().slice(0, 10)}`,
      );
    }

    const { unitCost, totalCost, newTotalQty, newTotalValue, newAvg } =
      input.type === 'IN'
        ? this.applyIn(cost, qty, input.unitCost)
        : this.applyOut(cost, qty);

    const newBalanceQty =
      input.type === 'IN'
        ? new Decimal(balance.qtyOnHand).plus(qty)
        : new Decimal(balance.qtyOnHand).minus(qty);

    // §9.3 negative stock.
    if (newBalanceQty.lt(0) && !company?.allowNegativeStock) {
      throw new DomainError(
        ErrorCode.STOCK_INSUFFICIENT,
        `Insufficient stock for ${item.code}: available ${new Decimal(balance.qtyOnHand).toString()}, requested ${qty.toString()}`,
      );
    }

    const movement = await tx.stockMovement.create({
      data: {
        tenantId,
        companyId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        movementDate: input.movementDate,
        movementType: input.type,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        sourceLineId: input.sourceLineId ?? null,
        qtyIn: input.type === 'IN' ? qty : new Decimal(0),
        qtyOut: input.type === 'OUT' ? qty : new Decimal(0),
        unitCost,
        totalCost,
        balanceQtyAfter: newBalanceQty,
        avgCostAfter: newAvg,
        reversalOfId: input.reversalOfId ?? null,
      },
    });

    // updateMany, not update: the projection row may have been inserted by a
    // posting that committed after this transaction's snapshot (first
    // movement race). The locking read above sees it, but `update` reads it
    // back through the snapshot and fails with "record not found"; a plain
    // UPDATE works on the latest committed row, like FOR UPDATE.
    const balanceUpdated = await tx.stockBalance.updateMany({
      where: { tenantId, id: balance.id },
      data: {
        qtyOnHand: newBalanceQty,
        lastMovementDate: input.movementDate,
      },
    });

    const costUpdated = await tx.itemCost.updateMany({
      where: { tenantId, id: cost.id },
      data: {
        totalQty: newTotalQty,
        totalValue: newTotalValue,
        avgCost: newAvg,
        lastMovementDate: input.movementDate,
      },
    });
    if (balanceUpdated.count !== 1 || costUpdated.count !== 1) {
      throw new DomainError(ErrorCode.INTERNAL, 'Stock projection row missing after lock');
    }

    return {
      movementId: movement.id,
      unitCost,
      totalCost,
      balanceQtyAfter: newBalanceQty,
      avgCostAfter: newAvg,
    };
  }

  /** §9.2 — inbound movement: weighted-average recalc. */
  private applyIn(
    cost: CostRow,
    qty: Decimal,
    unitCostInput?: Decimal.Value,
  ): {
    unitCost: Decimal;
    totalCost: Decimal;
    newTotalQty: Decimal;
    newTotalValue: Decimal;
    newAvg: Decimal;
  } {
    const unitCost =
      unitCostInput !== undefined && unitCostInput !== null
        ? new Decimal(unitCostInput)
        : new Decimal(cost.avgCost);
    if (unitCost.lt(0)) {
      throw new DomainError(ErrorCode.VALIDATION, 'unitCost cannot be negative');
    }
    const totalCost = round3(qty.times(unitCost));
    const newTotalQty = new Decimal(cost.totalQty).plus(qty);
    const newTotalValue = new Decimal(cost.totalValue).plus(totalCost);
    const newAvg = newTotalQty.gt(0)
      ? round6(newTotalValue.dividedBy(newTotalQty))
      : new Decimal(0);
    return { unitCost, totalCost, newTotalQty, newTotalValue, newAvg };
  }

  /** §9.2 — outbound movement at current average cost. */
  private applyOut(
    cost: CostRow,
    qty: Decimal,
  ): {
    unitCost: Decimal;
    totalCost: Decimal;
    newTotalQty: Decimal;
    newTotalValue: Decimal;
    newAvg: Decimal;
  } {
    const unitCost = new Decimal(cost.avgCost);
    const currentQty = new Decimal(cost.totalQty);
    // If this outflow empties the item, carry the remaining value out in
    // full to avoid rounding residue (§9.2).
    const totalCost = qty.eq(currentQty)
      ? new Decimal(cost.totalValue)
      : round3(qty.times(unitCost));
    const newTotalQty = currentQty.minus(qty);
    const newTotalValue = new Decimal(cost.totalValue).minus(totalCost);
    const newAvg = newTotalQty.gt(0)
      ? round6(newTotalValue.dividedBy(newTotalQty))
      : new Decimal(0);
    return { unitCost, totalCost, newTotalQty, newTotalValue, newAvg };
  }

  /**
   * Creates the item_costs row on an item's first movement. Two postings can
   * race here: a plain create makes the second fail with a unique violation.
   * INSERT … ON DUPLICATE KEY UPDATE waits for the other insert and then takes
   * an exclusive lock on its row instead (INSERT IGNORE would take a shared
   * one, and two of those upgrading to FOR UPDATE deadlock). The read first
   * keeps the common case, an existing row, from consuming auto-increment ids.
   */
  private async ensureCost(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    itemId: bigint,
  ): Promise<void> {
    const existing = await tx.itemCost.findFirst({
      where: { tenantId, companyId, itemId },
      select: { id: true },
    });
    if (existing) return;
    await tx.$executeRaw`
      INSERT INTO item_costs (tenant_id, company_id, item_id, updated_at)
      VALUES (${tenantId}, ${companyId}, ${itemId}, ${new Date()})
      ON DUPLICATE KEY UPDATE id = id
    `;
  }

  /** Same as ensureCost, for the stock_balances row of an (item, warehouse). */
  private async ensureBalance(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    warehouseId: bigint,
    itemId: bigint,
  ): Promise<void> {
    const existing = await tx.stockBalance.findFirst({
      where: { tenantId, warehouseId, itemId },
      select: { id: true },
    });
    if (existing) return;
    await tx.$executeRaw`
      INSERT INTO stock_balances (tenant_id, warehouse_id, item_id, updated_at)
      VALUES (${tenantId}, ${warehouseId}, ${itemId}, ${new Date()})
      ON DUPLICATE KEY UPDATE id = id
    `;
  }

  /** Create-if-missing + SELECT … FOR UPDATE on item_costs. */
  private async lockCost(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    itemId: bigint,
  ): Promise<CostRow> {
    if (this.firstInTx(tx, `cost:${companyId}:${itemId}`)) {
      await this.ensureCost(tx, tenantId, companyId, itemId);
    }
    const rows = (await tx.$queryRaw`
      SELECT id, total_qty, total_value, avg_cost, last_movement_date
      FROM item_costs
      WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND item_id = ${itemId}
      FOR UPDATE
    `) as {
      id: bigint;
      total_qty: unknown;
      total_value: unknown;
      avg_cost: unknown;
      last_movement_date: Date | null;
    }[];
    const r = rows[0];
    return {
      id: r.id,
      totalQty: new Decimal(r.total_qty?.toString() ?? 0),
      totalValue: new Decimal(r.total_value?.toString() ?? 0),
      avgCost: new Decimal(r.avg_cost?.toString() ?? 0),
      lastMovementDate: r.last_movement_date,
    };
  }

  /** Create-if-missing + SELECT … FOR UPDATE on stock_balances. */
  private async lockBalance(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    warehouseId: bigint,
    itemId: bigint,
  ): Promise<BalanceRow> {
    if (this.firstInTx(tx, `balance:${warehouseId}:${itemId}`)) {
      await this.ensureBalance(tx, tenantId, warehouseId, itemId);
    }
    const rows = (await tx.$queryRaw`
      SELECT id, qty_on_hand
      FROM stock_balances
      WHERE tenant_id = ${tenantId} AND warehouse_id = ${warehouseId} AND item_id = ${itemId}
      FOR UPDATE
    `) as { id: bigint; qty_on_hand: unknown }[];
    const r = rows[0];
    return { id: r.id, qtyOnHand: new Decimal(r.qty_on_hand?.toString() ?? 0) };
  }

  /** Recomputes balances from movements — used by stock:verify (§9.1). */
  async verify() {
    const { db } = this.tenant();
    const movements = await db.stockMovement.findMany({
      orderBy: [{ movementDate: 'asc' }, { id: 'asc' }],
      select: {
        warehouseId: true,
        itemId: true,
        qtyIn: true,
        qtyOut: true,
      },
    });
    const recomputed = new Map<string, Decimal>();
    for (const m of movements) {
      const key = `${m.warehouseId}:${m.itemId}`;
      const cur = recomputed.get(key) ?? new Decimal(0);
      recomputed.set(
        key,
        cur.plus(new Decimal(m.qtyIn.toString())).minus(new Decimal(m.qtyOut.toString())),
      );
    }
    const balances = await db.stockBalance.findMany({
      select: { warehouseId: true, itemId: true, qtyOnHand: true },
    });
    const mismatches: {
      warehouseId: string;
      itemId: string;
      expected: string;
      actual: string;
    }[] = [];
    const seen = new Set<string>();
    for (const b of balances) {
      const key = `${b.warehouseId}:${b.itemId}`;
      seen.add(key);
      const expected = recomputed.get(key) ?? new Decimal(0);
      const actual = new Decimal(b.qtyOnHand.toString());
      if (!expected.eq(actual)) {
        mismatches.push({
          warehouseId: b.warehouseId.toString(),
          itemId: b.itemId.toString(),
          expected: expected.toString(),
          actual: actual.toString(),
        });
      }
    }
    for (const [key, expected] of recomputed) {
      if (!seen.has(key) && !expected.isZero()) {
        const [warehouseId, itemId] = key.split(':');
        mismatches.push({ warehouseId, itemId, expected: expected.toString(), actual: '0' });
      }
    }
    return { checked: recomputed.size, mismatches };
  }
}
