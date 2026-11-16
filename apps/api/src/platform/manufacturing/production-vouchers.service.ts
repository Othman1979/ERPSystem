import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertWarehouseBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isStocked } from '../../common/inventory/item-kind.js';
import { findPage } from '../../common/paging/find-page.js';
import { pageWindow } from '../../common/paging/page-query.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { DocumentSupportService, retryOnLockConflict } from '../shared/document-support.service.js';
import { stockWriteOffLines } from '../shared/stock-write-off.js';
import { BomService, type ExplodedLine } from './bom.service.js';
import type { CreateProductionVoucherDto, ListProductionVouchersQueryDto, ProductionLineDto, UpdateProductionVoucherDto } from './dto/production-voucher.dto.js';

type Tx = Prisma.TransactionClient;

/** The stock movements and the journal source of a production voucher (ADR-031 §7). */
const SOURCE = 'PRODUCTION';
const NUMBERING = 'PRODUCTION';

const UNIT_REF = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;
const ITEM_REF = { select: { id: true, code: true, nameAr: true, nameEn: true, itemKind: true, baseUnit: UNIT_REF } } as const;
const ITEM_UNIT_REF = { select: { id: true, factorToBase: true, unit: UNIT_REF } } as const;

const LIST_SELECT = {
  id: true,
  docNo: true,
  status: true,
  voucherDate: true,
  itemId: true,
  bomId: true,
  qty: true,
  itemUnitId: true,
  qtyBase: true,
  materialsWarehouseId: true,
  outputWarehouseId: true,
  outputTotal: true,
  materialsTotal: true,
  appliedTotal: true,
  reversalOfId: true,
  postedAt: true,
  createdAt: true,
  updatedAt: true,
  item: ITEM_REF,
  itemUnit: ITEM_UNIT_REF,
  bom: { select: { id: true, versionNo: true, status: true } },
  materialsWarehouse: { select: { id: true, code: true, nameAr: true } },
  outputWarehouse: { select: { id: true, code: true, nameAr: true } },
} as const;

