import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EXPORT_LIMITS } from '../printing/printing.service.js';

const ADJUSTMENT_SOURCE = 'STOCK_ADJUSTMENT';
const TRANSFER_SOURCE = 'STOCK_TRANSFER';

/** A report the JSON endpoint will not answer in one piece: the rows it would have and the cap. */
function tooLarge(rows: number): DomainError {
  return new DomainError(
    ErrorCode.REPORT_TOO_LARGE,
    `The report has ${rows} rows; at most ${EXPORT_LIMITS.xlsx} are returned. Narrow the filters.`,
    { rows, limit: EXPORT_LIMITS.xlsx },
  );
}

/**
 * Stock reports (§9.6): on-hand balances, movement ledger, valuation.
 * All tenant-scoped reads.
 */
@Injectable()
export class StockReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: ReturnType<PrismaService['forTenant']>): Promise<bigint> {
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  /**
   * Movement filters for a period with opening balances (ADR-008): the
   * opening part is everything before `from` plus the movements of OPENING
   * stock adjustments (and their reversals) dated in the period; the period
   * part is the rest of the period.
   */
  private async periodWhere(
    db: ReturnType<PrismaService['forTenant']>,
    range: { from?: string; to?: string },
  ) {
    const openingDocs = await db.stockAdjustment.findMany({
      where: { adjustmentType: 'OPENING' },
      select: { id: true },
    });
    const fromOpeningDoc = { sourceType: ADJUSTMENT_SOURCE, sourceId: { in: openingDocs.map((a) => a.id) } };
    const inRange = {
      ...(range.from || range.to
        ? {
            movementDate: {
              ...(range.from ? { gte: new Date(range.from) } : {}),
              ...(range.to ? { lte: new Date(range.to) } : {}),
            },
          }
        : {}),
    };
    const openingInRange = { AND: [fromOpeningDoc, inRange] };
    return {
      opening: range.from
        ? { OR: [{ movementDate: { lt: new Date(range.from) } }, openingInRange] }
        : openingInRange,
      period: { AND: [inRange, { NOT: fromOpeningDoc }] },
    };
  }

  /**
   * Items balance (ميزان المواد): per item the opening quantity and value,
   * the period's ins and outs, and the closing quantity and value. Company
   * wide, transfers between warehouses are left out (they move nothing in or
   * out of the company); with a warehouse they count as its ins and outs.
   */
  async itemBalances(query: { warehouseId?: string; from?: string; to?: string }) {
    const { db } = this.tenant();
    const parts = await this.periodWhere(db, query);
    const scope = query.warehouseId
      ? { warehouseId: BigInt(query.warehouseId) }
      : { NOT: { sourceType: TRANSFER_SOURCE } };
    const sums = (part: object) =>
      db.stockMovement.groupBy({
        by: ['itemId', 'movementType'],
        where: { AND: [scope, part] },
        _sum: { qtyIn: true, qtyOut: true, totalCost: true },
      });
    const [opening, period] = await Promise.all([sums(parts.opening), sums(parts.period)]);

    const zero = () => ({
      openingQty: new Decimal(0),
      openingValue: new Decimal(0),
      inQty: new Decimal(0),
      inValue: new Decimal(0),
      outQty: new Decimal(0),
      outValue: new Decimal(0),
    });
    const byItem = new Map<bigint, ReturnType<typeof zero>>();
    const acc = (itemId: bigint) => {
      let a = byItem.get(itemId);
      if (!a) byItem.set(itemId, (a = zero()));
      return a;
    };
    for (const g of opening) {
      const a = acc(g.itemId);
      const cost = new Decimal(g._sum.totalCost?.toString() ?? 0);
      a.openingQty = a.openingQty.plus(g._sum.qtyIn?.toString() ?? 0).minus(g._sum.qtyOut?.toString() ?? 0);
      a.openingValue = g.movementType === 'IN' ? a.openingValue.plus(cost) : a.openingValue.minus(cost);
    }
    for (const g of period) {
      const a = acc(g.itemId);
      const cost = new Decimal(g._sum.totalCost?.toString() ?? 0);
      if (g.movementType === 'IN') {
        a.inQty = a.inQty.plus(g._sum.qtyIn?.toString() ?? 0);
        a.inValue = a.inValue.plus(cost);
      } else {
        a.outQty = a.outQty.plus(g._sum.qtyOut?.toString() ?? 0);
        a.outValue = a.outValue.plus(cost);
      }
    }
    if (byItem.size > EXPORT_LIMITS.xlsx) throw tooLarge(byItem.size);

    const items = await db.item.findMany({
      where: { id: { in: [...byItem.keys()] } },
      select: { id: true, code: true, nameAr: true, nameEn: true, baseUnit: { select: { code: true, nameAr: true } } },
    });
    const rows = items
      .map((item) => {
        const a = byItem.get(item.id)!;
        const closingQty = a.openingQty.plus(a.inQty).minus(a.outQty);
        const closingValue = a.openingValue.plus(a.inValue).minus(a.outValue);
        return {
          itemId: item.id.toString(),
          code: item.code,
          nameAr: item.nameAr,
          nameEn: item.nameEn,
          unit: item.baseUnit,
          openingQty: a.openingQty.toString(),
          openingValue: a.openingValue.toFixed(3),
          inQty: a.inQty.toString(),
          inValue: a.inValue.toFixed(3),
          outQty: a.outQty.toString(),
          outValue: a.outValue.toFixed(3),
          closingQty: closingQty.toString(),
          closingValue: closingValue.toFixed(3),
        };
      })
      .filter((r) =>
        [r.openingQty, r.openingValue, r.inQty, r.outQty, r.closingValue].some((v) => !new Decimal(v).isZero()),
      )
      .sort((x, y) => x.code.localeCompare(y.code));

    const total = (key: 'openingValue' | 'inValue' | 'outValue' | 'closingValue') =>
      rows.reduce((s, r) => s.plus(r[key]), new Decimal(0)).toFixed(3);
    return {
      rows,
      totals: {
        openingValue: total('openingValue'),
        inValue: total('inValue'),
        outValue: total('outValue'),
        closingValue: total('closingValue'),
      },
    };
  }

