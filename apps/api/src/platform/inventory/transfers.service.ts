import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertWarehouseBranchAllowed } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PostingService } from '../journal/posting.service.js';
import { StockLedgerService } from './stock-ledger.service.js';
import type { CreateStockTransferDto } from './dto/inventory.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';

const SOURCE = 'STOCK_TRANSFER';

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const msg = String((err as Error)?.message ?? '');
  return code === 'P2034' || /deadlock|lock wait timeout/i.test(msg);
}

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

  async list(status?: string) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.stockTransfer.findMany({
      where: {
        companyId,
        ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}),
      },
      include: {
        fromWarehouse: { select: { id: true, code: true, nameAr: true } },
        toWarehouse: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ transferDate: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  }

  async get(id: bigint) {
    const { db } = this.tenant();
    const t = await db.stockTransfer.findFirst({
      where: { id },
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

    const result = await this.withRetry(() =>
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

        // OUT from source then IN to destination at the SAME avg cost.
        // Process items in a fixed order to keep lock ordering deterministic.
        const sorted = [...draft.lines].sort((a, b) => Number(a.itemId - b.itemId));
        for (const line of sorted) {
          const out = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.fromWarehouseId,
            itemId: line.itemId,
            movementDate: transferDate,
            type: 'OUT',
            qty: line.qty.toString(),
            sourceType: SOURCE,
            sourceId: draft.id,
            sourceLineId: line.id,
          });
          await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.toWarehouseId,
            itemId: line.itemId,
            movementDate: transferDate,
            type: 'IN',
            qty: line.qty.toString(),
            unitCost: out.unitCost.toString(),
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

    const result = await this.withRetry(() =>
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

        await this.posting.resolveOpenPeriod(tx, tenantId, companyId, reversalDate);

        const origMovements = await tx.stockMovement.findMany({
          where: { tenantId, sourceType: SOURCE, sourceId: original.id, movementType: 'OUT' },
        });
        const costByLine = new Map(origMovements.map((m) => [m.sourceLineId, m.unitCost]));

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
        const sorted = [...original.lines].sort((a, b) => Number(a.itemId - b.itemId));
        for (const line of sorted) {
          const unitCost = costByLine.get(line.id)?.toString();
          const out = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: original.toWarehouseId,
            itemId: line.itemId,
            movementDate: reversalDate,
            type: 'OUT',
            qty: line.qty.toString(),
            sourceType: SOURCE,
            sourceId: reversal.id,
            sourceLineId: line.id,
          });
          await this.ledger.applyMovement(tx, companyId, {
            warehouseId: original.fromWarehouseId,
            itemId: line.itemId,
            movementDate: reversalDate,
            type: 'IN',
            qty: line.qty.toString(),
            unitCost: unitCost ?? out.unitCost.toString(),
            sourceType: SOURCE,
            sourceId: reversal.id,
            sourceLineId: line.id,
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

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isRetryable(err)) return fn();
      throw err;
    }
  }
}
