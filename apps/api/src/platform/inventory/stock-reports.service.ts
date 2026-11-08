import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';

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

  /** On-hand quantities per warehouse/item, enriched with item + warehouse. */
  async balances(query?: { warehouseId?: string; itemId?: string; lowStock?: string }) {
    const { db } = this.tenant();
    const rows = await db.stockBalance.findMany({
      where: {
        ...(query?.warehouseId ? { warehouseId: BigInt(query.warehouseId) } : {}),
        ...(query?.itemId ? { itemId: BigInt(query.itemId) } : {}),
      },
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
      take: 1000,
    });
    let filtered = rows;
    if (query?.lowStock === 'true') {
      filtered = rows.filter((r) =>
        new Decimal(r.qtyOnHand.toString()).lt(r.item.minStock.toString()),
      );
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

    const where = {
      itemId: BigInt(itemId),
      ...(query?.warehouseId ? { warehouseId: BigInt(query.warehouseId) } : {}),
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
    const [rows, balances] = await Promise.all([
      db.stockMovement.findMany({
        where,
        include: {
          warehouse: { select: { id: true, code: true, nameAr: true } },
        },
        orderBy: [{ movementDate: 'asc' }, { id: 'asc' }],
        take: 2000,
      }),
      db.stockBalance.findMany({
        where: { itemId: BigInt(itemId), qtyOnHand: { not: 0 } },
        include: { warehouse: { select: { id: true, code: true, nameAr: true } } },
      }),
    ]);

    let qtyIn = new Decimal(0);
    let qtyOut = new Decimal(0);
    const mapped = rows.map((m) => {
      qtyIn = qtyIn.plus(m.qtyIn.toString());
      qtyOut = qtyOut.plus(m.qtyOut.toString());
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
      rows: mapped,
      totals: {
        qtyIn: qtyIn.toString(),
        qtyOut: qtyOut.toString(),
      },
      balances: balances.map((b) => ({
        warehouse: b.warehouse,
        qtyOnHand: b.qtyOnHand.toString(),
      })),
    };
  }

  /** Inventory valuation at weighted-average cost. */
  async valuation(warehouseId?: string) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const [costs, balances] = await Promise.all([
      db.itemCost.findMany({
        where: { companyId },
        include: { item: { select: { id: true, code: true, nameAr: true } } },
      }),
      db.stockBalance.findMany({
        where: {
          ...(warehouseId ? { warehouseId: BigInt(warehouseId) } : {}),
          qtyOnHand: { not: 0 },
        },
        select: { itemId: true, qtyOnHand: true },
      }),
    ]);
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
          qty: qty.toString(),
          avgCost: c.avgCost.toString(),
          value: value.toFixed(3),
        };
      })
      .filter((r) => new Decimal(r.qty).gt(0) || new Decimal(r.value).gt(0));
    return {
      rows,
      totalValue: rows.reduce((s, r) => s.plus(r.value), new Decimal(0)).toFixed(3),
    };
  }
}