const DETAIL_SELECT = {
  id: true,
  docNo: true,
  status: true,
  voucherDate: true,
  itemId: true,
  bomId: true,
  qty: true,
  itemUnitId: true,
  qtyBase: true,
  materialsWarehouseId: true,
  outputWarehouseId: true,
  branchId: true,
  costCenterId: true,
  description: true,
  appliedCostPerUnit: true,
  appliedTotal: true,
  materialsTotal: true,
  outputTotal: true,
  outputUnitCost: true,
  journalEntryId: true,
  reversalOfId: true,
  postedAt: true,
  createdAt: true,
  updatedAt: true,
  item: ITEM_REF,
  itemUnit: ITEM_UNIT_REF,
  bom: { select: { id: true, versionNo: true, status: true } },
  materialsWarehouse: { select: { id: true, code: true, nameAr: true } },
  outputWarehouse: { select: { id: true, code: true, nameAr: true } },
  costCenter: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  journalEntry: { select: { id: true, entryNo: true } },
  reversalOf: { select: { id: true, docNo: true, status: true } },
  reversals: { select: { id: true, docNo: true, status: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    select: {
      id: true,
      lineNo: true,
      itemId: true,
      itemUnitId: true,
      qty: true,
      qtyBase: true,
      standardQtyBase: true,
      unitCost: true,
      totalCost: true,
      note: true,
      item: ITEM_REF,
      itemUnit: ITEM_UNIT_REF,
    },
  },
} as const;

/** One consumption line as it is stored (quantities checked, in base units). */
interface ResolvedLine {
  lineNo: number;
  itemId: bigint;
  itemUnitId: bigint | null;
  qty: Decimal;
  qtyBase: Decimal;
  standardQtyBase: Decimal;
  note: string | null;
}

/** The checked content of a draft: header values and lines, computed by the server (ADR-031 §10). */
interface ResolvedVoucher {
  bomId: bigint;
  qty: Decimal;
  itemUnitId: bigint | null;
  qtyBase: Decimal;
  materialsWarehouseId: bigint;
  outputWarehouseId: bigint;
  branchId: bigint | null;
  lines: ResolvedLine[];
}

/** Shortage of one consumption line: stock on hand in the materials warehouse, and a producible hint (ADR-031 §6). */
export interface ProductionShortage {
  availableQtyBase: string;
  shortageQtyBase: string;
  canProduce: boolean;
}

/** One voucher as the API returns it (get, create, update, post, reverse). */
export type ProductionVoucherDetail = Awaited<ReturnType<ProductionVouchersService['get']>>;

/** Production vouchers (ADR-031 §3-§4, §7). */
@Injectable()
export class ProductionVouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly support: DocumentSupportService,
    private readonly boms: BomService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: Tx): Promise<bigint> {
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

  // ------------------------------------------------------------- reads

  /**
   * One numbered page of vouchers (ADR-022), newest first. A voucher belongs to
   * its materials warehouse's branch (ADR-003 §10).
   */
  async list(query: ListProductionVouchersQueryDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const where: Prisma.ProductionVoucherWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.itemId ? { itemId: BigInt(query.itemId) } : {}),
      ...(query.from || query.to
        ? {
            voucherDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [{ materialsWarehouse: branchWhere() }],
    };
    return findPage(db, pageWindow(query), {
      rows: (tx, window) =>
        tx.productionVoucher.findMany({
          where,
          select: LIST_SELECT,
          orderBy: [{ voucherDate: 'desc' }, { id: 'desc' }],
          ...window,
        }),
      count: (tx) => tx.productionVoucher.count({ where }),
    });
  }

  /**
   * One voucher with its lines. A draft also shows each line's shortage in the
   * materials warehouse (ADR-031 §6); a posted voucher shows none (the stock has moved on).
   */
  async get(id: bigint) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const voucher = await db.productionVoucher.findFirst({
      where: { id, companyId, AND: [{ materialsWarehouse: branchWhere() }] },
      select: DETAIL_SELECT,
    });
    if (!voucher) throw DomainError.notFound('ProductionVoucher', id.toString());
    const shortage =
      voucher.status === 'DRAFT'
        ? await this.shortages(db, companyId, voucher.materialsWarehouseId, voucher.lines)
        : null;
    return {
      ...voucher,
      lines: voucher.lines.map((l) => ({ ...l, shortage: shortage?.get(l.itemId.toString()) ?? null })),
    };
  }

  /**
   * Shortage per line: the stock on hand in the materials warehouse against the
   * base quantity, and whether a MANUFACTURED component has an ACTIVE version to produce it.
   */
  private async shortages(
    db: Tx,
    companyId: bigint,
    warehouseId: bigint,
    lines: { itemId: bigint; qtyBase: Prisma.Decimal; item: { itemKind: string } }[],
  ): Promise<Map<string, ProductionShortage>> {
    const itemIds = [...new Set(lines.map((l) => l.itemId))];
    const balances = await db.stockBalance.findMany({
      where: { warehouseId, itemId: { in: itemIds } },
      select: { itemId: true, qtyOnHand: true },
    });
    const onHand = new Map(balances.map((b) => [b.itemId.toString(), new Decimal(b.qtyOnHand.toString())]));
    const manufactured = itemIds.filter((id) => lines.some((l) => l.itemId === id && l.item.itemKind === 'MANUFACTURED'));
    const producible = new Set(
      (
        await db.bom.findMany({
          where: { companyId, itemId: { in: manufactured }, status: 'ACTIVE' },
          select: { itemId: true },
        })
      ).map((b) => b.itemId.toString()),
    );
    const out = new Map<string, ProductionShortage>();
    for (const l of lines) {
      const key = l.itemId.toString();
      const available = onHand.get(key) ?? new Decimal(0);
      const needed = new Decimal(l.qtyBase.toString());
      const missing = Decimal.max(0, needed.minus(available));
      out.set(key, {
        availableQtyBase: round6(available).toFixed(6),
        shortageQtyBase: round6(missing).toFixed(6),
        canProduce: producible.has(key),
      });
    }
    return out;
  }

  // ------------------------------------------------------------- drafts

  /**
   * Creates a DRAFT voucher (ADR-031 §7). Its lines are the actual consumption
   * sent, or the version's standard requirements when none are sent. Nothing is
   * numbered and nothing moves until posting.
   */
  async create(dto: CreateProductionVoucherDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId() ?? null;
    const id = await db.$transaction(async (tx) => {
      const itemId = BigInt(dto.itemId);
      const resolved = await this.resolve(tx, companyId, itemId, dto, dto.bomId === undefined ? null : BigInt(dto.bomId));
      const voucher = await tx.productionVoucher.create({
        data: {
          tenantId,
          companyId,
          status: 'DRAFT',
          voucherDate: new Date(dto.voucherDate),
          itemId,
          bomId: resolved.bomId,
          qty: resolved.qty,
          itemUnitId: resolved.itemUnitId,
          qtyBase: resolved.qtyBase,
          materialsWarehouseId: resolved.materialsWarehouseId,
          outputWarehouseId: resolved.outputWarehouseId,
          branchId: resolved.branchId,
          costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
          description: dto.description ?? null,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      await tx.productionVoucherLine.createMany({ data: lineRows(tenantId, voucher.id, resolved.lines) });
      return voucher.id;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({ action: 'production.create', entityType: 'production_voucher', entityId: id, after: { itemId: dto.itemId } });
    return this.get(id);
  }

  /** Replaces a DRAFT's content. A posted voucher is never changed (ADR-031 §7). */
  async update(id: bigint, dto: UpdateProductionVoucherDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId() ?? null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_vouchers WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      const current = await this.draftHead(tx, companyId, id);
      const resolved = await this.resolve(
        tx,
        companyId,
        current.itemId,
        dto,
        dto.bomId === undefined ? current.bomId : BigInt(dto.bomId),
      );
      await tx.productionVoucherLine.deleteMany({ where: { voucherId: id } });
      await tx.productionVoucher.update({
        where: { id },
        data: {
          voucherDate: new Date(dto.voucherDate),
          bomId: resolved.bomId,
          qty: resolved.qty,
          itemUnitId: resolved.itemUnitId,
          qtyBase: resolved.qtyBase,
          materialsWarehouseId: resolved.materialsWarehouseId,
          outputWarehouseId: resolved.outputWarehouseId,
          branchId: resolved.branchId,
          costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
          description: dto.description ?? null,
          updatedBy: userId,
        },
      });
      await tx.productionVoucherLine.createMany({ data: lineRows(tenantId, id, resolved.lines) });
    }, POSTING_TX_OPTIONS);
    await this.audit.log({ action: 'production.update', entityType: 'production_voucher', entityId: id, after: null });
    return this.get(id);
  }

  /** Deletes a DRAFT voucher and its lines. */
  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_vouchers WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      await this.draftHead(tx, companyId, id);
      await tx.productionVoucherLine.deleteMany({ where: { voucherId: id } });
      await tx.productionVoucher.delete({ where: { id } });
    }, POSTING_TX_OPTIONS);
    await this.audit.log({ action: 'production.delete', entityType: 'production_voucher', entityId: id, after: null });
    return { deleted: true as const };
  }

  // ------------------------------------------------------------- posting

  /**
   * Posts a DRAFT voucher in one transaction (ADR-031 §7): the materials leave
   * at the weighted average, the output enters at materials + applied cost, the
   * journal is written and the MFG number is allocated here, not at the draft.
   */
  async post(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();
    const result = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        // The voucher row first: two requests on one voucher queue here (as adjustments do).
        await tx.$queryRaw`SELECT id FROM production_vouchers WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        return this.postLocked(tx, companyId, id, userId);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'production.post', entityType: 'production_voucher', entityId: result.id, after: { docNo: result.docNo } });
    return this.get(result.id);
  }

  /** The posting itself, on a transaction that already holds the voucher's row lock. */
  async postLocked(tx: Prisma.TransactionClient, companyId: bigint, id: bigint, userId: bigint | undefined): Promise<{ id: bigint; docNo: string }> {
    const { tenantId } = this.tenant();
    const draft = await tx.productionVoucher.findFirst({
      where: { id, companyId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!draft) throw DomainError.notFound('ProductionVoucher', id.toString());
    if (draft.status !== 'DRAFT') throw new DomainError(ErrorCode.PRODUCTION_NOT_DRAFT, 'Production voucher is not a draft', { status: draft.status });
    if (draft.lines.length === 0) throw new DomainError(ErrorCode.VALIDATION, 'Production voucher has no lines');
    const branchId = await assertWarehouseBranchAllowed(tx, draft.materialsWarehouseId);
    await assertWarehouseBranchAllowed(tx, draft.outputWarehouseId);
    // The version the voucher was made with: its applied cost is read now (the snapshot).
    const bom = await tx.bom.findFirst({ where: { id: draft.bomId, companyId }, select: { status: true, appliedCostPerUnit: true } });
    if (!bom || bom.status === 'DRAFT') throw new DomainError(ErrorCode.BOM_NOT_ACTIVE, 'The bill of materials of this voucher is not active');

    const voucherDate = new Date(draft.voucherDate);
    const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, voucherDate);

    // Every (item, warehouse) pair before the first movement (fixed order, posting-transactions guard).
    await this.ledger.lockForDocument(tx, companyId, [
      ...draft.lines.map((l) => ({ itemId: l.itemId, warehouseId: draft.materialsWarehouseId })),
      { itemId: draft.itemId, warehouseId: draft.outputWarehouseId },
    ]);

    // Materials out at the weighted average (ADR-031 §7).
    let materialsTotal = new Decimal(0);
    let writeOff = new Decimal(0);
    for (const line of draft.lines) {
      const res = await this.ledger.applyMovement(tx, companyId, {
        warehouseId: draft.materialsWarehouseId,
        itemId: line.itemId,
        movementDate: voucherDate,
        type: 'OUT',
        qty: line.qtyBase.toString(),
        sourceType: SOURCE,
        sourceId: draft.id,
        sourceLineId: line.id,
      });
      materialsTotal = materialsTotal.plus(res.totalCost.toString());
      writeOff = writeOff.plus(res.writeOff.toString());
      await tx.productionVoucherLine.update({
        where: { id: line.id },
        data: { unitCost: res.unitCost.toString(), totalCost: res.totalCost.toString() },
      });
    }

    // Applied cost: the version's amount per unit times the produced base quantity (ADR-031 §2).
    const appliedPerUnit = new Decimal(bom.appliedCostPerUnit.toString());
    const qtyBase = new Decimal(draft.qtyBase.toString());
    const appliedTotal = round3(appliedPerUnit.times(qtyBase));
    const outputTotal = round3(materialsTotal.plus(appliedTotal));
    const outputUnitCost = round6(outputTotal.div(qtyBase));

    // The output enters at the total (its unit cost is the total over the base quantity).
    const produced = await this.ledger.applyMovement(tx, companyId, {
      warehouseId: draft.outputWarehouseId,
      itemId: draft.itemId,
      movementDate: voucherDate,
      type: 'IN',
      qty: qtyBase.toString(),
      totalCost: outputTotal.toString(),
      sourceType: SOURCE,
      sourceId: draft.id,
      sourceLineId: null,
    });
    writeOff = writeOff.plus(produced.writeOff.toString());

    const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
      'INVENTORY',
      'INVENTORY_ADJUSTMENT',
      'PRODUCTION_APPLIED_COST',
    ]);
    const journalLines: JournalLineInput[] = [];
    if (outputTotal.gt(0)) journalLines.push({ accountId: mapping.INVENTORY, debit: outputTotal.toString(), description: 'Production output' });
    if (materialsTotal.gt(0)) journalLines.push({ accountId: mapping.INVENTORY, credit: materialsTotal.toString(), description: 'Production materials' });
    if (appliedTotal.gt(0)) {
      // The voucher's cost centre sits on this line only (ADR-031 §7).
      journalLines.push({
        accountId: mapping.PRODUCTION_APPLIED_COST,
        credit: appliedTotal.toString(),
        description: 'Applied production cost',
        costCenterId: draft.costCenterId,
      });
    }
    journalLines.push(...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }));

    const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, NUMBERING, voucherDate);
    let entryId: bigint | null = null;
    if (journalLines.length > 0) {
      const entry = await this.posting.postEntry(tx, {
        tenantId,
        companyId,
        entryDate: voucherDate,
        fiscalPeriodId: period.id,
        branchId,
        sourceType: SOURCE,
        sourceId: draft.id,
        description: draft.description ?? `Production ${docNo}`,
        lines: journalLines,
        postedBy: userId ?? null,
      });
      entryId = entry.id;
    }

    await tx.productionVoucher.update({
      where: { id: draft.id },
      data: {
        status: 'POSTED',
        docNo,
        journalEntryId: entryId,
        postedAt: new Date(),
        postedBy: userId ?? null,
        updatedBy: userId ?? null,
        appliedCostPerUnit: appliedPerUnit.toFixed(3),
        appliedTotal: appliedTotal.toFixed(3),
        materialsTotal: materialsTotal.toFixed(3),
        outputTotal: outputTotal.toFixed(3),
        outputUnitCost: outputUnitCost.toFixed(6),
      },
    });
    return { id: draft.id, docNo };
  }

  // ------------------------------------------------------------- reversal

  /**
   * Reverses a POSTED voucher while its output is still on hand (ADR-031 §4):
   * a new voucher dated today takes the output out and puts the materials back
   * at their original cost, and a reversal journal entry mirrors the original.
   * Refused (PRODUCTION_OUTPUT_CONSUMED) when the output on hand is below the
   * produced quantity, even when negative stock is allowed.
   */
  async reverse(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();
    const reversalDate = await this.support.companyTodayDate();
    const result = await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM production_vouchers WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        return this.reverseLocked(tx, companyId, id, userId, reversalDate);
      }, POSTING_TX_OPTIONS),
    );
    await this.audit.log({ action: 'production.reverse', entityType: 'production_voucher', entityId: result.id, after: { docNo: result.docNo } });
    return this.get(result.id);
  }

  /** The reversal itself, on a transaction that already holds the voucher's row lock. */
  async reverseLocked(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    id: bigint,
    userId: bigint | undefined,
    reversalDate: Date,
  ): Promise<{ id: bigint; docNo: string }> {
    const { tenantId } = this.tenant();
    const original = await tx.productionVoucher.findFirst({
      where: { id, companyId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!original) throw DomainError.notFound('ProductionVoucher', id.toString());
    const branchId = await assertWarehouseBranchAllowed(tx, original.materialsWarehouseId);
    if (original.status !== 'POSTED') throw new DomainError(ErrorCode.PRODUCTION_NOT_POSTED, 'Only a posted production voucher can be reversed', { status: original.status });
    // A reversal has no reversal of its own (ADR-031 §4).
    if (original.reversalOfId !== null) throw new DomainError(ErrorCode.PRODUCTION_REVERSAL_NOT_REVERSIBLE, 'A reversal voucher cannot be reversed');
    const existing = await tx.productionVoucher.findFirst({ where: { reversalOfId: original.id }, select: { id: true } });
    if (existing) throw new DomainError(ErrorCode.PRODUCTION_ALREADY_REVERSED, 'Production voucher already reversed');

    const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, reversalDate);
    await this.ledger.lockForDocument(tx, companyId, [
      ...original.lines.map((l) => ({ itemId: l.itemId, warehouseId: original.materialsWarehouseId })),
      { itemId: original.itemId, warehouseId: original.outputWarehouseId },
    ]);

    // The output must still be on hand, read under the lock (ADR-031 §4), whatever the negative-stock setting.
    const onHand = this.ledger.lockedQtyOnHand(tx, original.outputWarehouseId, original.itemId);
    const producedBase = new Decimal(original.qtyBase.toString());
    if (onHand.lt(producedBase)) {
      throw new DomainError(ErrorCode.PRODUCTION_OUTPUT_CONSUMED, 'Part of the output has been sold or used', {
        itemId: original.itemId.toString(),
        onHand: round6(onHand).toString(),
        required: round6(producedBase).toString(),
      });
    }

    // The original movements: the output's IN and each component's OUT, at their cost.
    const origMoves = await tx.stockMovement.findMany({
      where: { tenantId, sourceType: SOURCE, sourceId: original.id },
      select: { id: true, itemId: true, movementType: true, sourceLineId: true, unitCost: true, totalCost: true },
    });
    const outputIn = origMoves.find((m) => m.movementType === 'IN' && m.itemId === original.itemId);
    if (!outputIn) throw new DomainError(ErrorCode.INTERNAL, 'Production output movement not found', { id: original.id.toString() });
    const componentOut = new Map(
      origMoves.filter((m) => m.movementType === 'OUT' && m.sourceLineId !== null).map((m) => [m.sourceLineId!, m]),
    );

    const reversal = await tx.productionVoucher.create({
      data: {
        tenantId,
        companyId,
        status: 'POSTED',
        voucherDate: reversalDate,
        itemId: original.itemId,
        bomId: original.bomId,
        qty: original.qty,
        itemUnitId: original.itemUnitId,
        qtyBase: original.qtyBase,
        materialsWarehouseId: original.materialsWarehouseId,
        outputWarehouseId: original.outputWarehouseId,
        branchId: original.branchId,
        costCenterId: original.costCenterId,
        description: `Reversal of ${original.docNo ?? original.id}`,
        reversalOfId: original.id,
        appliedCostPerUnit: original.appliedCostPerUnit,
        appliedTotal: 0,
        postedAt: new Date(),
        postedBy: userId ?? null,
        createdBy: userId ?? null,
        updatedBy: userId ?? null,
      },
      select: { id: true },
    });

    // The output leaves first, at the cost it entered with (ADR-031 §4).
    const productOut = await this.ledger.applyMovement(tx, companyId, {
      warehouseId: original.outputWarehouseId,
      itemId: original.itemId,
      movementDate: reversalDate,
      type: 'OUT',
      qty: producedBase.toString(),
      unitCost: outputIn.unitCost.toString(),
      totalCost: outputIn.totalCost.toString(),
      sourceType: SOURCE,
      sourceId: reversal.id,
      sourceLineId: null,
      reversalOfId: outputIn.id,
    });
    let writeOff = productOut.writeOff;

    // Each material comes back at the cost it left with.
    let materialsBack = new Decimal(0);
    for (const line of original.lines) {
      const out = componentOut.get(line.id);
      if (!out) throw new DomainError(ErrorCode.INTERNAL, 'Production material movement not found', { lineId: line.id.toString() });
      const reversalLine = await tx.productionVoucherLine.create({
        data: {
          tenantId,
          voucherId: reversal.id,
          lineNo: line.lineNo,
          itemId: line.itemId,
          itemUnitId: line.itemUnitId,
          qty: line.qty,
          qtyBase: line.qtyBase,
          standardQtyBase: line.standardQtyBase,
          note: line.note,
        },
        select: { id: true },
      });
      const back = await this.ledger.applyMovement(tx, companyId, {
        warehouseId: original.materialsWarehouseId,
        itemId: line.itemId,
        movementDate: reversalDate,
        type: 'IN',
        qty: line.qtyBase.toString(),
        unitCost: out.unitCost.toString(),
        totalCost: out.totalCost.toString(),
        sourceType: SOURCE,
        sourceId: reversal.id,
        sourceLineId: reversalLine.id,
        reversalOfId: out.id,
      });
      materialsBack = materialsBack.plus(back.totalCost.toString());
      writeOff = writeOff.plus(back.writeOff.toString());
      await tx.productionVoucherLine.update({
        where: { id: reversalLine.id },
        data: { unitCost: back.unitCost.toString(), totalCost: back.totalCost.toString() },
      });
    }

    const outputTotal = new Decimal(productOut.totalCost.toString());
    const appliedTotal = new Decimal(original.appliedTotal.toString());
    const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
      'INVENTORY',
      'INVENTORY_ADJUSTMENT',
      'PRODUCTION_APPLIED_COST',
    ]);
    const journalLines: JournalLineInput[] = [];
    if (materialsBack.gt(0)) journalLines.push({ accountId: mapping.INVENTORY, debit: materialsBack.toString(), description: 'Production materials back' });
    if (appliedTotal.gt(0)) {
      journalLines.push({
        accountId: mapping.PRODUCTION_APPLIED_COST,
        debit: appliedTotal.toString(),
        description: 'Applied production cost reversed',
        costCenterId: original.costCenterId,
      });
    }
    if (outputTotal.gt(0)) journalLines.push({ accountId: mapping.INVENTORY, credit: outputTotal.toString(), description: 'Production output out' });
    journalLines.push(...stockWriteOffLines(writeOff, { inventory: mapping.INVENTORY, adjustment: mapping.INVENTORY_ADJUSTMENT }));

    const docNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, NUMBERING, reversalDate);
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
        description: `Reversal of production ${original.docNo ?? original.id}`,
        lines: journalLines,
        postedBy: userId ?? null,
      });
      entryId = entry.id;
    }

    await tx.productionVoucher.update({
      where: { id: reversal.id },
      data: {
        docNo,
        journalEntryId: entryId,
        materialsTotal: materialsBack.toFixed(3),
        outputTotal: outputTotal.toFixed(3),
        appliedTotal: appliedTotal.toFixed(3),
        outputUnitCost: new Decimal(productOut.unitCost.toString()).toFixed(6),
      },
    });
    return { id: reversal.id, docNo };
  }

  // ------------------------------------------------------------- helpers

  /** The voucher's head, checked to be a draft of this company (read under the caller's row lock). */
  private async draftHead(tx: Tx, companyId: bigint, id: bigint) {
    const head = await tx.productionVoucher.findFirst({
      where: { id, companyId },
      select: { id: true, itemId: true, bomId: true, status: true },
    });
    if (!head) throw DomainError.notFound('ProductionVoucher', id.toString());
    if (head.status !== 'DRAFT') throw new DomainError(ErrorCode.PRODUCTION_NOT_DRAFT, 'Only a draft production voucher can be changed', { status: head.status });
    return head;
  }

  /**
   * Checks an incoming draft against the database and computes base quantities
   * (ADR-031 §10): the produced item (MANUFACTURED), its version, the warehouses
   * and the consumption lines. Without lines, the version's standard requirements.
   */
  private async resolve(
    tx: Tx,
    companyId: bigint,
    itemId: bigint,
    dto: CreateProductionVoucherDto | UpdateProductionVoucherDto,
    bomId: bigint | null,
  ): Promise<ResolvedVoucher> {
    const item = await tx.item.findFirst({
      where: { companyId, id: itemId },
      select: { id: true, code: true, itemKind: true, isActive: true, baseUnitId: true },
    });
    if (!item || !item.isActive) throw DomainError.notFound('Item', itemId.toString());
    if (item.itemKind !== 'MANUFACTURED') {
      throw new DomainError(ErrorCode.BOM_ITEM_NOT_MANUFACTURED, `Item ${item.code} is not a manufactured item`);
    }

    const producedUnit = await this.unitOf(tx, itemId, dto.itemUnitId);
    const qty = new Decimal(dto.qty);
    if (!qty.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'The produced quantity must be greater than zero');
    const qtyBase = round6(qty.times(producedUnit.factor));
    if (!qtyBase.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'The produced quantity must be greater than zero');

    if (dto.costCenterId !== undefined) {
      const centre = await tx.costCenter.findFirst({
        where: { id: BigInt(dto.costCenterId), companyId },
        select: { id: true, isActive: true, isPostable: true },
      });
      if (!centre) throw DomainError.notFound('CostCenter', dto.costCenterId);
      if (!centre.isActive) throw new DomainError(ErrorCode.COST_CENTER_INACTIVE, 'The cost centre is inactive', { costCenterId: dto.costCenterId });
      if (!centre.isPostable) throw new DomainError(ErrorCode.COST_CENTER_NOT_POSTABLE, 'The cost centre takes no lines', { costCenterId: dto.costCenterId });
    }

    const materials = await this.warehouseOf(tx, companyId, dto.materialsWarehouseId);
    const output = dto.outputWarehouseId === undefined ? materials : await this.warehouseOf(tx, companyId, dto.outputWarehouseId);

    // The version: the given one (ACTIVE or INACTIVE, never a draft), else the item's ACTIVE one.
    const version = await tx.bom.findFirst({
      where: bomId !== null ? { id: bomId, itemId, companyId } : { itemId, companyId, status: 'ACTIVE' },
      select: { id: true, status: true },
    });
    if (!version) {
      if (bomId !== null) throw DomainError.notFound('Bom', bomId.toString());
      throw new DomainError(ErrorCode.BOM_NOT_ACTIVE, 'This item has no active bill of materials', { itemId: itemId.toString() });
    }
    if (version.status === 'DRAFT') throw new DomainError(ErrorCode.BOM_NOT_ACTIVE, 'A draft bill of materials cannot be produced from', { bomId: version.id.toString() });
    const explosion = await this.boms.explode(tx, itemId, qtyBase, version.id);
    const standardBy = new Map<bigint, ExplodedLine>(explosion.lines.map((l) => [l.componentItemId, l]));
    const bomUnits = new Map(
      (
        await tx.bomLine.findMany({
          where: { bomId: version.id },
          select: { componentItemId: true, itemUnitId: true, itemUnit: { select: { factorToBase: true } } },
        })
      ).map((l) => [l.componentItemId, l]),
    );

    let lines: ResolvedLine[];
    if (dto.lines === undefined) {
      // Standard requirements, in each component's line unit (ADR-031 §3).
      lines = explosion.lines.map((l, index) => {
        const bl = bomUnits.get(l.componentItemId);
        const factor = bl?.itemUnit ? new Decimal(bl.itemUnit.factorToBase.toString()) : new Decimal(1);
        return {
          lineNo: index + 1,
          itemId: l.componentItemId,
          itemUnitId: bl?.itemUnitId ?? null,
          qty: round6(new Decimal(l.requiredQtyBase.toString()).div(factor)),
          qtyBase: l.requiredQtyBase,
          standardQtyBase: l.requiredQtyBase,
          note: null,
        };
      });
    } else {
      lines = await this.actualLines(tx, companyId, itemId, dto.lines, standardBy);
    }
    if (lines.length === 0) throw new DomainError(ErrorCode.VALIDATION, 'A production voucher needs at least one component line');

    return {
      bomId: version.id,
      qty: round6(qty),
      itemUnitId: producedUnit.id,
      qtyBase,
      materialsWarehouseId: materials.id,
      outputWarehouseId: output.id,
      branchId: materials.branchId,
      lines,
    };
  }

  /** The actual lines a client sent: stocked components, once each, quantities converted, standards from the version. */
  private async actualLines(
    tx: Tx,
    companyId: bigint,
    producedItemId: bigint,
    input: ProductionLineDto[],
    standardBy: Map<bigint, ExplodedLine>,
  ): Promise<ResolvedLine[]> {
    const ids = input.map((l) => BigInt(l.itemId));
    const items = await tx.item.findMany({
      where: { companyId, id: { in: [...new Set(ids)] } },
      select: { id: true, code: true, itemKind: true, isActive: true, baseUnitId: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    const seen = new Set<bigint>();
    const out: ResolvedLine[] = [];
    for (const [index, l] of input.entries()) {
      const itemId = BigInt(l.itemId);
      const lineNo = index + 1;
      const component = byId.get(itemId);
      if (!component) throw DomainError.notFound('Item', l.itemId);
      if (itemId === producedItemId) throw new DomainError(ErrorCode.VALIDATION, 'An item cannot be its own component', { lineNo });
      if (!isStocked(component.itemKind)) throw new DomainError(ErrorCode.VALIDATION, `Item ${component.code} is a service`, { lineNo });
      if (!component.isActive) throw DomainError.notFound('Item', l.itemId);
      if (seen.has(itemId)) throw new DomainError(ErrorCode.VALIDATION, 'A component appears on two lines', { lineNo });
      seen.add(itemId);
      const unit = await this.unitOf(tx, itemId, l.itemUnitId);
      const qty = new Decimal(l.qty);
      if (!qty.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'A component quantity must be greater than zero', { lineNo });
      const qtyBase = round6(qty.times(unit.factor));
      out.push({
        lineNo,
        itemId,
        itemUnitId: unit.id,
        qty: round6(qty),
        qtyBase,
        standardQtyBase: standardBy.has(itemId) ? round6(standardBy.get(itemId)!.requiredQtyBase) : new Decimal(0),
        note: l.note ?? null,
      });
    }
    return out;
  }

  /** The unit an input names (checked to belong to the item), or the item's base unit (null, factor 1). */
  private async unitOf(tx: Tx, itemId: bigint, itemUnitId: string | undefined): Promise<{ id: bigint | null; factor: Decimal }> {
    if (itemUnitId === undefined) return { id: null, factor: new Decimal(1) };
    const unit = await tx.itemUnit.findFirst({ where: { id: BigInt(itemUnitId) }, select: { id: true, itemId: true, factorToBase: true } });
    if (!unit || unit.itemId !== itemId) throw new DomainError(ErrorCode.BOM_UNIT_INVALID, 'The unit does not belong to the item', { itemUnitId });
    return { id: unit.id, factor: new Decimal(unit.factorToBase.toString()) };
  }

  /** An active warehouse of the company, in the caller's branches (ADR-003). */
  private async warehouseOf(tx: Tx, companyId: bigint, warehouseId: string) {
    const wh = await tx.warehouse.findFirst({
      where: { id: BigInt(warehouseId), companyId, isActive: true },
      select: { id: true, branchId: true },
    });
    if (!wh) throw DomainError.notFound('Warehouse', warehouseId);
    await assertWarehouseBranchAllowed(tx, wh.id);
    return wh;
  }
}

/** Line rows for createMany (the tenant scope is added by the scoped client). */
function lineRows(tenantId: bigint, voucherId: bigint, lines: ResolvedLine[]) {
  return lines.map((l) => ({
    tenantId,
    voucherId,
    lineNo: l.lineNo,
    itemId: l.itemId,
    itemUnitId: l.itemUnitId,
    qty: l.qty,
    qtyBase: l.qtyBase,
    standardQtyBase: l.standardQtyBase,
    note: l.note,
  }));
}
