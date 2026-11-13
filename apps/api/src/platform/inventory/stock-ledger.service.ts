import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { costMovement, type CostState } from './stock-costing.js';

export interface MovementInput {
  warehouseId: bigint;
  itemId: bigint;
  movementDate: Date;
  /** IN adds qty, OUT removes qty — qty is always in BASE units. */
  type: 'IN' | 'OUT';
  qty: Decimal.Value;
  /**
   * Cost per base unit. IN: the incoming cost (purchase, opening, manual IN,
   * sales return at the original line cost); default: the current average.
   * OUT: a specific cost — a purchase return leaves at the original purchase
   * line cost (§9.5); default: the current average (§9.2).
   */
  unitCost?: Decimal.Value | null;
  /**
   * Exact value of the movement, for a reversal that mirrors the original
   * movement (§9.5, DB-04/05). Takes precedence over unitCost for the value.
   */
  totalCost?: Decimal.Value | null;
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
  /**
   * Value removed from stock on top of totalCost (negative: added), see
   * stock-costing.ts. The posting document books it with
   * `stockWriteOffLines` (Dr INVENTORY_ADJUSTMENT / Cr INVENTORY).
   */
  writeOff: Decimal;
}

/** One line of a warehouse transfer: OUT of one warehouse, IN to another, same value. */
export interface TransferInput {
  itemId: bigint;
  fromWarehouseId: bigint;
  toWarehouseId: bigint;
  movementDate: Date;
  qty: Decimal.Value;
  /** A reversal passes the original legs' cost so it mirrors them exactly (DB-04). */
  unitCost?: Decimal.Value | null;
  totalCost?: Decimal.Value | null;
  sourceType: string;
  sourceId: bigint;
  sourceLineId?: bigint | null;
  /** Reversal: the original IN leg (undone by the new OUT) and OUT leg (undone by the new IN). */
  reversalOfInId?: bigint | null;
  reversalOfOutId?: bigint | null;
}

export interface TransferResult {
  outMovementId: bigint;
  inMovementId: bigint;
  unitCost: Decimal;
  totalCost: Decimal;
}

export interface VerifyResult {
  checked: number;
  mismatches: VerifyMismatch[];
  stockValue: string;
  inventoryAccountBalance: string | null;
}

/** One difference stock:verify found. */
export type VerifyMismatch =
  | { kind: 'QTY'; warehouseId: string; itemId: string; expected: string; actual: string }
  | { kind: 'COST_QTY' | 'COST_VALUE'; companyId: string; itemId: string; expected: string; actual: string }
  | { kind: 'GL_INVENTORY'; companyId: string; accountCode: string | null; expected: string; actual: string };

interface CostRow extends CostState {
  id: bigint;
  lastMovementDate: Date | null;
}

interface BalanceRow {
  id: bigint;
  qtyOnHand: Decimal;
}

interface ItemInfo {
  code: string;
  itemKind: 'STOCK' | 'SERVICE';
  isActive: boolean;
}