  /**
   * On-hand quantities per warehouse/item, enriched with item + warehouse.
   * Every matching row is returned (no silent cap): above the export row
   * limit the answer is REPORT_TOO_LARGE. `lowStock=true` keeps the rows of
   * items whose total over ALL warehouses is below their minimum stock.
   */
  async balances(query?: { warehouseId?: string; itemId?: string; lowStock?: string }) {
    const { db } = this.tenant();
    const where = {
      ...(query?.warehouseId ? { warehouseId: BigInt(query.warehouseId) } : {}),
      ...(query?.itemId ? { itemId: BigInt(query.itemId) } : {}),
    };
    const count = await db.stockBalance.count({ where });
    if (count > EXPORT_LIMITS.xlsx) throw tooLarge(count);
    const rows = await db.stockBalance.findMany({
      where,
      include: {
        warehouse: { select: { id: true, code: true, nameAr: true } },
        item: {
          select: {
            id: true,
            code: true,
            nameAr: true,
            minStock: true,
            baseUnit: { select: { code: true, nameAr: true } },
          },
        },
      },
      orderBy: [{ warehouseId: 'asc' }, { itemId: 'asc' }],
    });
    let filtered = rows;
    if (query?.lowStock === 'true') {
      const totals = await this.totalQtyByItem(db, [...new Set(rows.map((r) => r.itemId))]);
      filtered = rows.filter((r) => (totals.get(r.itemId) ?? new Decimal(0)).lt(r.item.minStock.toString()));
    }
    return filtered.map((r) => ({
      warehouseId: r.warehouseId.toString(),
      warehouseCode: r.warehouse.code,
      warehouseName: r.warehouse.nameAr,
      itemId: r.itemId.toString(),
      itemCode: r.item.code,
      itemName: r.item.nameAr,
      unit: r.item.baseUnit.code,
      qtyOnHand: r.qtyOnHand.toString(),
      minStock: r.item.minStock.toString(),
      lastMovementDate: r.lastMovementDate,
    }));
  }

  /** On-hand quantity per item summed over every warehouse. */
  private async totalQtyByItem(db: ReturnType<PrismaService['forTenant']>, itemIds: bigint[]) {
    if (itemIds.length === 0) return new Map<bigint, Decimal>();
    const sums = await db.stockBalance.groupBy({
      by: ['itemId'],
      where: { itemId: { in: itemIds } },
      _sum: { qtyOnHand: true },
    });
    return new Map(sums.map((s) => [s.itemId, new Decimal(s._sum.qtyOnHand?.toString() ?? 0)]));
  }

