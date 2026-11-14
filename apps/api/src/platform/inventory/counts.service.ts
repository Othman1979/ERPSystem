import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { branchWhere } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import { StockLedgerService } from './stock-ledger.service.js';
import type { CreateStockCountDto, UpdateCountLineDto } from './dto/inventory.dto.js';
import type { ListStockCountsQueryDto } from './dto/list-queries.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { retryOnLockConflict } from '../shared/document-support.service.js';

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

  /**
   * One numbered page of counts (ADR-022), newest first unless `sort` says
   * otherwise. A count belongs to its warehouse's branch (ADR-003 §10).
   */
  async list(query: ListStockCountsQueryDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', {
        from: query.from,
        to: query.to,
      });
    }
    const q = query.q;
    const where: Prisma.StockCountWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.warehouseId ? { warehouseId: BigInt(query.warehouseId) } : {}),
      ...(query.from || query.to
        ? {
            countDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [
        { warehouse: branchWhere() },
        q ? { OR: [{ docNo: { contains: q } }, { description: { contains: q } }] } : {},
      ],
    };
    const orderBy = orderByOf<'date' | 'docNo', Prisma.StockCountOrderByWithRelationInput>(
      query.sort,
      '-date',
      {
        date: (dir) => ({ countDate: dir }),
        docNo: (dir) => ({ docNo: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) =>
        withLineCounts(
          await tx.stockCount.findMany({
            where,
            include: {
              warehouse: { select: { id: true, code: true, nameAr: true } },
            },
            orderBy,
            ...window,
          }),
          'countId',
          // Line counts of this page only (see withLineCounts).
          (ids) => tx.stockCountLine.groupBy({ by: ['countId'], where: { countId: { in: ids } }, _count: { _all: true } }),
        ),
      count: (tx) => tx.stockCount.count({ where }),
    });
  }

  /** One count; another branch's answers 404 like another tenant's (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.tenant();
    const count = await db.stockCount.findFirst({
      where: { id, AND: [{ warehouse: branchWhere() }] },
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
    }, POSTING_TX_OPTIONS);

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
   * Re-reads the book balance of every line (the count snapshot) and its
   * difference, for a count whose balances moved since it was taken
   * (TRADE-07: approval refuses a stale snapshot).
   */
  async refresh(id: bigint) {
    const { tenantId, db } = this.tenant();
    await db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM stock_counts WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      if (!locked) throw DomainError.notFound('StockCount', id.toString());
      if (locked.status !== 'DRAFT') throw new DomainError(ErrorCode.CONFLICT, 'Count is not a draft');
      const count = await tx.stockCount.findFirst({ where: { id }, include: { lines: true } });
      const balances = await tx.stockBalance.findMany({
        where: { tenantId, warehouseId: count!.warehouseId, itemId: { in: count!.lines.map((l) => l.itemId) } },
        select: { itemId: true, qtyOnHand: true },
      });
      const onHand = new Map(balances.map((b) => [b.itemId, new Decimal(b.qtyOnHand.toString())]));
      for (const line of count!.lines) {
        const systemQty = onHand.get(line.itemId) ?? new Decimal(0);
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: {
            systemQty,
            differenceQty: line.countedQty === null ? null : new Decimal(line.countedQty.toString()).minus(systemQty),
          },
        });
      }
    }, POSTING_TX_OPTIONS);
    await this.audit.log({ action: 'stock_count.refresh', entityType: 'stock_count', entityId: id });
    return this.get(id);
  }

  /**
   * Approves the count (TRADE-07): every line must have a countedQty, and
   * every line's book balance must still be the count's snapshot — under the
   * stock locks — or the approval is refused with STOCK_COUNT_STALE (refresh,
   * then approve again). The COUNT_ADJUSTMENT for the differences, its
   * posting (movements + journal, AdjustmentsService.postLocked) and the
   * count's status commit in one transaction. The route requires an
   * Idempotency-Key.
   */
  async approve(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId');

    const result = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        // Lock the count first (§10.1 step 7): a second approval waits here,
        // then finds the count posted.
        await tx.$queryRaw`SELECT id FROM stock_counts WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const count = await tx.stockCount.findFirst({ where: { id }, include: { lines: true } });
        if (!count) throw DomainError.notFound('StockCount', id.toString());
        if (count.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Count is not a draft');
        }
        if (count.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Count has no lines');
        }
        const missing = count.lines.filter((l) => l.countedQty === null);
        if (missing.length > 0) {
          throw new DomainError(ErrorCode.VALIDATION, `${missing.length} line(s) have no counted quantity`);
        }

        await this.ledger.lockForDocument(
          tx,
          companyId,
          count.lines.map((l) => ({ itemId: l.itemId, warehouseId: count.warehouseId })),
        );
        const stale = count.lines.filter(
          (l) => !this.ledger.lockedQtyOnHand(tx, count.warehouseId, l.itemId).eq(l.systemQty.toString()),
        );
        if (stale.length > 0) {
          throw new DomainError(
            ErrorCode.STOCK_COUNT_STALE,
            `${stale.length} line(s) moved since the count was taken: refresh the count and approve again`,
            { itemIds: stale.map((l) => l.itemId.toString()) },
          );
        }

        const adjLines = count.lines
          .map((l) => ({ itemId: l.itemId, diff: new Decimal(l.countedQty!.toString()).minus(l.systemQty.toString()) }))
          .filter((l) => !l.diff.isZero());

        let adjustmentId: bigint | null = null;
        let docNo: string | null = null;
        if (adjLines.length > 0) {
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
            data: adjLines.map((l, i) => ({
              tenantId,
              adjustmentId: created.id,
              lineNo: i + 1,
              itemId: l.itemId,
              qtyIn: l.diff.gt(0) ? l.diff.toString() : '0',
              qtyOut: l.diff.gt(0) ? '0' : l.diff.abs().toString(),
              // A surplus enters at the current average cost (applyMovement's default).
              unitCost: null,
            })),
          });
          const posted = await this.adjustments.postLocked(tx, created.id, companyId, userId);
          adjustmentId = created.id;
          docNo = posted.docNo;
        }
        await tx.stockCount.update({
          where: { id: count.id },
          data: { status: 'POSTED', adjustmentId, docNo, postedAt: new Date() },
        });
        return { adjustmentId, docNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'stock_count.approve',
      entityType: 'stock_count',
      entityId: id,
      after: { adjustmentId: result.adjustmentId?.toString() ?? null, docNo: result.docNo },
    });
    return this.get(id);
  }
}
