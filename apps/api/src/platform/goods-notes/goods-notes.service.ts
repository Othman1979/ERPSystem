import { Injectable } from '@nestjs/common';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, currentBranchId } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type { CreateGoodsNoteDto } from './dto/goods-notes.dto.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';

/** A goods receipt note as a purchase invoice bills it (TRADE-02, ADR-016). */
export interface GrnBillingSource {
  id: bigint;
  docNo: string | null;
  status: 'DRAFT' | 'POSTED';
  noteType: 'GRN' | 'GIN';
  warehouseId: bigint;
  /** Base quantity and value received per item; value = Σ round3(qty × unit cost), as the movements. */
  byItem: Map<bigint, { qty: Decimal; value: Decimal }>;
}

/**
 * Goods notes — GRN (استلام بضاعة) and GIN (صرف بضاعة): stock movements
 * without an invoice (§7.4-style documents).
 *  GRN: Dr INVENTORY / Cr GOODS_RECEIVED_NOT_INVOICED (2104)
 *  GIN: Dr INVENTORY_ADJUSTMENT / Cr INVENTORY
 * Branch (ADR-003): the warehouse's branch, or the request branch when the
 * warehouse has none. Never taken from the body.
 */
@Injectable()
export class GoodsNotesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
  ) {}

  async list(status?: string, noteType?: string) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.goodsNote.findMany({
      where: {
        companyId,
        ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}),
        ...(noteType ? { noteType: noteType as 'GRN' | 'GIN' } : {}),
      },
      include: {
        warehouse: { select: { id: true, code: true, nameAr: true } },
        branch: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ noteDate: 'desc' }, { id: 'desc' }],
      take: 300,
    });
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const note = await db.goodsNote.findFirst({
      where: { id },
      include: {
        warehouse: true,
        branch: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { item: { select: { id: true, code: true, nameAr: true } } },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
      },
    });
    if (!note) throw DomainError.notFound('GoodsNote', id.toString());
    return note;
  }

  async create(dto: CreateGoodsNoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);

    const warehouse = await db.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true, branchId: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);
    const branchId = warehouse.branchId ?? currentBranchId();
    assertBranchAllowed(branchId);

    const itemIds = dto.lines.map((l) => BigInt(l.itemId));
    const items = await db.item.findMany({
      where: { tenantId, companyId, id: { in: itemIds }, isActive: true },
      select: { id: true, code: true, itemKind: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of dto.lines) {
      const item = byId.get(BigInt(l.itemId));
      if (!item) throw DomainError.notFound('Item', l.itemId);
      if (item.itemKind !== 'STOCK') {
        throw new DomainError(ErrorCode.VALIDATION, `Item ${item.code} is a service — no stock note allowed`);
      }
      const qty = new Decimal(l.qty);
      if (qty.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
      if (dto.noteType === 'GRN' && !l.unitCost) {
        throw new DomainError(ErrorCode.VALIDATION, 'unitCost is required for GRN lines');
      }
    }

    const note = await db.$transaction(async (tx) => {
      const created = await tx.goodsNote.create({
        data: {
          tenantId,
          companyId,
          branchId,
          warehouseId: warehouse.id,
          noteDate: new Date(dto.noteDate),
          noteType: dto.noteType,
          description: dto.description ?? null,
        },
      });
      await tx.goodsNoteLine.createMany({
        data: dto.lines.map((l, i) => ({
          tenantId,
          noteId: created.id,
          lineNo: i + 1,
          itemId: BigInt(l.itemId),
          qty: l.qty,
          unitCost: dto.noteType === 'GRN' ? (l.unitCost ?? null) : null,
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'goods_note.create',
      entityType: 'goods_note',
      entityId: note.id,
      after: { noteType: dto.noteType, lines: dto.lines.length },
    });
    return this.get(note.id);
  }

  async update(id: bigint, dto: CreateGoodsNoteDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const note = await db.goodsNote.findFirst({ where: { id } });
    if (!note) throw DomainError.notFound('GoodsNote', id.toString());
    if (note.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft notes can be modified');
    }
    assertBranchAllowed(note.branchId);
    const warehouse = await db.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true, branchId: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);
    // Same warehouse: the note keeps its branch. Another warehouse: that one's branch.
    const branchId =
      warehouse.id === note.warehouseId && note.branchId != null
        ? note.branchId
        : (warehouse.branchId ?? currentBranchId());
    assertBranchAllowed(branchId);

    const itemIds = dto.lines.map((l) => BigInt(l.itemId));
    const items = await db.item.findMany({
      where: { tenantId, companyId, id: { in: itemIds }, isActive: true },
      select: { id: true, code: true, itemKind: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of dto.lines) {
      const item = byId.get(BigInt(l.itemId));
      if (!item) throw DomainError.notFound('Item', l.itemId);
      if (item.itemKind !== 'STOCK') {
        throw new DomainError(ErrorCode.VALIDATION, `Item ${item.code} is a service`);
      }
      if (dto.noteType === 'GRN' && !l.unitCost) {
        throw new DomainError(ErrorCode.VALIDATION, 'unitCost is required for GRN lines');
      }
    }

    await db.$transaction(async (tx) => {
      await tx.goodsNoteLine.deleteMany({ where: { noteId: id } });
      await tx.goodsNote.update({
        where: { id },
        data: {
          noteDate: new Date(dto.noteDate),
          noteType: dto.noteType,
          branchId,
          warehouseId: warehouse.id,
          description: dto.description ?? null,
        },
      });
      await tx.goodsNoteLine.createMany({
        data: dto.lines.map((l, i) => ({
          tenantId,
          noteId: id,
          lineNo: i + 1,
          itemId: BigInt(l.itemId),
          qty: l.qty,
          unitCost: dto.noteType === 'GRN' ? (l.unitCost ?? null) : null,
        })),
      });
    }, POSTING_TX_OPTIONS);
    await this.audit.log({ action: 'goods_note.update', entityType: 'goods_note', entityId: id });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const note = await db.goodsNote.findFirst({ where: { id } });
    if (!note) throw DomainError.notFound('GoodsNote', id.toString());
    if (note.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft notes can be deleted');
    }
    assertBranchAllowed(note.branchId);
    await db.goodsNote.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * The GRN a purchase invoice bills, locked FOR UPDATE on the caller's
   * transaction: two invoices billing the same GRN queue here, so it is
   * billed once (TRADE-02). Null when it does not exist.
   */
  async lockForBilling(tx: Prisma.TransactionClient, id: bigint): Promise<GrnBillingSource | null> {
    const { tenantId } = this.support.tenant();
    const [locked] = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM goods_notes WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!locked) return null;
    return this.billingSource(tx, id);
  }

  /**
   * A GRN's received quantity and value per item, without a lock: a posted
   * GRN never changes. A purchase return of the invoice that billed it takes
   * the goods out at this received cost (TRADE-02/03, ADR-016 §3).
   */
  async billingSource(tx: Prisma.TransactionClient, id: bigint): Promise<GrnBillingSource | null> {
    const note = await tx.goodsNote.findFirst({ where: { id }, include: { lines: true } });
    if (!note) return null;
    const byItem = new Map<bigint, { qty: Decimal; value: Decimal }>();
    for (const l of note.lines) {
      const cur = byItem.get(l.itemId) ?? { qty: new Decimal(0), value: new Decimal(0) };
      byItem.set(l.itemId, {
        qty: cur.qty.plus(l.qty.toString()),
        value: cur.value.plus(round3(new Decimal(l.qty.toString()).times(l.unitCost?.toString() ?? 0))),
      });
    }
    return {
      id: note.id,
      docNo: note.docNo,
      status: note.status,
      noteType: note.noteType,
      warehouseId: note.warehouseId,
      byItem,
    };
  }

  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // Lock the document first (§10.1 step 7). As the first statement it also
        // makes every later read see the latest committed state, so two
        // concurrent requests cannot both post or reverse it.
        await tx.$queryRaw`SELECT id FROM goods_notes WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const draft = await tx.goodsNote.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('GoodsNote', id.toString());
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Note is not a draft');
        }
        assertBranchAllowed(draft.branchId);
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Note has no lines');
        }

        const noteDate = new Date(draft.noteDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, noteDate);
        const isGrn = draft.noteType === 'GRN';

        // Lock every (item, warehouse) in the fixed order before any movement.
        await this.ledger.lockForDocument(
          tx,
          companyId,
          draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.warehouseId })),
        );

        let totalCost = new Decimal(0);
        let writeOff = new Decimal(0);
        for (const line of draft.lines) {
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.warehouseId,
            itemId: line.itemId,
            movementDate: noteDate,
            type: isGrn ? 'IN' : 'OUT',
            qty: line.qty.toString(),
            unitCost: isGrn ? (line.unitCost?.toString() ?? undefined) : undefined,
            sourceType: isGrn ? 'GOODS_RECEIPT' : 'GOODS_ISSUE',
            sourceId: draft.id,
            sourceLineId: line.id,
            description: `${draft.noteType} ${draft.id}`,
          });
          totalCost = totalCost.plus(res.totalCost);
          writeOff = writeOff.plus(res.writeOff);
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
          'INVENTORY_ADJUSTMENT',
          'GOODS_RECEIVED_NOT_INVOICED',
        ]);

        const journalLines: JournalLineInput[] = [];
        if (totalCost.gt(0)) {
          if (isGrn) {
            journalLines.push({ accountId: mapping.INVENTORY, debit: totalCost.toString() });
            journalLines.push({
              accountId: mapping.GOODS_RECEIVED_NOT_INVOICED,
              credit: totalCost.toString(),
            });
          } else {
            journalLines.push({ accountId: mapping.INVENTORY_ADJUSTMENT, debit: totalCost.toString() });
            journalLines.push({ accountId: mapping.INVENTORY, credit: totalCost.toString() });
          }
        }
        journalLines.push(
          ...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }),
        );

        const docType = isGrn ? 'GOODS_RECEIPT' : 'GOODS_ISSUE';
        const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, docType, noteDate);
        let entryId: bigint | null = null;
        if (journalLines.length > 0) {
          const entry = await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: noteDate,
            fiscalPeriodId: period.id,
            sourceType: docType,
            sourceId: draft.id,
            branchId: draft.branchId,
            description: draft.description ?? `${draft.noteType} ${docNo}`,
            lines: journalLines,
            postedBy: userId ?? null,
          });
          entryId = entry.id;
        }

        await tx.goodsNote.update({
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
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'goods_note.post',
      entityType: 'goods_note',
      entityId: result.id,
      after: { docNo: result.docNo },
    });
    return this.get(result.id);
  }
}
