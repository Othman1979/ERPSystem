import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import { StockLedgerService } from './stock-ledger.service.js';
import type { CreateStockCountDto, UpdateCountLineDto } from './dto/inventory.dto.js';

/**
 * Physical stock counts (§7.4): capture system vs counted quantities,
 * then on approval generate a COUNT_ADJUSTMENT stock document which posts
 * movements + journal through AdjustmentsService — one code path, one
 * set of rules.
 */
@Injectable()
export class CountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly adjustments: AdjustmentsService,
    private readonly audit: AuditService,
  ) {}

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

  async list(status?: string) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.stockCount.findMany({
      where: { companyId, ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}) },
      include: {
        warehouse: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ countDate: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  }

  async get(id: bigint) {
    const { db } = this.tenant();
    const count = await db.stockCount.findFirst({
      where: { id },
      include: {
        warehouse: true,
        lines: {
          orderBy: { itemId: 'asc' },
          include: { item: { select: { id: true, code: true, nameAr: true, baseUnitId: true } } },
        },
      },
    });
    if (!count) throw DomainError.notFound('StockCount', id.toString());
    return count;
  }

  /**
   * Creates a DRAFT count. Lines are snapshotted with the CURRENT system
   * qty per item; countedQty stays null until entered via updateLine.
   * When `lines` is omitted, every item with a balance row in the
   * warehouse is captured.
   */
  async create(dto: CreateStockCountDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);

    const warehouse = await db.warehouse.findFirst({
      where: { id: BigInt(dto.warehouseId), companyId, isActive: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);

    let itemIds: bigint[];
    if (dto.lines?.length) {
      const requested = dto.lines.map((l) => BigInt(l.itemId));
      const items = await db.item.findMany({
        where: { tenantId, companyId, id: { in: requested }, itemKind: 'STOCK', isActive: true },
        select: { id: true },
      });
      if (items.length !== new Set(requested).size) {
        throw new DomainError(ErrorCode.VALIDATION, 'One or more items are invalid for counting');
      }
      for (const l of dto.lines) {
        if (new Decimal(l.countedQty).lt(0)) {
          throw new DomainError(ErrorCode.VALIDATION, 'countedQty cannot be negative');
        }
      }
      itemIds = [...new Set(requested.map((id) => id))];
    } else {
      const balances = await db.stockBalance.findMany({
        where: { tenantId, warehouseId: warehouse.id, qtyOnHand: { not: 0 } },
        select: { itemId: true },
      });
      const stocked = await db.item.findMany({
        where: {
          tenantId,
          companyId,
          itemKind: 'STOCK',
          isActive: true,
          id: { in: balances.map((b) => b.itemId) },
        },
        select: { id: true },
      });
      itemIds = stocked.map((i) => i.id);
    }

    const systemRows = await db.stockBalance.findMany({
      where: { tenantId, warehouseId: warehouse.id, itemId: { in: itemIds } },
      select: { itemId: true, qtyOnHand: true },
    });
    const systemByItem = new Map(systemRows.map((r) => [r.itemId, r.qtyOnHand]));

    const countDate = new Date(dto.countDate);
    const count = await db.$transaction(async (tx) => {
      const created = await tx.stockCount.create({
        data: {
          tenantId,
          companyId,
          warehouseId: warehouse.id,
          countDate,
          description: dto.description ?? null,
        },
      });
      const countedByItem = new Map(
        (dto.lines ?? []).map((l) => [BigInt(l.itemId), l.countedQty]),
      );
      await tx.stockCountLine.createMany({
        data: itemIds.map((itemId) => {
          const sysQty = systemByItem.get(itemId) ?? new Decimal(0);
          const counted = countedByItem.get(itemId);
          return {
            tenantId,
            countId: created.id,
            itemId,
            systemQty: sysQty.toString(),
            countedQty: counted ?? null,
            differenceQty:
              counted !== undefined
                ? new Decimal(counted).minus(sysQty).toString()
                : null,
          };
        }),
      });
      return created;
    });

    await this.audit.log({
      action: 'stock_count.create',
      entityType: 'stock_count',
      entityId: count.id,
      after: { warehouseId: warehouse.id.toString(), lines: itemIds.length },
    });
    return this.get(count.id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.tenant();
    const count = await db.stockCount.findFirst({ where: { id } });
    if (!count) throw DomainError.notFound('StockCount', id.toString());
    if (count.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft counts can be deleted');
    }
    await db.stockCount.delete({ where: { id } });
    return { deleted: true };
  }

  /** Enters/updates the physical count for one line. */
  async updateLine(countId: bigint, lineId: bigint, dto: UpdateCountLineDto) {
    const { db } = this.tenant();
    const count = await db.stockCount.findFirst({ where: { id: countId } });
    if (!count) throw DomainError.notFound('StockCount', countId.toString());
    if (count.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Count is already posted');
    }
    const qty = new Decimal(dto.countedQty);
    if (qty.lt(0)) {
      throw new DomainError(ErrorCode.VALIDATION, 'countedQty cannot be negative');
    }
    const line = await db.stockCountLine.findFirst({
      where: { id: lineId, countId },
    });
    if (!line) throw DomainError.notFound('StockCountLine', lineId.toString());
    const difference = qty.minus(new Decimal(line.systemQty.toString()));
    return db.stockCountLine.update({
      where: { id: lineId },
      data: { countedQty: qty, differenceQty: difference },
    });
  }

  /**
   * Approves the count: every line must have a countedQty. Generates a
   * COUNT_ADJUSTMENT document for the differences and posts it through
   * AdjustmentsService (movements + journal in one tx).
   */
  async approve(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);

    const count = await db.stockCount.findFirst({
      where: { id },
      include: { lines: true },
    });
    if (!count) throw DomainError.notFound('StockCount', id.toString());
    if (count.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Count is not a draft');
    }
    if (count.lines.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION, 'Count has no lines');
    }
    const missing = count.lines.filter((l) => l.countedQty === null);
    if (missing.length > 0) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        `${missing.length} line(s) have no counted quantity`,
      );
    }

    // Current average cost for IN-side (surplus) lines — OUT lines cost at
    // posting time from the ledger anyway.
    const costs = await db.itemCost.findMany({
      where: { tenantId, companyId, itemId: { in: count.lines.map((l) => l.itemId) } },
      select: { itemId: true, avgCost: true },
    });
    const avgByItem = new Map(costs.map((c) => [c.itemId, c.avgCost]));

    const adjLines = count.lines
      .map((l) => {
        const diff = new Decimal(l.differenceQty?.toString() ?? '0');
        if (diff.isZero()) return null;
        return {
          itemId: l.itemId,
          diff,
          unitCost: diff.gt(0) ? avgByItem.get(l.itemId)?.toString() : undefined,
        };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);

    if (adjLines.length === 0) {
      // Nothing differs — close the count without an adjustment.
      await db.stockCount.update({
        where: { id: count.id },
        data: { status: 'POSTED', postedAt: new Date(), description: count.description },
      });
      return this.get(count.id);
    }

    // Split surplus/shortage into qtyIn/qtyOut via a COUNT_ADJUSTMENT doc.
    // AdjustmentsService.create rejects COUNT_ADJUSTMENT from the API, so
    // build the document rows directly, then post via adjustments.post().
    const adjustment = await db.$transaction(async (tx) => {
      // Claim the count under a row lock: a second approval arriving at the
      // same time sees the claim and stops, instead of creating (and posting)
      // a second adjustment for the same count.
      const [locked] = (await tx.$queryRaw`
        SELECT status, adjustment_id FROM stock_counts
         WHERE tenant_id = ${tenantId} AND id = ${count.id} FOR UPDATE`) as {
        status: string;
        adjustment_id: bigint | null;
      }[];
      if (!locked || locked.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.CONFLICT, 'Count is not a draft');
      }
      if (locked.adjustment_id !== null) {
        // A previous approval created the adjustment but did not finish posting:
        // resume with that one rather than adding another.
        const existing = await tx.stockAdjustment.findFirst({ where: { id: locked.adjustment_id } });
        if (existing?.status === 'DRAFT') return existing;
        throw new DomainError(ErrorCode.CONFLICT, 'Count is already being approved');
      }
      const created = await tx.stockAdjustment.create({
        data: {
          tenantId,
          companyId,
          warehouseId: count.warehouseId,
          adjustmentDate: count.countDate,
          adjustmentType: 'COUNT_ADJUSTMENT',
          description: `Stock count ${count.id}`,
        },
      });
      await tx.stockAdjustmentLine.createMany({
        data: adjLines.map((l, i) => {
          const isIn = l.diff.gt(0);
          return {
            tenantId,
            adjustmentId: created.id,
            lineNo: i + 1,
            itemId: l.itemId,
            qtyIn: isIn ? l.diff.abs().toString() : '0',
            qtyOut: isIn ? '0' : l.diff.abs().toString(),
            unitCost: isIn ? (l.unitCost ?? null) : null,
          };
        }),
      });
      await tx.stockCount.update({ where: { id: count.id }, data: { adjustmentId: created.id } });
      return created;
    });

    const posted = await this.adjustments.post(adjustment.id);
    await db.stockCount.update({
      where: { id: count.id },
      data: {
        status: 'POSTED',
        adjustmentId: adjustment.id,
        docNo: posted.docNo ?? null,
        postedAt: new Date(),
      },
    });

    await this.audit.log({
      action: 'stock_count.approve',
      entityType: 'stock_count',
      entityId: count.id,
      after: { adjustmentId: adjustment.id.toString(), docNo: posted.docNo },
    });
    return this.get(count.id);
  }
}