  /**
   * Active STOCK items with a minimum (min_stock > 0) whose quantity over
   * all warehouses is below it; items that never moved count as zero.
   * `count` is all of them, `items` the first `limit`, largest shortage
   * first (dashboard, Phase 8).
   */
  async belowMinimum(limit = 10) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const items = await db.item.findMany({
      where: { companyId, isActive: true, itemKind: 'STOCK', minStock: { gt: 0 } },
      select: { id: true, code: true, nameAr: true, nameEn: true, minStock: true, baseUnit: { select: { code: true } } },
    });
    const totals = await this.totalQtyByItem(db, items.map((i) => i.id));
    const below = items
      .map((i) => {
        const qty = totals.get(i.id) ?? new Decimal(0);
        const min = new Decimal(i.minStock.toString());
        return { item: i, qty, min, shortage: min.minus(qty) };
      })
      .filter((r) => r.qty.lt(r.min))
      .sort((a, b) => b.shortage.comparedTo(a.shortage) || a.item.code.localeCompare(b.item.code));
    return {
      count: below.length,
      items: below.slice(0, limit).map((r) => ({
        itemId: r.item.id.toString(),
        code: r.item.code,
        nameAr: r.item.nameAr,
        nameEn: r.item.nameEn,
        unit: r.item.baseUnit.code,
        qtyOnHand: r.qty.toString(),
        minStock: r.min.toString(),
        shortage: r.shortage.toString(),
      })),
    };
  }

  /** Code and name of a warehouse of this company (report headers). */
  async warehouseSummary(id: string) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.warehouse.findFirst({
      where: { companyId, id: BigInt(id) },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
  }

  /** Movement ledger with filters. */
  async movements(query?: {
    warehouseId?: string;
    itemId?: string;
    sourceType?: string;
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
  }) {
    const { db } = this.tenant();
    const page = Math.max(1, Number(query?.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query?.pageSize ?? 50) || 50));
    const where = {
      ...(query?.warehouseId ? { warehouseId: BigInt(query.warehouseId) } : {}),
      ...(query?.itemId ? { itemId: BigInt(query.itemId) } : {}),
      ...(query?.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query?.from || query?.to
        ? {
            movementDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.stockMovement.findMany({
        where,
        include: {
          warehouse: { select: { code: true, nameAr: true } },
          item: { select: { code: true, nameAr: true } },
        },
        orderBy: [{ movementDate: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.stockMovement.count({ where }),
    ]);
    return {
      rows: rows.map((m) => ({
        id: m.id.toString(),
        movementDate: m.movementDate,
        warehouseCode: m.warehouse.code,
        itemCode: m.item.code,
        itemName: m.item.nameAr,
        movementType: m.movementType,
        sourceType: m.sourceType,
        sourceId: m.sourceId?.toString() ?? null,
        qtyIn: m.qtyIn.toString(),
        qtyOut: m.qtyOut.toString(),
        unitCost: m.unitCost.toString(),
        totalCost: m.totalCost.toString(),
        balanceQtyAfter: m.balanceQtyAfter.toString(),
        avgCostAfter: m.avgCostAfter.toString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Per-item movement ledger (Fawateer-style item card): ascending movements
   *  with running balance & WAC, plus totals and current balances. */
  async itemLedger(
    itemId: string,
    query?: { warehouseId?: string; sourceType?: string; from?: string; to?: string },
  ) {
    const { db } = this.tenant();
    const item = await db.item.findFirst({
      where: { id: BigInt(itemId) },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        itemKind: true,
        baseUnit: { select: { code: true, nameAr: true } },
      },
    });
    if (!item) throw DomainError.notFound('Item', itemId);

    const scope = {
      itemId: BigInt(itemId),
      ...(query?.warehouseId ? { warehouseId: BigInt(query.warehouseId) } : {}),
    };
    // Opening stock is the opening position, not a row (ADR-008).
    const parts = await this.periodWhere(db, { from: query?.from, to: query?.to });
    const where = {
      AND: [scope, query?.sourceType ? { sourceType: query.sourceType } : {}, parts.period],
    };
    const count = await db.stockMovement.count({ where });
    if (count > EXPORT_LIMITS.xlsx) throw tooLarge(count);
    const [rows, balances, before] = await Promise.all([
      db.stockMovement.findMany({
        where,
        include: {
          warehouse: { select: { id: true, code: true, nameAr: true } },
        },
        orderBy: [{ movementDate: 'asc' }, { id: 'asc' }],
      }),
      db.stockBalance.findMany({
        where: { itemId: BigInt(itemId), qtyOnHand: { not: 0 } },
        include: { warehouse: { select: { id: true, code: true, nameAr: true } } },
      }),
      // Opening position: movements of the item (warehouse filter kept)
      // before `from`, plus the period's opening stock.
      db.stockMovement.groupBy({
        by: ['movementType'],
        where: { AND: [scope, parts.opening] },
        _sum: { qtyIn: true, qtyOut: true, totalCost: true },
      }),
    ]);
    let openingQty = new Decimal(0);
    let openingValue = new Decimal(0);
    for (const g of before) {
      openingQty = openingQty.plus(g._sum.qtyIn?.toString() ?? 0).minus(g._sum.qtyOut?.toString() ?? 0);
      const cost = new Decimal(g._sum.totalCost?.toString() ?? 0);
      openingValue = g.movementType === 'IN' ? openingValue.plus(cost) : openingValue.minus(cost);
    }

    let qtyIn = new Decimal(0);
    let qtyOut = new Decimal(0);
    let valueIn = new Decimal(0);
    let valueOut = new Decimal(0);
    const mapped = rows.map((m) => {
      qtyIn = qtyIn.plus(m.qtyIn.toString());
      qtyOut = qtyOut.plus(m.qtyOut.toString());
      if (m.movementType === 'IN') valueIn = valueIn.plus(m.totalCost.toString());
      else valueOut = valueOut.plus(m.totalCost.toString());
      return {
        id: m.id.toString(),
        movementDate: m.movementDate,
        warehouse: m.warehouse,
        movementType: m.movementType,
        sourceType: m.sourceType,
        sourceId: m.sourceId?.toString() ?? null,
        qtyIn: m.qtyIn.toString(),
        qtyOut: m.qtyOut.toString(),
        unitCost: m.unitCost.toString(),
        totalCost: m.totalCost.toString(),
        balanceQtyAfter: m.balanceQtyAfter.toString(),
        avgCostAfter: m.avgCostAfter.toString(),
      };
    });

    return {
      item,
      opening: { qty: openingQty.toString(), value: openingValue.toFixed(3) },
      rows: mapped,
      totals: {
        qtyIn: qtyIn.toString(),
        qtyOut: qtyOut.toString(),
        valueIn: valueIn.toFixed(3),
        valueOut: valueOut.toFixed(3),
      },
      // Opening + the rows shown (with a sourceType filter, of those rows only).
      closing: {
        qty: openingQty.plus(qtyIn).minus(qtyOut).toString(),
        value: openingValue.plus(valueIn).minus(valueOut).toFixed(3),
      },
      balances: balances.map((b) => ({
        warehouse: b.warehouse,
        qtyOnHand: b.qtyOnHand.toString(),
      })),
    };
  }

  /**
   * Inventory valuation at weighted-average cost. Company-wide it is the
   * item_costs projection itself: each item's total_qty / total_value, and
   * the total is the sum of total_value (what the inventory account
   * carries), not the sum of round(qty x avg). For one warehouse: its
   * quantity x the item's average cost.
   */
  async valuation(warehouseId?: string) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const costs = await db.itemCost.findMany({
      where: { companyId },
      include: { item: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
      orderBy: { itemId: 'asc' },
    });
    if (!warehouseId) {
      const rows = costs
        .map((c) => ({
          itemId: c.itemId.toString(),
          code: c.item.code,
          nameAr: c.item.nameAr,
          nameEn: c.item.nameEn,
          qty: c.totalQty.toString(),
          avgCost: c.avgCost.toString(),
          value: c.totalValue.toFixed(3),
        }))
        .filter((r) => !new Decimal(r.qty).isZero() || !new Decimal(r.value).isZero());
      return {
        rows,
        totalValue: costs.reduce((acc, c) => acc.plus(c.totalValue.toString()), new Decimal(0)).toFixed(3),
      };
    }

    const balances = await db.stockBalance.findMany({
      where: { warehouseId: BigInt(warehouseId), qtyOnHand: { not: 0 } },
      select: { itemId: true, qtyOnHand: true },
    });
    const qtyByItem = new Map<string, Decimal>();
    for (const b of balances) {
      const key = b.itemId.toString();
      qtyByItem.set(key, (qtyByItem.get(key) ?? new Decimal(0)).plus(b.qtyOnHand.toString()));
    }
    const rows = costs
      .map((c) => {
        const qty = qtyByItem.get(c.itemId.toString()) ?? new Decimal(0);
        const value = qty.times(c.avgCost.toString());
        return {
          itemId: c.itemId.toString(),
          code: c.item.code,
          nameAr: c.item.nameAr,
          nameEn: c.item.nameEn,
          qty: qty.toString(),
          avgCost: c.avgCost.toString(),
          value: value.toFixed(3),
        };
      })
      .filter((r) => !new Decimal(r.qty).isZero() || !new Decimal(r.value).isZero());
    return {
      rows,
      totalValue: rows.reduce((acc, r) => acc.plus(r.value), new Decimal(0)).toFixed(3),
    };
  }
}
