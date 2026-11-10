import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  generalLock,
  OpeningBalancesService,
  type OpeningContext,
  type OpeningLockReason,
} from '../journal/opening-balances.service.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import type { SetOpeningStockDto } from './dto/opening-stock.dto.js';
import { StockLedgerService } from './stock-ledger.service.js';

const SOURCE = 'STOCK_ADJUSTMENT';

type Db = ReturnType<PrismaService['forTenant']>;
type Tx = Prisma.TransactionClient;

/** Why an item's opening stock can't be changed on the item form. */
export type OpeningStockLockReason = 'SERVICE_ITEM' | 'HAS_MOVEMENTS' | 'SHARED_DOCUMENT' | OpeningLockReason;

interface TargetLine {
  warehouseId: bigint;
  qty: Decimal;
  /** 6 places for the value; adjustment lines store 3 (schema). */
  unitCost: Decimal;
}

/** The unit cost as an adjustment line stores it. */
const storedCost = (v: Decimal.Value) => round3(v).toString();

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const msg = String((err as Error)?.message ?? '');
  return code === 'P2034' || /deadlock|lock wait timeout/i.test(msg);
}

/**
 * Opening stock entered on the item form (BUILD_PLAN §8.6, ADR-007): one
 * OPENING stock adjustment per warehouse, dated on the first day of the
 * first fiscal year (Dr INVENTORY / Cr OPENING_BALANCE_EQUITY). Saving
 * replaces the item's opening stock: the earlier opening adjustments are
 * reversed and the new ones posted, in one transaction. Allowed only while
 * the item has no other movement — the average cost depends on the order.
 */