/** What one transaction has loaded and locked (the tx client is one object per callback). */
interface TxState {
  items: Map<bigint, ItemInfo>;
  allowNegative: Map<bigint, boolean>;
  /** `${companyId}:${itemId}` → locked item_costs row, kept current by this service. */
  costs: Map<string, CostRow>;
  /** `${warehouseId}:${itemId}` → locked stock_balances row. */
  balances: Map<string, BalanceRow>;
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

function ascending(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns may move an item deactivated after it was sold or bought (TRADE-15). */
const RETURN_SOURCES = new Set(['SALES_RETURN', 'PURCHASE_RETURN']);

/** Zero-quantity movement carrying a write-off / revaluation (ADR-018). */
export const REVALUATION_SOURCE = 'REVALUATION';

/**
 * StockLedgerService — the ONLY place stock movements are created and the
 * qty/cost projections (stock_balances, item_costs) are updated
 * (docs/BUILD_PLAN.md §9.1). Weighted-average costing per §9.2, in
 * stock-costing.ts. All methods run inside the caller's interactive
 * transaction.
 *
 * A document calls lockForDocument once with all its (item, warehouse) pairs:
 * it loads the items and the company setting, creates missing projection
 * rows and locks them in batches (TRADE-21 / DB-09: a few queries per
 * document instead of ~9 per line). applyMovement then works on the locked
 * rows it keeps in memory for the transaction.
 */
@Injectable()
export class StockLedgerService {
  private readonly states = new WeakMap<object, TxState>();

  constructor(private readonly prisma: PrismaService) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private state(tx: Prisma.TransactionClient): TxState {
    let s = this.states.get(tx);
    if (!s) {
      s = { items: new Map(), allowNegative: new Map(), costs: new Map(), balances: new Map() };
      this.states.set(tx, s);
    }
    return s;
  }

  /**
   * Locks the projections of every (item, warehouse) a document will move,
   * before its first movement, in one fixed order (§10.1 step 12): the
   * item_costs rows by item_id, then the stock_balances rows. Every writer of
   * a stock_balances row holds its item's item_costs lock first, so two
   * documents with the same items in a different line order queue on the
   * first shared item instead of deadlocking. Missing rows are created first,
   * race-safe (INSERT … ON DUPLICATE KEY UPDATE waits for a concurrent insert
   * and then locks its row; INSERT IGNORE would take a shared lock, and two
   * of those upgrading to FOR UPDATE deadlock).
   *
   * Returns the ids of the stocked items among `keys` (service items have no
   * projections and no movements), so callers need no per-line item read.
   * Every caller of applyMovement / applyTransfer calls this first with all of
   * the document's pairs (test/static/posting-transactions.spec.ts).
   */
  async lockForDocument(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    keys: StockKey[],
  ): Promise<Set<bigint>> {
    const { tenantId } = this.tenant();
    const itemIds = [...new Set(keys.map((k) => k.itemId))];
    if (itemIds.length === 0) return new Set();
    const st = this.state(tx);
    await this.loadItems(tx, tenantId, companyId, itemIds);
    await this.allowNegative(tx, companyId);

    const stock = itemIds.filter((id) => st.items.get(id)?.itemKind === 'STOCK').sort(ascending);
    const isStock = new Set(stock);
    await this.lockCosts(tx, tenantId, companyId, stock);

    const byWarehouse = new Map<bigint, Set<bigint>>();
    for (const k of keys) {
      if (!isStock.has(k.itemId)) continue;
      const set = byWarehouse.get(k.warehouseId) ?? new Set<bigint>();
      set.add(k.itemId);
      byWarehouse.set(k.warehouseId, set);
    }
    for (const warehouseId of [...byWarehouse.keys()].sort(ascending)) {
      await this.lockBalances(tx, tenantId, warehouseId, [...byWarehouse.get(warehouseId)!].sort(ascending));
    }
    return isStock;
  }

  /** The stocked items among `itemIds` (no locks), e.g. for a service-only document. */
  async stockItemIds(tx: Prisma.TransactionClient, companyId: bigint, itemIds: bigint[]): Promise<Set<bigint>> {
    const { tenantId } = this.tenant();
    const ids = [...new Set(itemIds)];
    await this.loadItems(tx, tenantId, companyId, ids);
    const st = this.state(tx);
    return new Set(ids.filter((id) => st.items.get(id)?.itemKind === 'STOCK'));
  }

  /**
   * Current on-hand quantity of locked (item, warehouse) pairs — read from
   * the rows lockForDocument locked, so it is the latest committed value
   * (stock count approval compares it with the count snapshot, TRADE-07).
   */
  lockedQtyOnHand(tx: Prisma.TransactionClient, warehouseId: bigint, itemId: bigint): Decimal {
    const row = this.state(tx).balances.get(`${warehouseId}:${itemId}`);
    if (!row) throw new DomainError(ErrorCode.INTERNAL, 'Stock balance read before lockForDocument');
    return row.qtyOnHand;
  }

  /**
   * Applies one stock movement and updates projections atomically. A
   * document locks all its pairs with lockForDocument first; a pair it did
   * not lock is locked here on its own (still correct, slower).
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
    const item = await this.stockItem(
      tx,
      tenantId,
      companyId,
      input.itemId,
      input.reversalOfId != null || RETURN_SOURCES.has(input.sourceType),
    );
    const allowNegative = await this.allowNegative(tx, companyId);
    const cost = await this.costRow(tx, tenantId, companyId, input.itemId);
    const balance = await this.balanceRow(tx, tenantId, input.warehouseId, input.itemId);
    this.assertNotBackdated(cost, input.movementDate, item.code);

    const c = costMovement(cost, {
      type: input.type,
      qty,
      unitCost: input.unitCost,
      totalCost: input.totalCost,
    });
    const newBalanceQty =
      input.type === 'IN' ? balance.qtyOnHand.plus(qty) : balance.qtyOnHand.minus(qty);

    // §9.3 negative stock.
    if (newBalanceQty.lt(0) && !allowNegative) {
      throw new DomainError(
        ErrorCode.STOCK_INSUFFICIENT,
        `Insufficient stock for ${item.code}: available ${balance.qtyOnHand.toString()}, requested ${qty.toString()}`,
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
        unitCost: c.unitCost,
        totalCost: c.totalCost,
        balanceQtyAfter: newBalanceQty,
        avgCostAfter: c.newAvg,
        reversalOfId: input.reversalOfId ?? null,
      },
      select: { id: true },
    });
    if (!c.writeOff.isZero()) {
      // ADR-018: the residue/revaluation is a zero-quantity movement, so the
      // movements alone still add up to item_costs (stock:verify).
      await tx.stockMovement.create({
        data: {
          tenantId,
          companyId,
          warehouseId: input.warehouseId,
          itemId: input.itemId,
          movementDate: input.movementDate,
          movementType: c.writeOff.gt(0) ? 'OUT' : 'IN',
          sourceType: REVALUATION_SOURCE,
          sourceId: input.sourceId ?? null,
          sourceLineId: input.sourceLineId ?? null,
          qtyIn: new Decimal(0),
          qtyOut: new Decimal(0),
          unitCost: new Decimal(0),
          totalCost: c.writeOff.abs(),
          balanceQtyAfter: newBalanceQty,
          avgCostAfter: c.newAvg,
        },
        select: { id: true },
      });
    }

    await this.saveBalance(tx, tenantId, balance, newBalanceQty, input.movementDate);
    await this.saveCost(tx, tenantId, cost, {
      totalQty: c.newTotalQty,
      totalValue: c.newTotalValue,
      avgCost: c.newAvg,
      lastMovementDate: input.movementDate,
    });

    return {
      movementId: movement.id,
      unitCost: c.unitCost,
      totalCost: c.totalCost,
      balanceQtyAfter: newBalanceQty,
      avgCostAfter: c.newAvg,
      writeOff: c.writeOff,
    };
  }

  /**
   * A transfer line: OUT of one warehouse and IN to another at the same
   * value. Company-level cost (item_costs) does not change (§9.2): the item's
   * quantity and value stay where they are, only the warehouses' balances
   * move. A reversal passes the original legs' cost and mirrors them
   * (DB-04: it used to leave at the current average and come back at the
   * original rounded cost, moving stock value with no journal entry).
   */
  async applyTransfer(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    input: TransferInput,
  ): Promise<TransferResult> {
    const { tenantId } = this.tenant();
    const qty = new Decimal(input.qty);
    if (qty.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Movement qty must be > 0');
    const item = await this.stockItem(tx, tenantId, companyId, input.itemId, input.reversalOfOutId != null);
    const allowNegative = await this.allowNegative(tx, companyId);
    const cost = await this.costRow(tx, tenantId, companyId, input.itemId);
    const from = await this.balanceRow(tx, tenantId, input.fromWarehouseId, input.itemId);
    const to = await this.balanceRow(tx, tenantId, input.toWarehouseId, input.itemId);
    this.assertNotBackdated(cost, input.movementDate, item.code);

    let totalCost: Decimal;
    let unitCost: Decimal;
    if (input.totalCost !== undefined && input.totalCost !== null) {
      totalCost = round3(input.totalCost);
      unitCost = input.unitCost != null ? round6(input.unitCost) : round6(totalCost.div(qty));
    } else {
      unitCost = cost.avgCost;
      totalCost = qty.eq(cost.totalQty) ? cost.totalValue : round3(qty.times(cost.avgCost));
    }

    const fromAfter = from.qtyOnHand.minus(qty);
    if (fromAfter.lt(0) && !allowNegative) {
      throw new DomainError(
        ErrorCode.STOCK_INSUFFICIENT,
        `Insufficient stock for ${item.code}: available ${from.qtyOnHand.toString()}, requested ${qty.toString()}`,
      );
    }
    const toAfter = to.qtyOnHand.plus(qty);
    const common = {
      tenantId,
      companyId,
      itemId: input.itemId,
      movementDate: input.movementDate,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceLineId: input.sourceLineId ?? null,
      unitCost,
      totalCost,
      avgCostAfter: cost.avgCost,
    };
    const out = await tx.stockMovement.create({
      data: {
        ...common,
        warehouseId: input.fromWarehouseId,
        movementType: 'OUT',
        qtyIn: new Decimal(0),
        qtyOut: qty,
        balanceQtyAfter: fromAfter,
        reversalOfId: input.reversalOfInId ?? null,
      },
      select: { id: true },
    });
    const inn = await tx.stockMovement.create({
      data: {
        ...common,
        warehouseId: input.toWarehouseId,
        movementType: 'IN',
        qtyIn: qty,
        qtyOut: new Decimal(0),
        balanceQtyAfter: toAfter,
        reversalOfId: input.reversalOfOutId ?? null,
      },
      select: { id: true },
    });
    await this.saveBalance(tx, tenantId, from, fromAfter, input.movementDate);
    await this.saveBalance(tx, tenantId, to, toAfter, input.movementDate);
    await this.saveCost(tx, tenantId, cost, { ...cost, lastMovementDate: input.movementDate });
    return { outMovementId: out.id, inMovementId: inn.id, unitCost, totalCost };
  }

  // ------------------------------------------------------------- internals

  /** §9.4 backdating: a stock document may not post before the item's latest movement date. */
  private assertNotBackdated(cost: CostRow, movementDate: Date, code: string) {
    if (cost.lastMovementDate && movementDate < new Date(cost.lastMovementDate.toISOString().slice(0, 10))) {
      throw new DomainError(
        ErrorCode.BACKDATED_STOCK_POSTING,
        `Cannot post on ${movementDate.toISOString().slice(0, 10)} — item ${code} has movements dated ${cost.lastMovementDate.toISOString().slice(0, 10)}`,
      );
    }
  }

  /** The item, checked to be a stocked item of the company. */
  private async stockItem(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    itemId: bigint,
    inactiveAllowed: boolean,
  ): Promise<ItemInfo> {
    const st = this.state(tx);
    if (!st.items.has(itemId)) await this.loadItems(tx, tenantId, companyId, [itemId]);
    const item = st.items.get(itemId)!;
    // An item deactivated with no stock can still be returned or have a
    // document reversed (TRADE-15); new documents refuse it when drafted.
    if (!item.isActive && !inactiveAllowed) throw DomainError.notFound('Item', itemId.toString());
    if (item.itemKind !== 'STOCK') {
      throw new DomainError(ErrorCode.VALIDATION, `Item ${item.code} is a service — it produces no stock movements`);
    }
    return item;
  }

  private async loadItems(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, itemIds: bigint[]) {
    const st = this.state(tx);
    const missing = itemIds.filter((id) => !st.items.has(id));
    if (missing.length === 0) return;
    const rows = await tx.item.findMany({
      where: { tenantId, companyId, id: { in: missing } },
      select: { id: true, code: true, itemKind: true, isActive: true },
    });
    for (const r of rows) st.items.set(r.id, { code: r.code, itemKind: r.itemKind, isActive: r.isActive });
    const absent = missing.find((id) => !st.items.has(id));
    if (absent !== undefined) throw DomainError.notFound('Item', absent.toString());
  }

  private async allowNegative(tx: Prisma.TransactionClient, companyId: bigint): Promise<boolean> {
    const st = this.state(tx);
    let allow = st.allowNegative.get(companyId);
    if (allow === undefined) {
      const company = await tx.company.findFirst({ where: { id: companyId }, select: { allowNegativeStock: true } });
      allow = company?.allowNegativeStock ?? false;
      st.allowNegative.set(companyId, allow);
    }
    return allow;
  }

  private async costRow(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, itemId: bigint) {
    const key = `${companyId}:${itemId}`;
    const st = this.state(tx);
    if (!st.costs.has(key)) await this.lockCosts(tx, tenantId, companyId, [itemId]);
    return st.costs.get(key)!;
  }

  private async balanceRow(tx: Prisma.TransactionClient, tenantId: bigint, warehouseId: bigint, itemId: bigint) {
    const key = `${warehouseId}:${itemId}`;
    const st = this.state(tx);
    if (!st.balances.has(key)) await this.lockBalances(tx, tenantId, warehouseId, [itemId]);
    return st.balances.get(key)!;
  }

  /** Create-if-missing, then SELECT … FOR UPDATE, of the item_costs rows (item_ids ascending). */
  private async lockCosts(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, itemIds: bigint[]) {
    const st = this.state(tx);
    const ids = itemIds.filter((id) => !st.costs.has(`${companyId}:${id}`)).sort(ascending);
    if (ids.length === 0) return;
    // The read first keeps the common case, existing rows, from consuming auto-increment ids.
    const existing = await tx.itemCost.findMany({
      where: { tenantId, companyId, itemId: { in: ids } },
      select: { itemId: true },
    });
    const have = new Set(existing.map((r) => r.itemId));
    const create = ids.filter((id) => !have.has(id));
    if (create.length > 0) {
      const now = new Date();
      await tx.$executeRaw`
        INSERT INTO item_costs (tenant_id, company_id, item_id, updated_at)
        VALUES ${Prisma.join(create.map((id) => Prisma.sql`(${tenantId}, ${companyId}, ${id}, ${now})`))}
        ON DUPLICATE KEY UPDATE id = id
      `;
    }
    const rows = await tx.$queryRaw<
      { id: bigint; item_id: bigint; total_qty: unknown; total_value: unknown; avg_cost: unknown; last_movement_date: Date | null }[]
    >`
      SELECT id, item_id, total_qty, total_value, avg_cost, last_movement_date
        FROM item_costs
       WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND item_id IN (${Prisma.join(ids)})
       ORDER BY item_id
         FOR UPDATE
    `;
    for (const r of rows) {
      st.costs.set(`${companyId}:${BigInt(r.item_id)}`, {
        id: BigInt(r.id),
        totalQty: new Decimal(String(r.total_qty ?? 0)),
        totalValue: new Decimal(String(r.total_value ?? 0)),
        avgCost: new Decimal(String(r.avg_cost ?? 0)),
        lastMovementDate: r.last_movement_date,
      });
    }
    if (ids.some((id) => !st.costs.has(`${companyId}:${id}`))) {
      throw new DomainError(ErrorCode.INTERNAL, 'Stock projection row missing after lock');
    }
  }

  /** Create-if-missing, then SELECT … FOR UPDATE, of one warehouse's stock_balances rows. */
  private async lockBalances(tx: Prisma.TransactionClient, tenantId: bigint, warehouseId: bigint, itemIds: bigint[]) {
    const st = this.state(tx);
    const ids = itemIds.filter((id) => !st.balances.has(`${warehouseId}:${id}`)).sort(ascending);
    if (ids.length === 0) return;
    const existing = await tx.stockBalance.findMany({
      where: { tenantId, warehouseId, itemId: { in: ids } },
      select: { itemId: true },
    });
    const have = new Set(existing.map((r) => r.itemId));
    const create = ids.filter((id) => !have.has(id));
    if (create.length > 0) {
      const now = new Date();
      await tx.$executeRaw`
        INSERT INTO stock_balances (tenant_id, warehouse_id, item_id, updated_at)
        VALUES ${Prisma.join(create.map((id) => Prisma.sql`(${tenantId}, ${warehouseId}, ${id}, ${now})`))}
        ON DUPLICATE KEY UPDATE id = id
      `;
    }
    const rows = await tx.$queryRaw<{ id: bigint; item_id: bigint; qty_on_hand: unknown }[]>`
      SELECT id, item_id, qty_on_hand
        FROM stock_balances
       WHERE tenant_id = ${tenantId} AND warehouse_id = ${warehouseId} AND item_id IN (${Prisma.join(ids)})
       ORDER BY item_id
         FOR UPDATE
    `;
    for (const r of rows) {
      st.balances.set(`${warehouseId}:${BigInt(r.item_id)}`, {
        id: BigInt(r.id),
        qtyOnHand: new Decimal(String(r.qty_on_hand ?? 0)),
      });
    }
    if (ids.some((id) => !st.balances.has(`${warehouseId}:${id}`))) {
      throw new DomainError(ErrorCode.INTERNAL, 'Stock projection row missing after lock');
    }
  }

  // updateMany, not update: the projection row may have been inserted by a
  // posting that committed after this transaction's snapshot (first movement
  // race). The locking read sees it, but `update` reads it back through the
  // snapshot and fails with "record not found"; a plain UPDATE works on the
  // latest committed row, like FOR UPDATE.
  private async saveBalance(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    row: BalanceRow,
    qtyOnHand: Decimal,
    lastMovementDate: Date,
  ) {
    const updated = await tx.stockBalance.updateMany({
      where: { tenantId, id: row.id },
      data: { qtyOnHand, lastMovementDate },
    });
    if (updated.count !== 1) throw new DomainError(ErrorCode.INTERNAL, 'Stock projection row missing after lock');
    row.qtyOnHand = qtyOnHand;
  }

  private async saveCost(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    row: CostRow,
    next: CostState & { lastMovementDate: Date },
  ) {
    const updated = await tx.itemCost.updateMany({
      where: { tenantId, id: row.id },
      data: {
        totalQty: next.totalQty,
        totalValue: next.totalValue,
        avgCost: next.avgCost,
        lastMovementDate: next.lastMovementDate,
      },
    });
    if (updated.count !== 1) throw new DomainError(ErrorCode.INTERNAL, 'Stock projection row missing after lock');
    row.totalQty = next.totalQty;
    row.totalValue = next.totalValue;
    row.avgCost = next.avgCost;
    row.lastMovementDate = next.lastMovementDate;
  }

  // ---------------------------------------------------------- stock:verify

  /**
   * stock:verify (§9.1, TRADE-20 / DB-11): the projections against the
   * movements, and the stock value against the GL, aggregated in SQL (one row
   * per item, never every movement):
   *  - QTY: stock_balances.qty_on_hand = Σ(qty_in − qty_out) per (warehouse, item);
   *  - COST_QTY / COST_VALUE: item_costs.total_qty / total_value = Σ movements
   *    per (company, item), value = Σ IN total_cost − Σ OUT total_cost;
   *  - GL_INVENTORY: Σ item_costs.total_value of the company = balance of its
   *    INVENTORY mapped account (posted journal lines, debit − credit).
   */
  async verify(): Promise<VerifyResult> {
    const { tenantId, db } = this.tenant();
    // One REPEATABLE READ snapshot for every check: a posting committing
    // between the stock value read and the GL read would otherwise show as a
    // false GL_INVENTORY difference. Reads only.
    return db.$transaction((tx) => this.verifyOn(tx, tenantId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
      maxWait: 10_000,
    });
  }

  private async verifyOn(tx: Prisma.TransactionClient, tenantId: bigint): Promise<VerifyResult> {
    const mismatches: VerifyMismatch[] = [];

    const [{ pairs }] = await tx.$queryRaw<{ pairs: bigint }[]>`
      SELECT COUNT(*) AS pairs FROM (
        SELECT 1 FROM stock_movements WHERE tenant_id = ${tenantId} GROUP BY warehouse_id, item_id
      ) p`;

    const qtyRows = await tx.$queryRaw<{ warehouse_id: bigint; item_id: bigint; expected: unknown; actual: unknown }[]>`
      SELECT b.warehouse_id, b.item_id, COALESCE(m.q, 0) AS expected, b.qty_on_hand AS actual
        FROM stock_balances b
        LEFT JOIN (
          SELECT warehouse_id, item_id, SUM(qty_in) - SUM(qty_out) AS q
            FROM stock_movements WHERE tenant_id = ${tenantId}
           GROUP BY warehouse_id, item_id
        ) m ON m.warehouse_id = b.warehouse_id AND m.item_id = b.item_id
       WHERE b.tenant_id = ${tenantId} AND b.qty_on_hand <> COALESCE(m.q, 0)
      UNION ALL
      SELECT m.warehouse_id, m.item_id, m.q AS expected, 0 AS actual
        FROM (
          SELECT warehouse_id, item_id, SUM(qty_in) - SUM(qty_out) AS q
            FROM stock_movements WHERE tenant_id = ${tenantId}
           GROUP BY warehouse_id, item_id
        ) m
        LEFT JOIN stock_balances b
          ON b.tenant_id = ${tenantId} AND b.warehouse_id = m.warehouse_id AND b.item_id = m.item_id
       WHERE b.id IS NULL AND m.q <> 0`;
    for (const r of qtyRows) {
      mismatches.push({
        kind: 'QTY',
        warehouseId: String(r.warehouse_id),
        itemId: String(r.item_id),
        expected: new Decimal(String(r.expected)).toString(),
        actual: new Decimal(String(r.actual)).toString(),
      });
    }

    const costRows = await tx.$queryRaw<
      { company_id: bigint; item_id: bigint; total_qty: unknown; total_value: unknown; q: unknown; v: unknown }[]
    >`
      SELECT c.company_id, c.item_id, c.total_qty, c.total_value, COALESCE(m.q, 0) AS q, COALESCE(m.v, 0) AS v
        FROM item_costs c
        LEFT JOIN (
          SELECT company_id, item_id, SUM(qty_in) - SUM(qty_out) AS q,
                 SUM(CASE WHEN movement_type = 'IN' THEN total_cost ELSE -total_cost END) AS v
            FROM stock_movements WHERE tenant_id = ${tenantId}
           GROUP BY company_id, item_id
        ) m ON m.company_id = c.company_id AND m.item_id = c.item_id
       WHERE c.tenant_id = ${tenantId}
         AND (c.total_qty <> COALESCE(m.q, 0) OR c.total_value <> COALESCE(m.v, 0))
      UNION ALL
      SELECT m.company_id, m.item_id, 0, 0, m.q, m.v
        FROM (
          SELECT company_id, item_id, SUM(qty_in) - SUM(qty_out) AS q,
                 SUM(CASE WHEN movement_type = 'IN' THEN total_cost ELSE -total_cost END) AS v
            FROM stock_movements WHERE tenant_id = ${tenantId}
           GROUP BY company_id, item_id
        ) m
        LEFT JOIN item_costs c
          ON c.tenant_id = ${tenantId} AND c.company_id = m.company_id AND c.item_id = m.item_id
       WHERE c.id IS NULL AND (m.q <> 0 OR m.v <> 0)`;
    for (const r of costRows) {
      const base = { companyId: String(r.company_id), itemId: String(r.item_id) };
      const [q, v, tq, tv] = [r.q, r.v, r.total_qty, r.total_value].map((x) => new Decimal(String(x)));
      if (!q.eq(tq)) mismatches.push({ kind: 'COST_QTY', ...base, expected: q.toString(), actual: tq.toString() });
      if (!v.eq(tv)) mismatches.push({ kind: 'COST_VALUE', ...base, expected: v.toString(), actual: tv.toString() });
    }

    // GL: the company in context (the one ReportsService reads).
    const company = await tx.company.findFirst({ where: { isActive: true }, orderBy: { id: 'asc' }, select: { id: true } });
    let stockValue = new Decimal(0);
    let inventoryAccountBalance: Decimal | null = null;
    if (company) {
      const [{ v }] = await tx.$queryRaw<{ v: unknown }[]>`
        SELECT COALESCE(SUM(total_value), 0) AS v FROM item_costs
         WHERE tenant_id = ${tenantId} AND company_id = ${company.id}`;
      stockValue = new Decimal(String(v));
      const mapping = await tx.accountMapping.findFirst({
        where: { companyId: company.id, mappingKey: 'INVENTORY' },
        select: { accountId: true },
      });
      if (mapping?.accountId) {
        // Read-only, on this snapshot: the same posted lines ReportsService
        // .accountTotals adds up (posted entries of the company, every date).
        const [gl] = await tx.$queryRaw<{ v: unknown }[]>`
          SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
            FROM journal_lines jl
            JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
           WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${mapping.accountId}
             AND je.company_id = ${company.id} AND je.status = 'POSTED'`;
        inventoryAccountBalance = new Decimal(String(gl.v));
        if (!inventoryAccountBalance.eq(stockValue)) {
          const account = await tx.account.findFirst({ where: { id: mapping.accountId }, select: { code: true } });
          mismatches.push({
            kind: 'GL_INVENTORY',
            companyId: company.id.toString(),
            accountCode: account?.code ?? null,
            expected: stockValue.toString(),
            actual: inventoryAccountBalance.toString(),
          });
        }
      }
    }

    return {
      checked: Number(pairs),
      mismatches,
      stockValue: round3(stockValue).toString(),
      inventoryAccountBalance: inventoryAccountBalance ? round3(inventoryAccountBalance).toString() : null,
    };
  }
}
