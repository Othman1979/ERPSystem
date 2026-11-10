import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertWarehouseBranchAllowed } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type { CreateGoodsNoteDto } from './dto/goods-notes.dto.js';

/**
 * Goods notes — GRN (استلام بضاعة) and GIN (صرف بضاعة): stock movements
 * without an invoice (§7.4-style documents).
 *  GRN: Dr INVENTORY / Cr GOODS_RECEIVED_NOT_INVOICED (2104)
 *  GIN: Dr INVENTORY_ADJUSTMENT / Cr INVENTORY
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
      select: { id: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);

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
    });
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
    const warehouse = await db.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);

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
    });
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
    await db.goodsNote.delete({ where: { id } });
    return { deleted: true };
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
        await assertWarehouseBranchAllowed(tx, draft.warehouseId);
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Note is not a draft');
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Note has no lines');
        }

        const noteDate = new Date(draft.noteDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, noteDate);
        const isGrn = draft.noteType === 'GRN';

        let totalCost = new Decimal(0);
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

        const docType = isGrn ? 'GOODS_RECEIPT' : 'GOODS_ISSUE';
        const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, docType, noteDate);
        let entryId: bigint | null = null;
        if (journalLines.length > 0) {
          const entryNo = await this.posting.allocateEntryNo(
            tx, tenantId, companyId, 'JOURNAL_ENTRY', noteDate,
          );
          const entry = await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: noteDate,
            fiscalPeriodId: period.id,
            entryNo,
            sourceType: docType,
            sourceId: draft.id,
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
      }),
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