@Injectable()
export class OpeningStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly posting: PostingService,
    private readonly opening: OpeningBalancesService,
    private readonly audit: AuditService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: Db): Promise<bigint> {
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

  /** Posted opening adjustments of the item, on the opening date, still in effect. */
  private activeDocuments(tx: Tx | Db, companyId: bigint, itemId: bigint, ctx: OpeningContext | null) {
    if (!ctx) return Promise.resolve([]);
    return tx.stockAdjustment.findMany({
      where: {
        companyId,
        adjustmentType: 'OPENING',
        adjustmentDate: ctx.date,
        status: 'POSTED',
        reversalOfId: null,
        reversals: { none: {} },
        lines: { some: { itemId } },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
      orderBy: [{ warehouseId: 'asc' }, { id: 'asc' }],
    });
  }

  private async lockReason(
    tx: Tx | Db,
    companyId: bigint,
    item: { id: bigint; itemKind: string },
    ctx: OpeningContext | null,
  ): Promise<OpeningStockLockReason | null> {
    if (item.itemKind !== 'STOCK') return 'SERVICE_ITEM';
    const moved = await tx.stockMovement.findFirst({
      where: { companyId, itemId: item.id, isOpening: false },
      select: { id: true },
    });
    if (moved) return 'HAS_MOVEMENTS';
    const docs = await this.activeDocuments(tx, companyId, item.id, ctx);
    if (docs.some((d) => d.lines.some((l) => l.itemId !== item.id))) return 'SHARED_DOCUMENT';
    return generalLock(ctx, PERMISSIONS.STOCK_MOVEMENT);
  }

  /**
   * The item's opening stock per warehouse, and whether it can change. Read
   * from the opening documents in effect — their own quantity and the value
   * they were posted at — not from movements: a reversal goes out at the
   * item's average cost, which differs per warehouse when costs differ.
   */
  async get(itemId: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const item = await db.item.findFirst({ where: { id: itemId, companyId }, select: { id: true, itemKind: true } });
    if (!item) throw DomainError.notFound('Item', itemId.toString());
    const ctx = await this.opening.openingContext(db, tenantId, companyId);

    const docs = await this.activeDocuments(db, companyId, itemId, ctx);
    const moves = docs.length
      ? await db.stockMovement.findMany({
          where: { sourceType: SOURCE, sourceId: { in: docs.map((d) => d.id) }, movementType: 'IN' },
          select: { sourceLineId: true, totalCost: true },
        })
      : [];
    const valueByLine = new Map(moves.map((m) => [m.sourceLineId, new Decimal(m.totalCost.toString())]));
    const byWarehouse = new Map<bigint, { qty: Decimal; value: Decimal }>();
    for (const d of docs) {
      for (const l of d.lines.filter((x) => x.itemId === itemId)) {
        const w = byWarehouse.get(d.warehouseId) ?? { qty: new Decimal(0), value: new Decimal(0) };
        w.qty = w.qty.plus(l.qtyIn.toString());
        w.value = w.value.plus(valueByLine.get(l.id) ?? round3(new Decimal(l.qtyIn.toString()).times(l.unitCost?.toString() ?? 0)));
        byWarehouse.set(d.warehouseId, w);
      }
    }
    const ids = [...byWarehouse.entries()].filter(([, w]) => !w.qty.isZero()).map(([id]) => id);
    const warehouses = ids.length
      ? await db.warehouse.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameAr: true, nameEn: true } })
      : [];
    const lines = warehouses
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((w) => {
        const { qty, value } = byWarehouse.get(w.id)!;
        return {
          warehouseId: w.id.toString(),
          warehouse: { code: w.code, nameAr: w.nameAr, nameEn: w.nameEn },
          qty: qty.toString(),
          unitCost: round6(value.div(qty)).toString(),
          value: value.toString(),
        };
      });

    return {
      itemId: itemId.toString(),
      date: ctx?.date ?? null,
      lines,
      lockedReason: await this.lockReason(db, companyId, item, ctx),
    };
  }

  /** Replaces the item's opening stock with `dto.lines`. */
  async set(itemId: bigint, dto: SetOpeningStockDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);

    const target: TargetLine[] = dto.lines
      .map((l) => ({ warehouseId: BigInt(l.warehouseId), qty: round6(l.qty), unitCost: round6(l.unitCost) }))
      .sort((a, b) => (a.warehouseId < b.warehouseId ? -1 : a.warehouseId > b.warehouseId ? 1 : 0));
    for (const [i, l] of target.entries()) {
      if (l.qty.lte(0)) {
        throw new DomainError(ErrorCode.VALIDATION, 'Opening quantity must be > 0', { rule: 'QTY' });
      }
      if (i > 0 && target[i - 1].warehouseId === l.warehouseId) {
        throw new DomainError(ErrorCode.VALIDATION, 'One line per warehouse', { rule: 'DUPLICATE_WAREHOUSE' });
      }
    }

    const changed = await this.withRetry(() =>
      db.$transaction(
        async (tx) => {
          // One writer per item, and nothing else may move it meanwhile.
          await tx.$queryRaw`SELECT id FROM items WHERE tenant_id = ${tenantId} AND id = ${itemId} FOR UPDATE`;
          const item = await tx.item.findFirst({
            where: { tenantId, companyId, id: itemId },
            select: { id: true, code: true, itemKind: true },
          });
          if (!item) throw DomainError.notFound('Item', itemId.toString());
          const ctx = await this.opening.openingContext(tx, tenantId, companyId);
          const reason = await this.lockReason(tx, companyId, item, ctx);
          if (reason) {
            throw new DomainError(
              ErrorCode.OPENING_BALANCE_LOCKED,
              `The opening stock of item ${item.code} can't be changed (${reason})`,
              { reason, itemCode: item.code },
            );
          }
          const context = ctx!;

          if (target.length) {
            const found = await tx.warehouse.count({
              where: { tenantId, companyId, isActive: true, id: { in: target.map((l) => l.warehouseId) } },
            });
            if (found !== target.length) throw DomainError.notFound('Warehouse', 'opening stock line');
          }

          const docs = await this.activeDocuments(tx, companyId, itemId, context);
          if (this.sameAs(docs, target)) return false;

          const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, context.date);
          const accounts = await this.mappings(tx, tenantId, companyId);
          for (const doc of docs) await this.reverseDocument(tx, tenantId, companyId, context, doc);
          for (const line of target) {
            await this.postDocument(tx, tenantId, companyId, context, period.id, accounts, item, line);
          }
          return true;
        },
        { timeout: 30000 },
      ),
    );

    if (changed) {
      await this.audit.log({
        action: 'opening.stock',
        entityType: 'item',
        entityId: itemId,
        after: { lines: target.map((l) => ({ warehouseId: l.warehouseId.toString(), qty: l.qty.toString(), unitCost: l.unitCost.toString() })) },
      });
    }
    return this.get(itemId);
  }

  /** True when the documents in effect already hold exactly `target` (cost as stored). */
  private sameAs(docs: Awaited<ReturnType<OpeningStockService['activeDocuments']>>, target: TargetLine[]): boolean {
    const current = docs
      .flatMap((d) => d.lines.map((l) => `${d.warehouseId}:${new Decimal(l.qtyIn.toString())}:${storedCost(l.unitCost?.toString() ?? 0)}`))
      .sort();
    const wanted = target.map((l) => `${l.warehouseId}:${l.qty}:${storedCost(l.unitCost)}`).sort();
    return current.length === wanted.length && current.every((c, i) => c === wanted[i]);
  }

  private async mappings(tx: Tx, tenantId: bigint, companyId: bigint) {
    const rows = await tx.accountMapping.findMany({
      where: { tenantId, companyId, mappingKey: { in: ['INVENTORY', 'OPENING_BALANCE_EQUITY'] } },
    });
    const by = new Map(rows.map((r) => [r.mappingKey, r.accountId]));
    const inventory = by.get('INVENTORY');
    const equity = by.get('OPENING_BALANCE_EQUITY');
    if (!inventory || !equity) {
      throw new DomainError(ErrorCode.INTERNAL, 'INVENTORY / OPENING_BALANCE_EQUITY mapping missing');
    }
    return { inventory, equity };
  }

  /** Posts one warehouse's opening stock as an OPENING adjustment. */
  private async postDocument(
    tx: Tx,
    tenantId: bigint,
    companyId: bigint,
    ctx: OpeningContext,
    periodId: bigint,
    accounts: { inventory: bigint; equity: bigint },
    item: { id: bigint; code: string },
    line: TargetLine,
  ) {
    const userId = this.userId() ?? null;
    const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'STOCK_ADJUSTMENT', ctx.date);
    const doc = await tx.stockAdjustment.create({
      data: {
        tenantId,
        companyId,
        warehouseId: line.warehouseId,
        adjustmentDate: ctx.date,
        adjustmentType: 'OPENING',
        description: `Opening stock ${item.code}`,
        status: 'POSTED',
        docNo,
        postedAt: new Date(),
        postedBy: userId,
      },
    });
    const docLine = await tx.stockAdjustmentLine.create({
      data: {
        tenantId,
        adjustmentId: doc.id,
        lineNo: 1,
        itemId: item.id,
        qtyIn: line.qty.toString(),
        qtyOut: '0',
        unitCost: storedCost(line.unitCost),
      },
    });
    const moved = await this.ledger.applyMovement(tx, companyId, {
      warehouseId: line.warehouseId,
      itemId: item.id,
      movementDate: ctx.date,
      type: 'IN',
      qty: line.qty.toString(),
      unitCost: line.unitCost.toString(),
      sourceType: SOURCE,
      sourceId: doc.id,
      sourceLineId: docLine.id,
      isOpening: true,
    });
    const entryId = await this.postJournal(tx, tenantId, companyId, ctx, periodId, {
      sourceId: doc.id,
      description: `Opening stock ${item.code}`,
      lines: this.pair(accounts.inventory, accounts.equity, moved.totalCost),
    });
    await tx.stockAdjustment.update({ where: { id: doc.id }, data: { journalEntryId: entryId } });
  }

  /**
   * Reverses an opening adjustment of this item. Its journal entry is mirrored
   * exactly (PostingService.reverseEntry); the OUT movements go at the average
   * cost, and since every opening document of the item is reversed together
   * and the item has no other movement, they carry out exactly the same total.
   */
  private async reverseDocument(
    tx: Tx,
    tenantId: bigint,
    companyId: bigint,
    ctx: OpeningContext,
    doc: Awaited<ReturnType<OpeningStockService['activeDocuments']>>[number],
  ) {
    const userId = this.userId() ?? null;
    const moves = await tx.stockMovement.findMany({ where: { tenantId, sourceType: SOURCE, sourceId: doc.id } });
    const byLine = new Map(moves.map((m) => [m.sourceLineId, m]));
    const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'STOCK_ADJUSTMENT', ctx.date);
    const reversal = await tx.stockAdjustment.create({
      data: {
        tenantId,
        companyId,
        warehouseId: doc.warehouseId,
        adjustmentDate: ctx.date,
        adjustmentType: 'OPENING',
        description: `Reversal of ${doc.docNo ?? doc.id}`,
        reversalOfId: doc.id,
        status: 'POSTED',
        docNo,
        postedAt: new Date(),
        postedBy: userId,
      },
    });
    for (const line of doc.lines) {
      await this.ledger.applyMovement(tx, companyId, {
        warehouseId: doc.warehouseId,
        itemId: line.itemId,
        movementDate: ctx.date,
        type: 'OUT',
        qty: line.qtyIn.toString(),
        sourceType: SOURCE,
        sourceId: reversal.id,
        sourceLineId: line.id,
        reversalOfId: byLine.get(line.id)?.id ?? null,
        isOpening: true,
      });
    }
    if (doc.journalEntryId) {
      const entry = await this.posting.reverseEntry(tx, {
        tenantId,
        companyId,
        entryId: doc.journalEntryId,
        reversalDate: ctx.date,
        description: `Reversal of adjustment ${doc.docNo ?? doc.id}`,
        postedBy: userId,
      });
      await tx.stockAdjustment.update({ where: { id: reversal.id }, data: { journalEntryId: entry.id } });
    }
  }

  private pair(debitAccount: bigint, creditAccount: bigint, amount: Decimal): JournalLineInput[] {
    if (amount.lte(0)) return [];
    return [
      { accountId: debitAccount, debit: amount.toString() },
      { accountId: creditAccount, credit: amount.toString() },
    ];
  }

  /** Journal entry of an opening adjustment; none when its value is zero. */
  private async postJournal(
    tx: Tx,
    tenantId: bigint,
    companyId: bigint,
    ctx: OpeningContext,
    periodId: bigint,
    p: { sourceId: bigint; description: string; lines: JournalLineInput[] },
  ): Promise<bigint | null> {
    if (!p.lines.length) return null;
    const entryNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'JOURNAL_ENTRY', ctx.date);
    const entry = await this.posting.postEntry(tx, {
      tenantId,
      companyId,
      entryDate: ctx.date,
      fiscalPeriodId: periodId,
      entryNo,
      sourceType: SOURCE,
      sourceId: p.sourceId,
      description: p.description,
      lines: p.lines,
      postedBy: this.userId() ?? null,
      isOpening: true,
    });
    return entry.id;
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
