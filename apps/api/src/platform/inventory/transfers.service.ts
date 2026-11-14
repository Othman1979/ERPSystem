import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertWarehouseBranchAllowed, branchWhere, hasAllBranches } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PostingService } from '../journal/posting.service.js';
import { StockLedgerService } from './stock-ledger.service.js';
import type { CreateStockTransferDto } from './dto/inventory.dto.js';
import type { ListStockTransfersQueryDto } from './dto/list-queries.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { retryOnLockConflict } from '../shared/document-support.service.js';

const SOURCE = 'STOCK_TRANSFER';


/**
 * Inter-warehouse transfers (§7.4, §9.2): OUT at source + IN at destination
 * at the SAME average cost — item_costs is unchanged, no journal entry.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly posting: PostingService,
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

  private userId(): bigint | undefined {
    return ClsServiceManager.getClsService<RequestContext>().get('userId');
  }

  /**
   * A transfer is visible when its source OR its destination warehouse is one
   * of the caller's branches (ADR-003 §10). No restriction for an all-branch member.
   */
  private branchScope(): Prisma.StockTransferWhereInput[] {
    if (hasAllBranches()) return [];
    return [{ OR: [{ fromWarehouse: branchWhere() }, { toWarehouse: branchWhere() }] }];
  }

  /**
   * One numbered page of transfers (ADR-022), newest first unless `sort` says
   * otherwise. `warehouseId` matches the source or the destination.
   */
  async list(query: ListStockTransfersQueryDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', {
        from: query.from,
        to: query.to,
      });
    }
    const q = query.q;
    const and: Prisma.StockTransferWhereInput[] = [...this.branchScope()];
    if (query.warehouseId) {
      const warehouseId = BigInt(query.warehouseId);
      and.push({ OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] });
    }
    if (q) and.push({ OR: [{ docNo: { contains: q } }, { description: { contains: q } }] });
    const where: Prisma.StockTransferWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            transferDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: and,
    };
    const orderBy = orderByOf<'date' | 'docNo', Prisma.StockTransferOrderByWithRelationInput>(
      query.sort,
      '-date',
      {
        date: (dir) => ({ transferDate: dir }),
        docNo: (dir) => ({ docNo: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) =>
        withLineCounts(
          await tx.stockTransfer.findMany({
            where,
            include: {
              fromWarehouse: { select: { id: true, code: true, nameAr: true } },
              toWarehouse: { select: { id: true, code: true, nameAr: true } },
            },
            orderBy,
            ...window,
          }),
          'transferId',
          // Line counts of this page only (see withLineCounts).
          (ids) =>
            tx.stockTransferLine.groupBy({ by: ['transferId'], where: { transferId: { in: ids } }, _count: { _all: true } }),
        ),
      count: (tx) => tx.stockTransfer.count({ where }),
    });
  }

  /** One transfer; a transfer between two other branches answers 404 (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.tenant();
    const t = await db.stockTransfer.findFirst({
      where: { id, AND: this.branchScope() },
      include: {
        fromWarehouse: true,
        toWarehouse: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { item: { select: { id: true, code: true, nameAr: true } } },
        },
        reversalOf: { select: { id: true, docNo: true } },
        reversals: { select: { id: true, docNo: true, status: true } },
      },
    });
    if (!t) throw DomainError.notFound('StockTransfer', id.toString());
    return t;
  }

  async create(dto: CreateStockTransferDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);

    const fromId = BigInt(dto.fromWarehouseId);
    const toId = BigInt(dto.toWarehouseId);
    if (fromId === toId) {
      throw new DomainError(ErrorCode.VALIDATION, 'Source and destination warehouses must differ');
    }
    const warehouses = await db.warehouse.findMany({
      where: { companyId, id: { in: [fromId, toId] }, isActive: true },
    });
    if (warehouses.length !== 2) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Warehouse not found or inactive');
    }

    const itemIds = dto.lines.map((l) => BigInt(l.itemId));
    const items = await db.item.findMany({
      where: { tenantId, companyId, id: { in: itemIds }, itemKind: 'STOCK', isActive: true },
      select: { id: true, code: true },
    });
    const found = new Set(items.map((i) => i.id));
    for (const l of dto.lines) {
      if (!found.has(BigInt(l.itemId))) {
        const any = await db.item.findFirst({
          where: { tenantId, companyId, id: BigInt(l.itemId) },
          select: { code: true, itemKind: true },
        });
        if (!any) throw DomainError.notFound('Item', l.itemId);
        throw new DomainError(
          ErrorCode.VALIDATION,
          any.itemKind !== 'STOCK'
            ? `Item ${any.code} is a service — no stock transfer allowed`
            : `Item ${any.code} is inactive`,
        );
      }
      if (new Decimal(l.qty).lte(0)) {
        throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
      }
    }

    const transfer = await db.$transaction(async (tx) => {
      const created = await tx.stockTransfer.create({
        data: {
          tenantId,
          companyId,
          transferDate: new Date(dto.transferDate),
          fromWarehouseId: fromId,
          toWarehouseId: toId,
          description: dto.description ?? null,
        },
      });
      await tx.stockTransferLine.createMany({
        data: dto.lines.map((l, i) => ({
          tenantId,
          transferId: created.id,
          lineNo: i + 1,
          itemId: BigInt(l.itemId),
          qty: l.qty,
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);

    await this.audit.log({
      action: 'stock_transfer.create',
      entityType: 'stock_transfer',
      entityId: transfer.id,
      after: { from: fromId.toString(), to: toId.toString() },
    });
    return this.get(transfer.id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.tenant();
    const t = await db.stockTransfer.findFirst({ where: { id } });
    if (!t) throw DomainError.notFound('StockTransfer', id.toString());
    if (t.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft transfers can be deleted');
    }
    await db.stockTransfer.delete({ where: { id } });
    return { deleted: true };
  }

  async post(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();

    const result = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        // Lock the document first (§10.1 step 7). As the first statement it also
        // makes every later read see the latest committed state, so two
        // concurrent requests cannot both post or reverse it.
        await tx.$queryRaw`SELECT id FROM stock_transfers WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const draft = await tx.stockTransfer.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('StockTransfer', id.toString());
        await assertWarehouseBranchAllowed(tx, draft.fromWarehouseId);
        await assertWarehouseBranchAllowed(tx, draft.toWarehouseId);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Transfer is not a draft');
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Transfer has no lines');
        }
        if (draft.fromWarehouseId === draft.toWarehouseId) {
          throw new DomainError(ErrorCode.VALIDATION, 'Source and destination must differ');
        }

        const transferDate = new Date(draft.transferDate);
        // §9.4 backdating applies to stock docs — resolveOpenPeriod also
        // enforces an open fiscal period.
        await this.posting.resolveOpenPeriod(tx, tenantId, companyId, transferDate);

        // Lock both sides of every line in the fixed order before any movement.
        await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.flatMap((l) => [
            { itemId: l.itemId, warehouseId: draft.fromWarehouseId },
            { itemId: l.itemId, warehouseId: draft.toWarehouseId },
          ]),
        );

        // OUT of the source and IN to the destination at the same value; the
        // item's company-level cost does not change (§9.2).
        for (const line of draft.lines) {
          await this.ledger.applyTransfer(tx, companyId, {
            itemId: line.itemId,
            fromWarehouseId: draft.fromWarehouseId,
            toWarehouseId: draft.toWarehouseId,
            movementDate: transferDate,
            qty: line.qty.toString(),
            sourceType: SOURCE,
            sourceId: draft.id,
            sourceLineId: line.id,
          });
        }

        const docNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'STOCK_TRANSFER', transferDate,
        );
        await tx.stockTransfer.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            docNo,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        return { id: draft.id, docNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'stock_transfer.post',
      entityType: 'stock_transfer',
      entityId: result.id,
      after: { docNo: result.docNo },
    });
    return this.get(result.id);
  }

  /** Reverses a posted transfer: IN back to source, OUT from destination. */
  async reverse(id: bigint, reversalDate: Date) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();

    const result = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        // Lock the document first (§10.1 step 7). As the first statement it also
        // makes every later read see the latest committed state, so two
        // concurrent requests cannot both post or reverse it.
        await tx.$queryRaw`SELECT id FROM stock_transfers WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const original = await tx.stockTransfer.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!original) throw DomainError.notFound('StockTransfer', id.toString());
        await assertWarehouseBranchAllowed(tx, original.fromWarehouseId);
        await assertWarehouseBranchAllowed(tx, original.toWarehouseId);
        if (original.status !== 'POSTED') {
          throw new DomainError(ErrorCode.CONFLICT, 'Only posted transfers can be reversed');
        }
        const existing = await tx.stockTransfer.findFirst({ where: { reversalOfId: original.id } });
        if (existing) throw new DomainError(ErrorCode.CONFLICT, 'Transfer already reversed');
        // TRADE-19: reversing a reversal would post a third, opposite transfer.
        if (original.reversalOfId !== null) {
          throw new DomainError(ErrorCode.CONFLICT, 'A reversal cannot be reversed');
        }

        await this.posting.resolveOpenPeriod(tx, tenantId, companyId, reversalDate);

        const origMovements = await tx.stockMovement.findMany({
          where: { tenantId, sourceType: SOURCE, sourceId: original.id },
        });
        const outByLine = new Map(origMovements.filter((m) => m.movementType === 'OUT').map((m) => [m.sourceLineId, m]));
        const inByLine = new Map(origMovements.filter((m) => m.movementType === 'IN').map((m) => [m.sourceLineId, m]));

        const reversal = await tx.stockTransfer.create({
          data: {
            tenantId,
            companyId,
            transferDate: reversalDate,
            fromWarehouseId: original.toWarehouseId,
            toWarehouseId: original.fromWarehouseId,
            description: `Reversal of ${original.docNo ?? original.id}`,
            reversalOfId: original.id,
            status: 'POSTED',
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });

        await tx.stockTransferLine.createMany({
          data: original.lines.map((l) => ({
            tenantId,
            transferId: reversal.id,
            lineNo: l.lineNo,
            itemId: l.itemId,
            qty: l.qty,
          })),
        });

        // Lock both sides of every line in the fixed order before any movement.
        await this.ledger.lockForDocument(
          tx,
          companyId,
          original.lines.flatMap((l) => [
            { itemId: l.itemId, warehouseId: original.fromWarehouseId },
            { itemId: l.itemId, warehouseId: original.toWarehouseId },
          ]),
        );
        // DB-04: the reversal mirrors the original legs at their own cost.
        for (const line of original.lines) {
          const out = outByLine.get(line.id);
          await this.ledger.applyTransfer(tx, companyId, {
            itemId: line.itemId,
            fromWarehouseId: original.toWarehouseId,
            toWarehouseId: original.fromWarehouseId,
            movementDate: reversalDate,
            qty: line.qty.toString(),
            unitCost: out?.unitCost.toString(),
            totalCost: out?.totalCost.toString(),
            sourceType: SOURCE,
            sourceId: reversal.id,
            sourceLineId: line.id,
            reversalOfInId: inByLine.get(line.id)?.id ?? null,
            reversalOfOutId: out?.id ?? null,
          });
        }

        const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'STOCK_TRANSFER', reversalDate);
        await tx.stockTransfer.update({ where: { id: reversal.id }, data: { docNo } });
        return { id: reversal.id, docNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'stock_transfer.reverse',
      entityType: 'stock_transfer',
      entityId: result.id,
      after: { docNo: result.docNo },
    });
    return this.get(result.id);
  }

}
