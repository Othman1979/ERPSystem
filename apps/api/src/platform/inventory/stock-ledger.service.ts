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
  /** Opening stock (or its reversal): the item ledger's opening position (ADR-007). */
  isOpening?: boolean;
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

/**
 * StockLedgerService — the ONLY place stock movements are created and the
 * qty/cost projections (stock_balances, item_costs) are updated
 * (docs/BUILD_PLAN.md §9.1). Weighted-average costing per §9.2.
 * All methods run inside the caller's interactive transaction.
 */
@Injectable()
export class StockLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  /** Applies one stock movement and updates projections atomically. */
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
        isOpening: input.isOpening ?? false,
      },
    });

    await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        qtyOnHand: newBalanceQty,
        lastMovementDate: input.movementDate,
      },
    });

    await tx.itemCost.update({
      where: { id: cost.id },
      data: {
        totalQty: newTotalQty,
        totalValue: newTotalValue,
        avgCost: newAvg,
        lastMovementDate: input.movementDate,
      },
    });

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

  /** Fetch-or-create + SELECT … FOR UPDATE on item_costs. */
  private async lockCost(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    itemId: bigint,
  ): Promise<CostRow> {
    const existing = await tx.itemCost.findFirst({
      where: { tenantId, companyId, itemId },
      select: { id: true },
    });
    if (!existing) {
      await tx.itemCost.create({
        data: { tenantId, companyId, itemId },
      });
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

  /** Fetch-or-create + SELECT … FOR UPDATE on stock_balances. */
  private async lockBalance(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    warehouseId: bigint,
    itemId: bigint,
  ): Promise<BalanceRow> {
    const existing = await tx.stockBalance.findFirst({
      where: { tenantId, warehouseId, itemId },
      select: { id: true },
    });
    if (!existing) {
      await tx.stockBalance.create({ data: { tenantId, warehouseId, itemId } });
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
