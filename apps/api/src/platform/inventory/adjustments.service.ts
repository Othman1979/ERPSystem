import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertWarehouseBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from './stock-ledger.service.js';
import type { CreateStockAdjustmentDto } from './dto/inventory.dto.js';
import type { ListStockAdjustmentsQueryDto } from './dto/list-queries.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { retryOnLockConflict } from '../shared/document-support.service.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';

const SOURCE = 'STOCK_ADJUSTMENT';

/**
 * Manual stock adjustments: OPENING, IN, OUT, COUNT_ADJUSTMENT (§7.4, §8.4,
 * §8.6, §9). Posting creates stock movements AND the balancing journal
 * entry (Inventory ↔ INVENTORY_ADJUSTMENT, or OPENING_BALANCE_EQUITY for
 * opening stock) in one transaction.
 */
@Injectable()
export class AdjustmentsService {
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
   * One numbered page of adjustments (ADR-022), newest first unless `sort` says
   * otherwise. An adjustment belongs to its warehouse's branch (ADR-003 §10).
   */
  async list(query: ListStockAdjustmentsQueryDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', {
        from: query.from,
        to: query.to,
      });
    }
    const q = query.q;
    const where: Prisma.StockAdjustmentWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.adjustmentType ? { adjustmentType: query.adjustmentType } : {}),
      ...(query.warehouseId ? { warehouseId: BigInt(query.warehouseId) } : {}),
      ...(query.from || query.to
        ? {
            adjustmentDate: {
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
    const orderBy = orderByOf<'date' | 'docNo', Prisma.StockAdjustmentOrderByWithRelationInput>(
      query.sort,
      '-date',
      {
        date: (dir) => ({ adjustmentDate: dir }),
        docNo: (dir) => ({ docNo: dir }),
      },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: (tx, window) =>
        tx.stockAdjustment.findMany({
          where,
          include: {
            warehouse: { select: { id: true, code: true, nameAr: true } },
            _count: { select: { lines: true } },
          },
          orderBy,
          ...window,
        }),
      count: (tx) => tx.stockAdjustment.count({ where }),
    });
  }

  /** One adjustment; another branch's answers 404 like another tenant's (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.tenant();
    const adj = await db.stockAdjustment.findFirst({
      where: { id, AND: [{ warehouse: branchWhere() }] },
      include: {
        warehouse: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { item: { select: { id: true, code: true, nameAr: true, baseUnitId: true } } },
        },
        journalEntry: { select: { id: true, entryNo: true } },
        reversalOf: { select: { id: true, docNo: true } },
        reversals: { select: { id: true, docNo: true, status: true } },
      },
    });
    if (!adj) throw DomainError.notFound('StockAdjustment', id.toString());
    return adj;
  }

  async create(dto: CreateStockAdjustmentDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);

    const warehouse = await db.warehouse.findFirst({
      where: { id: BigInt(dto.warehouseId), companyId, isActive: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);

    // Validate items belong to the company and are stocked.
    const itemIds = dto.lines.map((l) => BigInt(l.itemId));
    const items = await db.item.findMany({
      where: { tenantId, companyId, id: { in: itemIds } },
      select: { id: true, code: true, itemKind: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of dto.lines) {
      const item = byId.get(BigInt(l.itemId));
      if (!item) throw DomainError.notFound('Item', l.itemId);
      if (item.itemKind !== 'STOCK') {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Item ${item.code} is a service — no stock adjustment allowed`,
        );
      }
    }

    if (dto.adjustmentType === 'COUNT_ADJUSTMENT') {
      throw new DomainError(
        ErrorCode.VALIDATION,
        'COUNT_ADJUSTMENT documents are created by stock counts',
      );
    }

    // Direction sanity per adjustment type.
    const wantsIn = dto.adjustmentType === 'OPENING' || dto.adjustmentType === 'IN';
    for (const l of dto.lines) {
      const qty = new Decimal(l.qty);
      if (qty.lte(0)) {
        throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
      }
      if (wantsIn && !l.unitCost) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          'unitCost is required for IN/OPENING adjustment lines',
        );
      }
      if (dto.adjustmentType === 'OUT' && l.unitCost) {
        // harmless — cost comes from average at posting; ignore stored value
      }
    }

    const adj = await db.$transaction(async (tx) => {
      const created = await tx.stockAdjustment.create({
        data: {
          tenantId,
          companyId,
          warehouseId: warehouse.id,
          adjustmentDate: new Date(dto.adjustmentDate),
          adjustmentType: dto.adjustmentType,
          description: dto.description ?? null,
        },
      });
      await tx.stockAdjustmentLine.createMany({
        data: dto.lines.map((l, i) => ({
          tenantId,
          adjustmentId: created.id,
          lineNo: i + 1,
          itemId: BigInt(l.itemId),
          qtyIn: wantsIn ? l.qty : '0',
          qtyOut: wantsIn ? '0' : l.qty,
          unitCost: wantsIn ? (l.unitCost ?? null) : null,
          description: l.description ?? null,
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'stock_adjustment.create',
      entityType: 'stock_adjustment',
      entityId: adj.id,
      after: { adjustmentType: dto.adjustmentType, lines: dto.lines.length },
    });
    return this.get(adj.id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.tenant();
    const adj = await db.stockAdjustment.findFirst({ where: { id } });
    if (!adj) throw DomainError.notFound('StockAdjustment', id.toString());
    if (adj.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft adjustments can be deleted');
    }
    await db.stockAdjustment.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Posts a draft adjustment: stock movements + journal entry + doc number,
   * all in one transaction (§10). sourceType=STOCK_ADJUSTMENT.
   */
  async post(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();

    const result = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        // Lock the document first (§10.1 step 7). As the first statement it also
        // makes every later read see the latest committed state, so two
        // concurrent requests cannot both post or reverse it.
        await tx.$queryRaw`SELECT id FROM stock_adjustments WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        return this.postLocked(tx, id, companyId, userId);
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'stock_adjustment.post',
      entityType: 'stock_adjustment',
      entityId: result.id,
      after: { docNo: result.docNo },
    });
    return this.get(result.id);
  }

  /**
   * Posts a draft adjustment on the caller's transaction, which already holds
   * the adjustment's row lock: movements, then the journal entry. Also used
   * by stock count approval, so the count, its adjustment and the posting
   * commit together (TRADE-07).
   */
  async postLocked(
    tx: Prisma.TransactionClient,
    id: bigint,
    companyId: bigint,
    userId: bigint | undefined,
  ): Promise<{ id: bigint; docNo: string }> {
        const { tenantId } = this.tenant();
        const draft = await tx.stockAdjustment.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('StockAdjustment', id.toString());
        // The entry carries the warehouse's branch (ADR-003; S1 of the wave-3E review).
        const branchId = await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Adjustment is not a draft');
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Adjustment has no lines');
        }

        const adjustmentDate = new Date(draft.adjustmentDate);
        const period = await this.posting.resolveOpenPeriod(
          tx,
          tenantId,
          companyId,
          adjustmentDate,
        );

        // Lock every (item, warehouse) in the fixed order before any movement.
        await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
        );

        // Apply movements first — returns per-line cost for the journal.
        let writeOff = new Decimal(0);
        const applied: {
          line: (typeof draft.lines)[number];
          unitCost: Decimal;
          totalCost: Decimal;
          movementId: bigint;
        }[] = [];
        for (const line of draft.lines) {
          const isIn = new Decimal(line.qtyIn.toString()).gt(0);
          const qty = isIn ? line.qtyIn : line.qtyOut;
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.warehouseId,
            itemId: line.itemId,
            movementDate: adjustmentDate,
            type: isIn ? 'IN' : 'OUT',
            qty: qty.toString(),
            unitCost: isIn ? (line.unitCost?.toString() ?? undefined) : undefined,
            sourceType: SOURCE,
            sourceId: draft.id,
            sourceLineId: line.id,
          });
          applied.push({ line, unitCost: res.unitCost, totalCost: res.totalCost, movementId: res.movementId });
          writeOff = writeOff.plus(res.writeOff);
        }

        // Journal entry (§8.4):
        //  OPENING           → Dr INVENTORY / Cr OPENING_BALANCE_EQUITY
        //  IN, COUNT_ADJ +   → Dr INVENTORY / Cr INVENTORY_ADJUSTMENT
        //  OUT, COUNT_ADJ -  → Dr INVENTORY_ADJUSTMENT / Cr INVENTORY
        const mapping = await this.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
          'INVENTORY_ADJUSTMENT',
          'OPENING_BALANCE_EQUITY',
        ]);

        const journalLines: JournalLineInput[] = [];
        const pushPair = (debitAccount: bigint, creditAccount: bigint, amount: Decimal, desc: string) => {
          if (amount.lte(0)) return;
          journalLines.push({ accountId: debitAccount, debit: amount.toString(), description: desc });
          journalLines.push({ accountId: creditAccount, credit: amount.toString(), description: desc });
        };

        if (draft.adjustmentType === 'OPENING') {
          for (const a of applied) {
            pushPair(mapping.INVENTORY, mapping.OPENING_BALANCE_EQUITY, a.totalCost, `Opening stock ${a.line.itemId}`);
          }
        } else {
          for (const a of applied) {
            const isIn = new Decimal(a.line.qtyIn.toString()).gt(0);
            if (draft.adjustmentType === 'IN' || (draft.adjustmentType === 'COUNT_ADJUSTMENT' && isIn)) {
              pushPair(mapping.INVENTORY, mapping.INVENTORY_ADJUSTMENT, a.totalCost, `Stock in ${a.line.itemId}`);
            } else {
              pushPair(mapping.INVENTORY_ADJUSTMENT, mapping.INVENTORY, a.totalCost, `Stock out ${a.line.itemId}`);
            }
          }
        }

        journalLines.push(
          ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
        );

        // Merge duplicate account sides? postEntry validates each line
        // independently — multiple lines on the same account are fine.
        const docNo = await this.posting.allocateEntryNo(
          tx,
          tenantId,
          companyId,
          'STOCK_ADJUSTMENT',
          adjustmentDate,
        );
        let entryId: bigint | null = null;
        if (journalLines.length > 0) {
          const entry = await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: adjustmentDate,
            fiscalPeriodId: period.id,
            branchId,
            sourceType: SOURCE,
            sourceId: draft.id,
            // Opening stock is part of the opening balances in reports (§8.6).
            isOpening: draft.adjustmentType === 'OPENING',
            description: draft.description ?? `Stock adjustment ${draft.adjustmentType}`,
            lines: journalLines,
            postedBy: userId ?? null,
          });
          entryId = entry.id;
        }

        await tx.stockAdjustment.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            docNo,
            journalEntryId: entryId,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        return { id: draft.id, docNo };
  }

  /** Reverses a posted adjustment: opposite movements + reversal journal. */
  async reverse(id: bigint, reversalDate: Date) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();

    const result = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        // Lock the document first (§10.1 step 7). As the first statement it also
        // makes every later read see the latest committed state, so two
        // concurrent requests cannot both post or reverse it.
        await tx.$queryRaw`SELECT id FROM stock_adjustments WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const original = await tx.stockAdjustment.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!original) throw DomainError.notFound('StockAdjustment', id.toString());
        const branchId = await assertWarehouseBranchAllowed(tx, original.warehouseId);
        if (original.status !== 'POSTED') {
          throw new DomainError(ErrorCode.CONFLICT, 'Only posted adjustments can be reversed');
        }
        const existingReversal = await tx.stockAdjustment.findFirst({
          where: { reversalOfId: original.id },
        });
        if (existingReversal) {
          throw new DomainError(ErrorCode.CONFLICT, 'Adjustment already reversed');
        }
        // TRADE-19: a reversal has no lines; reversing it posted an empty document.
        if (original.reversalOfId !== null) {
          throw new DomainError(ErrorCode.CONFLICT, 'A reversal cannot be reversed');
        }

        // Original movements for this doc (for reversal linkage + costs).
        const origMovements = await tx.stockMovement.findMany({
          where: { tenantId, sourceType: SOURCE, sourceId: original.id },
        });
        const byLine = new Map(origMovements.map((m) => [m.sourceLineId, m]));

        const reversal = await tx.stockAdjustment.create({
          data: {
            tenantId,
            companyId,
            warehouseId: original.warehouseId,
            adjustmentDate: reversalDate,
            adjustmentType: original.adjustmentType,
            description: `Reversal of ${original.docNo ?? original.id}`,
            reversalOfId: original.id,
            status: 'POSTED',
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });

        const period = await this.posting.resolveOpenPeriod(
          tx, tenantId, companyId, reversalDate,
        );

        const journalLines: JournalLineInput[] = [];
        const mapping = await this.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
          'INVENTORY_ADJUSTMENT',
          'OPENING_BALANCE_EQUITY',
        ]);

        // Lock every (item, warehouse) in the fixed order before any movement.
        await this.ledger.lockForDocument(
          tx,
          companyId,
          original.lines.map((l) => ({ itemId: l.itemId, warehouseId: original.warehouseId })),
        );

        let writeOff = new Decimal(0);
        for (const line of original.lines) {
          const orig = byLine.get(line.id);
          const wasIn = new Decimal(line.qtyIn.toString()).gt(0);
          const qty = wasIn ? line.qtyIn.toString() : line.qtyOut.toString();
          // §9.5, DB-05: the reversal mirrors the original movement, same
          // unit cost and same total, in both directions — so the journal
          // below is the original's mirror and no residue stays in
          // INVENTORY_ADJUSTMENT or OPENING_BALANCE_EQUITY.
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: original.warehouseId,
            itemId: line.itemId,
            movementDate: reversalDate,
            type: wasIn ? 'OUT' : 'IN',
            qty,
            unitCost: orig?.unitCost.toString(),
            totalCost: orig?.totalCost.toString(),
            sourceType: SOURCE,
            sourceId: reversal.id,
            sourceLineId: line.id,
            reversalOfId: orig?.id ?? null,
          });
          writeOff = writeOff.plus(res.writeOff);
          const amount = res.totalCost;
          const isInNow = !wasIn; // reversal direction
          if (original.adjustmentType === 'OPENING') {
            if (isInNow) {
              journalLines.push({ accountId: mapping.INVENTORY, debit: amount.toString() });
              journalLines.push({ accountId: mapping.OPENING_BALANCE_EQUITY, credit: amount.toString() });
            } else {
              journalLines.push({ accountId: mapping.OPENING_BALANCE_EQUITY, debit: amount.toString() });
              journalLines.push({ accountId: mapping.INVENTORY, credit: amount.toString() });
            }
          } else {
            const dr = isInNow ? mapping.INVENTORY : mapping.INVENTORY_ADJUSTMENT;
            const cr = isInNow ? mapping.INVENTORY_ADJUSTMENT : mapping.INVENTORY;
            journalLines.push({ accountId: dr, debit: amount.toString() });
            journalLines.push({ accountId: cr, credit: amount.toString() });
          }
        }

        journalLines.push(
          ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
        );

        const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'STOCK_ADJUSTMENT', reversalDate);
        await tx.stockAdjustment.update({ where: { id: reversal.id }, data: { docNo } });

        let entryId: bigint | null = null;
        if (journalLines.length > 0) {
          const entry = await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: reversalDate,
            fiscalPeriodId: period.id,
            branchId,
            sourceType: SOURCE,
            sourceId: reversal.id,
            postingKind: 'REVERSAL',
            reversalOfId: original.journalEntryId,
            isOpening: original.adjustmentType === 'OPENING',
            description: `Reversal of adjustment ${original.docNo ?? original.id}`,
            lines: journalLines,
            postedBy: userId ?? null,
          });
          entryId = entry.id;
        }
        await tx.stockAdjustment.update({
          where: { id: reversal.id },
          data: { journalEntryId: entryId },
        });
        return { id: reversal.id, docNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'stock_adjustment.reverse',
      entityType: 'stock_adjustment',
      entityId: result.id,
      after: { docNo: result.docNo },
    });
    return this.get(result.id);
  }

  private async mappingAccounts(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    keys: string[],
  ): Promise<Record<string, bigint>> {
    const maps = await tx.accountMapping.findMany({
      where: { tenantId, companyId, mappingKey: { in: keys } },
    });
    const out: Record<string, bigint> = {};
    for (const m of maps) {
      if (m.accountId !== null) out[m.mappingKey] = m.accountId;
    }
    for (const k of keys) {
      if (!out[k]) {
        throw new DomainError(ErrorCode.INTERNAL, `Account mapping ${k} is not configured`);
      }
    }
    return out;
  }

}
