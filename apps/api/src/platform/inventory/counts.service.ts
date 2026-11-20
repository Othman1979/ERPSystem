import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertWarehouseBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, round6, sum } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { withLineCounts } from '../../common/paging/line-counts.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { OWNER_ROLE } from '../../common/permissions/member-permissions.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { DocumentSupportService, retryOnLockConflict } from '../shared/document-support.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import { readSheetRows, type UploadedSheet } from './count-sheet-import.js';
import type {
  AddCountLineDto,
  CreateStockCountDto,
  ScanCountDto,
  UpdateCountLineDto,
} from './dto/inventory.dto.js';
import type { ListStockCountsQueryDto } from './dto/list-queries.dto.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { isStocked, stockedItemKindFilter, assertNotRecipe } from '../../common/inventory/item-kind.js';
import { currentCompanyFilter } from '../../common/cls/current-company.js';

/** The item fields a count line shows. */
const ITEM_REF = { select: { id: true, code: true, nameAr: true, baseUnitId: true } } as const;
/** A count line with its item and the unit the counter entered (null = base unit). */
const LINE_INCLUDE = {
  item: ITEM_REF,
  itemUnit: { include: { unit: { select: { code: true, nameAr: true } } } },
} as const;

/** The quantity of one counted line, in base and entered units (ADR-030 §8). */
interface CountedQuantity {
  base: Decimal;
  unitQty: Decimal;
  itemUnitId: bigint | null;
}

/** A DRAFT count hides its book qty and difference from everyone (blind count, ADR-030 §6). */
function isBlindDraft(count: { status: string; blind: boolean }): boolean {
  return count.status === 'DRAFT' && count.blind;
}

/** A line with the book qty and difference withheld. */
function maskLine<L extends { systemQty: unknown; differenceQty: unknown }>(line: L): L {
  return { ...line, systemQty: null, differenceQty: null };
}

/** Column values of a counted line: the base quantity, the entered one and the difference (null clears the count). */
function countedData(q: CountedQuantity | null, systemQty: Decimal, userId: bigint | null, now: Date) {
  if (!q) {
    return { countedQty: null, countedUnitQty: null, itemUnitId: null, differenceQty: null, countedBy: null, countedAt: null };
  }
  return {
    countedQty: q.base.toString(),
    countedUnitQty: q.unitQty.toString(),
    itemUnitId: q.itemUnitId,
    differenceQty: q.base.minus(systemQty).toString(),
    countedBy: userId,
    countedAt: now,
  };
}

/**
 * Physical stock counts (ADR-028 §2, ADR-030): a count snapshots its scope
 * with the book qty at the count date, counters enter quantities (by hand,
 * by barcode or from an Excel sheet), the count is submitted and then
 * approved by someone else. Approval posts ONE COUNT_ADJUSTMENT, dated the
 * approval day, through AdjustmentsService, so the stock movements and the
 * journal follow the same rules as every other stock document.
 */
@Injectable()
export class CountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly adjustments: AdjustmentsService,
    private readonly audit: AuditService,
    private readonly support: DocumentSupportService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: ReturnType<PrismaService['forTenant']>): Promise<bigint> {
    const company = await db.company.findFirst({
      where: { isActive: true, ...currentCompanyFilter() },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  private userId(): bigint | null {
    return ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
  }

  private isOwner(): boolean {
    return ClsServiceManager.getClsService<RequestContext>().get('roleCode') === OWNER_ROLE;
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

  /**
   * One count with its warehouse and lines; another branch's answers 404 like
   * another tenant's (ADR-003 §11). A blind draft shows no book qty (§6).
   */
  async get(id: bigint) {
    const { db } = this.tenant();
    const count = await db.stockCount.findFirst({
      where: { id, AND: [{ warehouse: branchWhere() }] },
      include: {
        warehouse: true,
        lines: { orderBy: { itemId: 'asc' }, include: LINE_INCLUDE },
      },
    });
    if (!count) throw DomainError.notFound('StockCount', id.toString());
    const counters = await db.stockCountCounter.findMany({
      where: { countId: id },
      orderBy: { id: 'asc' },
      select: { userId: true },
    });
    const detail = { ...count, counterIds: counters.map((c) => c.userId.toString()) };
    return isBlindDraft(count) ? { ...detail, lines: count.lines.map(maskLine) } : detail;
  }

  /**
   * Creates a DRAFT count for the scope (ADR-030 §7). Every line snapshots the
   * book qty at the count date. A WAREHOUSE count takes the items with a book
   * balance there, or every stocked item with `includeZero`; a GROUP count takes
   * the group and its subgroups; an ITEMS count takes the chosen items.
   */
  async create(dto: CreateStockCountDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();
    const scope = dto.scope ?? 'WAREHOUSE';
    const countDate = DateOnly.of(dto.countDate);
    const today = await this.support.companyTodayDate();
    if (countDate.getTime() > today.getTime()) {
      throw new DomainError(ErrorCode.VALIDATION, 'The count date cannot be in the future', { countDate: dto.countDate });
    }

    const scopeItems = await this.scopeWhere(db, scope, dto);
    const count = await db.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.findFirst({
        where: { id: BigInt(dto.warehouseId), companyId, isActive: true },
      });
      if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);
      await assertWarehouseBranchAllowed(tx, warehouse.id);

      const stocked = await tx.item.findMany({
        where: { tenantId, companyId, itemKind: stockedItemKindFilter(), isActive: true, ...scopeItems },
        select: { id: true },
      });
      const scopedIds = new Set(stocked.map((i) => i.id));
      if (scope === 'ITEMS' && scopedIds.size !== new Set((dto.itemIds ?? []).map((x) => BigInt(x))).size) {
        throw new DomainError(ErrorCode.VALIDATION, 'One or more items are not active stock items');
      }
      const book = await this.bookAt(tx, tenantId, warehouse.id, countDate);
      const includeZero = scope === 'WAREHOUSE' && (dto.includeZero ?? false);
      let itemIds = [...scopedIds];
      if (scope === 'WAREHOUSE' && !includeZero) {
        itemIds = itemIds.filter((itemId) => !(book.get(itemId) ?? new Decimal(0)).isZero());
      }
      if (itemIds.length === 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'The count scope has no stock items to count');
      }

      const created = await tx.stockCount.create({
        data: {
          tenantId,
          companyId,
          warehouseId: warehouse.id,
          countDate,
          description: dto.description ?? null,
          blind: dto.blind ?? false,
          scope,
          itemGroupId: scope === 'GROUP' ? BigInt(dto.itemGroupId!) : null,
          includeZero,
          createdBy: userId,
        },
      });
      await tx.stockCountLine.createMany({
        data: itemIds.map((itemId) => ({
          tenantId,
          countId: created.id,
          itemId,
          systemQty: (book.get(itemId) ?? new Decimal(0)).toString(),
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);

    await this.audit.log({
      action: 'stock_count.create',
      entityType: 'stock_count',
      entityId: count.id,
      after: { warehouseId: count.warehouseId.toString(), scope },
    });
    return this.get(count.id);
  }

  /**
   * The item filter of a count scope (ADR-030 §7): the chosen items, the group
   * with its subgroups, or every item (WAREHOUSE, narrowed later by the book).
   */
  private async scopeWhere(
    db: ReturnType<PrismaService['forTenant']>,
    scope: 'WAREHOUSE' | 'GROUP' | 'ITEMS',
    dto: CreateStockCountDto,
  ): Promise<Prisma.ItemWhereInput> {
    if (scope === 'ITEMS') {
      if (!dto.itemIds?.length) throw new DomainError(ErrorCode.VALIDATION, 'itemIds are required for an ITEMS count');
      const ids = [...new Set(dto.itemIds)].map((x) => BigInt(x));
      // ADR-032 §5: a recipe is not counted; refuse it by name instead of skipping it.
      const recipe = await db.item.findFirst({ where: { id: { in: ids }, itemKind: 'RECIPE' }, select: { code: true } });
      if (recipe) throw new DomainError(ErrorCode.RECIPE_NOT_STOCKED, `Item ${recipe.code} is a recipe: it is not counted`);
      return { id: { in: ids } };
    }
    if (scope === 'GROUP') {
      if (!dto.itemGroupId) throw new DomainError(ErrorCode.VALIDATION, 'itemGroupId is required for a GROUP count');
      const groupId = BigInt(dto.itemGroupId);
      const group = await db.itemGroup.findFirst({ where: { id: groupId }, select: { id: true } });
      if (!group) throw DomainError.notFound('ItemGroup', dto.itemGroupId);
      return { itemGroupId: { in: await this.groupTree(db, groupId) } };
    }
    return {};
  }

  /** A group and all its descendants (ADR-030 §7: a group count includes its subgroups). */
  private async groupTree(db: ReturnType<PrismaService['forTenant']>, rootId: bigint): Promise<bigint[]> {
    const groups = await db.itemGroup.findMany({ select: { id: true, parentId: true } });
    const children = new Map<string, bigint[]>();
    for (const g of groups) {
      if (g.parentId === null) continue;
      const key = g.parentId.toString();
      const siblings = children.get(key);
      if (siblings) siblings.push(g.id);
      else children.set(key, [g.id]);
    }
    const found: bigint[] = [];
    const queue = [rootId];
    while (queue.length > 0) {
      const next = queue.shift()!;
      found.push(next);
      queue.push(...(children.get(next.toString()) ?? []));
    }
    return found;
  }

  /**
   * Deletes a DRAFT count. The count is locked first, so a scan or a submit that
   * races the delete waits for it, and DRAFT status and the branch are re-read
   * under that lock before the row goes (its lines and counters cascade).
   */
  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.tenant();
    await db.$transaction(async (tx) => {
      await this.lockedDraft(tx, tenantId, id);
      await tx.stockCount.delete({ where: { id } });
    }, POSTING_TX_OPTIONS);
    return { deleted: true };
  }

  /**
   * Adds an item found on the shelf to a DRAFT count (ADR-030 §7). Its book qty
   * is read at the count date like the other lines.
   */
  async addLine(countId: bigint, dto: AddCountLineDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.$transaction(async (tx) => {
      const count = await this.lockedDraft(tx, tenantId, countId);
      const item = await tx.item.findFirst({
        where: { id: BigInt(dto.itemId), tenantId, companyId, itemKind: stockedItemKindFilter(), isActive: true },
      });
      if (!item) {
        const recipe = await tx.item.findFirst({
          where: { id: BigInt(dto.itemId), tenantId, companyId, itemKind: 'RECIPE' },
          select: { code: true },
        });
        if (recipe) throw new DomainError(ErrorCode.RECIPE_NOT_STOCKED, `Item ${recipe.code} is a recipe: it is not counted`);
        throw new DomainError(ErrorCode.VALIDATION, 'The item is not an active stock item');
      }
      const exists = await tx.stockCountLine.findFirst({ where: { countId, itemId: item.id } });
      if (exists) throw new DomainError(ErrorCode.CONFLICT, 'The item is already on this count sheet');
      const book = await this.bookOf(tx, tenantId, count, item.id);
      const line = await tx.stockCountLine.create({
        data: { tenantId, countId, itemId: item.id, systemQty: book.toString() },
        include: LINE_INCLUDE,
      });
      return isBlindDraft(count) ? maskLine(line) : line;
    }, POSTING_TX_OPTIONS);
  }

  /**
   * Enters the counted quantity of one line, in the unit given (ADR-030 §8).
   * `countedQty` null clears the line. The counter and the time are recorded.
   */
  async updateLine(countId: bigint, lineId: bigint, dto: UpdateCountLineDto) {
    const { tenantId, db } = this.tenant();
    const userId = this.userId();
    return db.$transaction(async (tx) => {
      const count = await this.lockedDraft(tx, tenantId, countId);
      const line = await tx.stockCountLine.findFirst({ where: { id: lineId, countId } });
      if (!line) throw DomainError.notFound('StockCountLine', lineId.toString());
      const q = dto.countedQty === null ? null : await this.quantityOf(tx, line.itemId, dto.countedQty, dto.itemUnitId);
      await tx.stockCountLine.update({
        where: { id: lineId },
        data: countedData(q, new Decimal(line.systemQty.toString()), userId, new Date()),
      });
      if (q && userId !== null) await this.recordCounter(tx, tenantId, countId, userId);
      const saved = await tx.stockCountLine.findFirstOrThrow({ where: { id: lineId }, include: LINE_INCLUDE });
      return isBlindDraft(count) ? maskLine(saved) : saved;
    }, POSTING_TX_OPTIONS);
  }

  /**
   * One scan of a barcode in a DRAFT count (ADR-030 §9): adds one of the
   * barcode's unit to the item's line, creating the line when the item is not
   * on the sheet. The line keeps the unit it was counted in; when the scanned
   * unit differs, the total moves to that unit only if it is a whole number of
   * it, else it is stored in the base unit.
   */
  async scan(countId: bigint, dto: ScanCountDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();
    return db.$transaction(async (tx) => {
      const count = await this.lockedDraft(tx, tenantId, countId);
      const bc = await tx.itemBarcode.findFirst({
        where: { barcode: dto.barcode },
        include: { item: { select: { id: true, companyId: true, itemKind: true, isActive: true } }, itemUnit: true },
      });
      if (!bc || bc.item.companyId !== companyId) throw DomainError.notFound('ItemBarcode', dto.barcode);
      assertNotRecipe(bc.item.itemKind, String(bc.item.id));
      if (!isStocked(bc.item.itemKind) || !bc.item.isActive) {
        throw new DomainError(ErrorCode.VALIDATION, 'Only active stock items are counted');
      }
      const itemId = bc.item.id;
      const factor = bc.itemUnit ? new Decimal(bc.itemUnit.factorToBase.toString()) : new Decimal(1);
      const scannedUnitId = bc.itemUnit?.id ?? null;

      const line = await tx.stockCountLine.findFirst({ where: { countId, itemId } });
      const newBase = round6(new Decimal(line?.countedQty?.toString() ?? 0).plus(factor));
      let entryUnitId: bigint | null;
      let entryQty: Decimal;
      if (line && (line.itemUnitId ?? null) === scannedUnitId) {
        entryUnitId = scannedUnitId;
        entryQty = new Decimal(line.countedUnitQty?.toString() ?? 0).plus(1);
      } else {
        const whole = bc.itemUnit ? newBase.div(factor) : null;
        if (whole !== null && whole.isInteger()) {
          entryUnitId = scannedUnitId;
          entryQty = whole;
        } else {
          entryUnitId = null;
          entryQty = newBase;
        }
      }

      const book = await this.bookOf(tx, tenantId, count, itemId);
      const systemQty = line ? new Decimal(line.systemQty.toString()) : book;
      const data = {
        countedQty: newBase.toString(),
        countedUnitQty: entryQty.toString(),
        itemUnitId: entryUnitId,
        differenceQty: newBase.minus(systemQty).toString(),
        countedBy: userId,
        countedAt: new Date(),
      };
      const saved = line
        ? await tx.stockCountLine.update({ where: { id: line.id }, data, include: LINE_INCLUDE })
        : await tx.stockCountLine.create({
            data: { tenantId, countId, itemId, systemQty: book.toString(), ...data },
            include: LINE_INCLUDE,
          });
      if (userId !== null) await this.recordCounter(tx, tenantId, countId, userId);
      return isBlindDraft(count) ? maskLine(saved) : saved;
    }, POSTING_TX_OPTIONS);
  }

  /**
   * Re-reads the book qty at the count date of every line (informational while
   * counting; approval always re-reads it under the stock locks).
   */
  async refresh(id: bigint) {
    const { tenantId, db } = this.tenant();
    await db.$transaction(async (tx) => {
      const count = await this.lockedDraft(tx, tenantId, id);
      const lines = await tx.stockCountLine.findMany({ where: { countId: id } });
      const book = await this.bookAt(tx, tenantId, count.warehouseId, count.countDate, lines.map((l) => l.itemId));
      for (const line of lines) {
        const systemQty = book.get(line.itemId) ?? new Decimal(0);
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: {
            systemQty: systemQty.toString(),
            differenceQty: line.countedQty === null ? null : new Decimal(line.countedQty.toString()).minus(systemQty).toString(),
          },
        });
      }
    }, POSTING_TX_OPTIONS);
    await this.audit.log({ action: 'stock_count.refresh', entityType: 'stock_count', entityId: id });
    return this.get(id);
  }

  /**
   * Closes the counting (ADR-030 §5): DRAFT → SUBMITTED. No line is edited
   * afterwards; `reopen` brings the count back to counting.
   */
  async submit(id: bigint) {
    const { tenantId, db } = this.tenant();
    const userId = this.userId();
    await db.$transaction(async (tx) => {
      await this.lockCount(tx, tenantId, id);
      const count = await tx.stockCount.findFirst({ where: { id, AND: [{ warehouse: branchWhere() }] } });
      if (!count) throw DomainError.notFound('StockCount', id.toString());
      if (count.status !== 'DRAFT') throw invalidStatus(count.status, 'a draft');
      const lines = await tx.stockCountLine.count({ where: { countId: id } });
      if (lines === 0) throw new DomainError(ErrorCode.VALIDATION, 'Count has no lines');
      await tx.stockCount.update({
        where: { id },
        data: { status: 'SUBMITTED', submittedAt: new Date(), submittedBy: userId },
      });
      await this.audit.log({ action: 'stock_count.submit', entityType: 'stock_count', entityId: id }, tx);
    }, POSTING_TX_OPTIONS);
    return this.get(id);
  }

  /** Brings a SUBMITTED count back to counting (SUBMITTED → DRAFT). */
  async reopen(id: bigint) {
    const { tenantId, db } = this.tenant();
    await db.$transaction(async (tx) => {
      await this.lockCount(tx, tenantId, id);
      const count = await tx.stockCount.findFirst({ where: { id, AND: [{ warehouse: branchWhere() }] } });
      if (!count) throw DomainError.notFound('StockCount', id.toString());
      if (count.status !== 'SUBMITTED') throw invalidStatus(count.status, 'submitted');
      await tx.stockCount.update({ where: { id }, data: { status: 'DRAFT', submittedAt: null, submittedBy: null } });
      await this.audit.log({ action: 'stock_count.reopen', entityType: 'stock_count', entityId: id }, tx);
    }, POSTING_TX_OPTIONS);
    return this.get(id);
  }

  /**
   * Approves a SUBMITTED count (ADR-030 §1, §3, §4). The approver must not be
   * the one who created the count or counted one of its lines, unless an owner.
   * Under the count's lock and the stock locks of the counted items, every
   * counted line's book qty is read at the count date; the non-zero
   * differences go into ONE COUNT_ADJUSTMENT dated today, posted through
   * AdjustmentsService. Uncounted lines are left alone. Keyed (route).
   */
  async approve(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();
    const today = await this.support.companyTodayDate();

    await retryOnLockConflict(() =>
      db.$transaction(async (tx) => {
        // Lock the count first (§10.1 step 7): a second approval waits here, then finds it posted.
        await this.lockCount(tx, tenantId, id);
        const count = await tx.stockCount.findFirst({
          where: { id, AND: [{ warehouse: branchWhere() }] },
          include: { lines: true },
        });
        if (!count) throw DomainError.notFound('StockCount', id.toString());
        if (count.status !== 'SUBMITTED') throw invalidStatus(count.status, 'submitted');
        if (!this.isOwner()) {
          // Counted by this user at any time, even when a later count of the same line came from someone else.
          const counted =
            userId !== null && (await tx.stockCountCounter.count({ where: { countId: id, userId } })) > 0;
          const lineCounter = count.lines.some((l) => l.countedBy === userId);
          if (count.createdBy === userId || lineCounter || counted) {
            throw new DomainError(
              ErrorCode.STOCK_COUNT_SELF_APPROVAL,
              'You created or counted this count; another storekeeper or the owner approves it',
            );
          }
        }

        const counted = count.lines.filter((l) => l.countedQty !== null);
        if (counted.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'No line is counted: count at least one item (zero included) before approval');
        }
        await this.ledger.lockForDocument(
          tx,
          companyId,
          counted.map((l) => ({ itemId: l.itemId, warehouseId: count.warehouseId })),
        );
        const book = await this.bookAt(
          tx,
          tenantId,
          count.warehouseId,
          count.countDate,
          counted.map((l) => l.itemId),
          true,
        );

        const adjLines: { itemId: bigint; diff: Decimal }[] = [];
        for (const line of counted) {
          const systemQty = book.get(line.itemId) ?? new Decimal(0);
          const diff = new Decimal(line.countedQty!.toString()).minus(systemQty);
          await tx.stockCountLine.update({
            where: { id: line.id },
            data: { systemQty: systemQty.toString(), differenceQty: diff.toString() },
          });
          if (!diff.isZero()) adjLines.push({ itemId: line.itemId, diff });
        }

        let adjustmentId: bigint | null = null;
        let docNo: string | null = null;
        if (adjLines.length > 0) {
          const created = await tx.stockAdjustment.create({
            data: {
              tenantId,
              companyId,
              warehouseId: count.warehouseId,
              adjustmentDate: today,
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
          const posted = await this.adjustments.postLocked(tx, created.id, companyId, userId ?? undefined);
          adjustmentId = created.id;
          docNo = posted.docNo;
        }
        await tx.stockCount.update({
          where: { id: count.id },
          data: { status: 'POSTED', adjustmentId, docNo, postedAt: new Date(), postedBy: userId },
        });
        await this.audit.log({
          action: 'stock_count.approve',
          entityType: 'stock_count',
          entityId: id,
          after: { adjustmentId: adjustmentId?.toString() ?? null, docNo },
        }, tx);
        return { adjustmentId, docNo };
      }, POSTING_TX_OPTIONS),
    );

    return this.get(id);
  }

  /**
   * The sheet to print or fill in (ADR-030 §11): code, first barcode, name, base
   * unit, the book qty (withheld while blind and DRAFT) and the counted qty.
   */
  async sheet(id: bigint) {
    const { tenantId, db } = this.tenant();
    const count = await db.stockCount.findFirst({
      where: { id, AND: [{ warehouse: branchWhere() }] },
      include: {
        warehouse: { select: { code: true, nameAr: true } },
        lines: {
          include: {
            item: {
              select: {
                code: true,
                nameAr: true,
                baseUnit: { select: { code: true, nameAr: true } },
                barcodes: { orderBy: { id: 'asc' }, take: 1, select: { barcode: true } },
              },
            },
          },
        },
      },
    });
    if (!count) throw DomainError.notFound('StockCount', id.toString());
    const hidden = isBlindDraft(count);
    const book = hidden ? null : await this.bookOfLines(tenantId, db, count);
    const rows = count.lines
      .map((l) => ({
        itemId: l.itemId.toString(),
        code: l.item.code,
        barcode: l.item.barcodes[0]?.barcode ?? null,
        name: l.item.nameAr,
        unit: l.item.baseUnit.code,
        ...(book ? { bookQty: (book.get(l.itemId) ?? new Decimal(0)).toString() } : {}),
        countedQty: l.countedQty?.toString() ?? null,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
    return {
      countId: id.toString(),
      docNo: count.docNo,
      status: count.status,
      warehouse: { code: count.warehouse.code, nameAr: count.warehouse.nameAr },
      countDate: count.countDate.toISOString().slice(0, 10),
      bookHidden: hidden,
      rows,
    };
  }

  /**
   * The difference report (ADR-030 §12): per counted line the book (at the
   * count date), the counted qty, the difference in base units and its value at
   * the company's current average cost, which is what approval posts. A posted
   * count shows its stored values. A blind draft has no report yet.
   */
  async variance(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const count = await db.stockCount.findFirst({
      where: { id, AND: [{ warehouse: branchWhere() }] },
      include: {
        warehouse: { select: { code: true, nameAr: true } },
        lines: {
          include: { item: { select: { code: true, nameAr: true, baseUnit: { select: { code: true } } } } },
        },
      },
    });
    if (!count) throw DomainError.notFound('StockCount', id.toString());
    if (isBlindDraft(count)) {
      throw new DomainError(ErrorCode.CONFLICT, 'The difference is hidden while a blind count is a draft');
    }
    const book = await this.bookOfLines(tenantId, db, count);
    const costs = await db.itemCost.findMany({
      where: { companyId, itemId: { in: count.lines.map((l) => l.itemId) } },
      select: { itemId: true, avgCost: true },
    });
    const avgCost = new Map(costs.map((c) => [c.itemId, new Decimal(c.avgCost.toString())]));

    const lines = count.lines
      .filter((l) => l.countedQty !== null)
      .map((l) => {
        const bookQty = book.get(l.itemId) ?? new Decimal(0);
        const countedQty = new Decimal(l.countedQty!.toString());
        const difference = countedQty.minus(bookQty);
        const unitCost = avgCost.get(l.itemId) ?? new Decimal(0);
        return {
          itemId: l.itemId.toString(),
          code: l.item.code,
          nameAr: l.item.nameAr,
          unit: l.item.baseUnit.code,
          bookQty: bookQty.toString(),
          countedQty: countedQty.toString(),
          differenceQty: difference.toString(),
          unitCost: unitCost.toString(),
          differenceValue: round3(difference.times(unitCost)).toString(),
          // A surplus at zero cost is booked at zero: flag it for the reader (ADR-030 §12).
          zeroCostGain: difference.gt(0) && unitCost.isZero(),
          value: round3(difference.times(unitCost)),
          diff: difference,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
    const uncounted = count.lines
      .filter((l) => l.countedQty === null)
      .map((l) => ({ itemId: l.itemId.toString(), code: l.item.code, nameAr: l.item.nameAr }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const shortages = lines.filter((l) => l.diff.lt(0));
    const surpluses = lines.filter((l) => l.diff.gt(0));
    const totals = {
      shortageQty: sum(shortages.map((l) => l.diff)).toString(),
      surplusQty: sum(surpluses.map((l) => l.diff)).toString(),
      shortageValue: sum(shortages.map((l) => l.value)).toString(),
      surplusValue: sum(surpluses.map((l) => l.value)).toString(),
      netValue: sum(lines.map((l) => l.value)).toString(),
      countedLines: lines.length,
      uncountedLines: uncounted.length,
    };
    return {
      countId: id.toString(),
      docNo: count.docNo,
      status: count.status,
      warehouse: { code: count.warehouse.code, nameAr: count.warehouse.nameAr },
      countDate: count.countDate.toISOString().slice(0, 10),
      lines: lines.map((l) => ({
        itemId: l.itemId,
        code: l.code,
        nameAr: l.nameAr,
        unit: l.unit,
        bookQty: l.bookQty,
        countedQty: l.countedQty,
        differenceQty: l.differenceQty,
        unitCost: l.unitCost,
        differenceValue: l.differenceValue,
        zeroCostGain: l.zeroCostGain,
      })),
      uncounted,
      totals,
    };
  }

  /**
   * Fills the counted quantities from an Excel sheet of `sheet` (ADR-030 §11).
   * All or nothing: any unknown item or unit, duplicate row, or invalid quantity
   * refuses the whole file, listing each problem by row. Empty counted cells are
   * skipped. An item not on the sheet is added, as a scan would add it.
   */
  async importSheet(id: bigint, file: UploadedSheet | undefined) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();
    // The count is looked up (and its branch checked) before the file is read.
    const visible = await db.stockCount.findFirst({ where: { id, AND: [{ warehouse: branchWhere() }] }, select: { id: true } });
    if (!visible) throw DomainError.notFound('StockCount', id.toString());
    const rows = await readSheetRows(file);
    const resolved = await this.resolveImport(db, companyId, rows);
    if (resolved.errors.length > 0) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        `The sheet has ${resolved.errors.length} problem(s); nothing was imported`,
        { errors: resolved.errors },
      );
    }
    await db.$transaction(async (tx) => {
      const count = await this.lockedDraft(tx, tenantId, id);
      const now = new Date();
      if (resolved.entries.length > 0 && userId !== null) await this.recordCounter(tx, tenantId, id, userId);
      for (const entry of resolved.entries) {
        const q = await this.quantityOf(tx, entry.itemId, entry.qty, entry.itemUnitId);
        const line = await tx.stockCountLine.findFirst({ where: { countId: id, itemId: entry.itemId } });
        if (line) {
          await tx.stockCountLine.update({
            where: { id: line.id },
            data: countedData(q, new Decimal(line.systemQty.toString()), userId, now),
          });
        } else {
          const book = await this.bookOf(tx, tenantId, count, entry.itemId);
          await tx.stockCountLine.create({
            data: {
              tenantId,
              countId: id,
              itemId: entry.itemId,
              systemQty: book.toString(),
              ...countedData(q, book, userId, now),
            },
          });
        }
      }
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: 'stock_count.import',
      entityType: 'stock_count',
      entityId: id,
      after: { lines: resolved.entries.length },
    });
    return this.get(id);
  }

  /**
   * Checks every row of an import against the catalog without writing. An item
   * is found by code or barcode (both must agree when both are given), its unit
   * by code among its units (the base unit when blank; the barcode's unit when
   * the barcode names one). Rows with no counted value only have to name a valid item.
   */
  private async resolveImport(db: ReturnType<PrismaService['forTenant']>, companyId: bigint, rows: ImportRow[]) {
    const codes = [...new Set(rows.map((r) => r.code).filter((c): c is string => !!c))];
    const barcodes = [...new Set(rows.map((r) => r.barcode).filter((c): c is string => !!c))];
    const items = codes.length
      ? await db.item.findMany({
          where: { companyId, itemKind: stockedItemKindFilter(), isActive: true, code: { in: codes } },
          include: { baseUnit: { select: { code: true } }, units: { include: { unit: { select: { code: true } } } } },
        })
      : [];
    const barcodeRows = barcodes.length
      ? await db.itemBarcode.findMany({
          where: { barcode: { in: barcodes } },
          include: {
            item: {
              include: { baseUnit: { select: { code: true } }, units: { include: { unit: { select: { code: true } } } } },
            },
            itemUnit: { include: { unit: { select: { code: true } } } },
          },
        })
      : [];
    const byCode = new Map(items.map((i) => [i.code, i]));
    const byBarcode = new Map(barcodeRows.map((b) => [b.barcode, b]));

    const errors: { row: number; reason: string }[] = [];
    const entries: { row: number; itemId: bigint; itemUnitId: bigint | null; qty: string }[] = [];
    const seen = new Map<string, number>();
    for (const r of rows) {
      const hasQty = r.counted !== '';
      if (!r.code && !r.barcode) {
        errors.push({ row: r.row, reason: 'NO_ITEM: the row has neither a code nor a barcode' });
        continue;
      }
      const byC = r.code ? byCode.get(r.code) : undefined;
      const byB = r.barcode ? byBarcode.get(r.barcode) : undefined;
      if ((r.code && !byC) || (r.barcode && !byB)) {
        errors.push({ row: r.row, reason: 'UNKNOWN_ITEM: no active stock item with this code or barcode' });
        continue;
      }
      if (byC && byB && byC.id !== byB.itemId) {
        errors.push({ row: r.row, reason: 'MISMATCH: the code and the barcode name different items' });
        continue;
      }
      const item = byC ?? byB!.item;
      // A barcode scanned in a unit counts in that unit unless the row names another.
      const barcodeUnit = byB?.itemUnit ?? null;
      let itemUnitId: bigint | null = barcodeUnit?.id ?? null;
      if (r.unit) {
        if (r.unit === item.baseUnit.code) {
          itemUnitId = null;
        } else {
          const unit = item.units.find((u) => u.isActive && u.unit.code === r.unit);
          if (!unit) {
            errors.push({ row: r.row, reason: `UNKNOWN_UNIT: ${r.unit} is not a unit of this item` });
            continue;
          }
          itemUnitId = unit.id;
        }
      }
      if (!hasQty) continue;
      if (!QTY_PATTERN.test(r.counted) || new Decimal(r.counted).decimalPlaces() > 6) {
        errors.push({ row: r.row, reason: 'INVALID_QTY: the counted quantity must be a number with at most 6 decimals' });
        continue;
      }
      const dup = seen.get(item.id.toString());
      if (dup !== undefined) {
        errors.push({ row: r.row, reason: `DUPLICATE: the same item is on row ${dup}` });
        continue;
      }
      seen.set(item.id.toString(), r.row);
      entries.push({ row: r.row, itemId: item.id, itemUnitId, qty: r.counted });
    }
    return { errors, entries };
  }

  /** Locks the count row (every write of a count goes through it) and returns the DRAFT count. */
  private async lockedDraft(tx: Prisma.TransactionClient, tenantId: bigint, id: bigint) {
    await this.lockCount(tx, tenantId, id);
    const count = await tx.stockCount.findFirst({ where: { id, AND: [{ warehouse: branchWhere() }] } });
    if (!count) throw DomainError.notFound('StockCount', id.toString());
    if (count.status !== 'DRAFT') throw invalidStatus(count.status, 'a draft');
    return count;
  }

  private async lockCount(tx: Prisma.TransactionClient, tenantId: bigint, id: bigint): Promise<void> {
    await tx.$queryRaw`SELECT id FROM stock_counts WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  }

  /**
   * Records that a user entered a quantity on this count (ADR-030 §3). One row per
   * user and count: a repeat is skipped, so the approver check sees every past counter.
   * Called under the count's lock.
   */
  private async recordCounter(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    countId: bigint,
    userId: bigint,
  ): Promise<void> {
    await tx.stockCountCounter.createMany({ data: [{ tenantId, countId, userId }], skipDuplicates: true });
  }

  /** The count's book qty of one item at the count date (what a line snapshots). */
  private async bookOf(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    count: { warehouseId: bigint; countDate: Date },
    itemId: bigint,
  ): Promise<Decimal> {
    const book = await this.bookAt(tx, tenantId, count.warehouseId, count.countDate, [itemId]);
    return book.get(itemId) ?? new Decimal(0);
  }

  /**
   * Book qty per item of a warehouse at the end of `date` (ADR-030 §1): the sum
   * of qty_in − qty_out of its movements dated on or before it. The movements
   * are the source of truth, so a sale after the count date is not in the book.
   */
  private async bookAt(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    warehouseId: bigint,
    date: Date,
    itemIds?: bigint[],
    lock = false,
  ): Promise<Map<bigint, Decimal>> {
    if (itemIds && itemIds.length === 0) return new Map();
    // Approval reads under its stock locks: a locking read sees the latest committed movements, not the
    // snapshot of the transaction's first plain read (review: a same-day sale racing the approval).
    const lockClause = lock ? Prisma.sql` LOCK IN SHARE MODE` : Prisma.empty;
    const rows = itemIds
      ? await tx.$queryRaw<{ item_id: bigint | number; qty: string }[]>`
          SELECT item_id, CAST(SUM(qty_in - qty_out) AS CHAR) AS qty
            FROM stock_movements
           WHERE tenant_id = ${tenantId} AND warehouse_id = ${warehouseId}
             AND item_id IN (${Prisma.join(itemIds)}) AND movement_date <= ${date}
           GROUP BY item_id${lockClause}`
      : await tx.$queryRaw<{ item_id: bigint | number; qty: string }[]>`
          SELECT item_id, CAST(SUM(qty_in - qty_out) AS CHAR) AS qty
            FROM stock_movements
           WHERE tenant_id = ${tenantId} AND warehouse_id = ${warehouseId} AND movement_date <= ${date}
           GROUP BY item_id${lockClause}`;
    return new Map(rows.map((r) => [BigInt(r.item_id), new Decimal(r.qty)]));
  }

  /** The book qty of a count's lines: the stored final values once posted, else the live book at the count date. */
  private async bookOfLines(
    tenantId: bigint,
    db: ReturnType<PrismaService['forTenant']>,
    count: { id: bigint; status: string; warehouseId: bigint; countDate: Date; lines: { itemId: bigint; systemQty: unknown }[] },
  ): Promise<Map<bigint, Decimal>> {
    if (count.status === 'POSTED') {
      return new Map(count.lines.map((l) => [l.itemId, new Decimal(String(l.systemQty))]));
    }
    return db.$transaction(
      (tx) => this.bookAt(tx, tenantId, count.warehouseId, count.countDate, count.lines.map((l) => l.itemId)),
      POSTING_TX_OPTIONS,
    );
  }

  /**
   * The base quantity and the entered one of a counted quantity (ADR-030 §8).
   * The unit must be an active unit of the item; no unit means the base unit.
   */
  private async quantityOf(
    tx: Prisma.TransactionClient,
    itemId: bigint,
    qty: string,
    itemUnitId?: string | bigint | null,
  ): Promise<CountedQuantity> {
    const unitQty = new Decimal(qty);
    if (unitQty.lt(0) || unitQty.decimalPlaces() > 6) {
      throw new DomainError(ErrorCode.VALIDATION, 'countedQty must be zero or more, with at most 6 decimals');
    }
    if (itemUnitId === undefined || itemUnitId === null) {
      return { base: round6(unitQty), unitQty, itemUnitId: null };
    }
    const unit = await tx.itemUnit.findFirst({
      where: { id: BigInt(itemUnitId), itemId, isActive: true },
    });
    if (!unit) throw new DomainError(ErrorCode.VALIDATION, 'The unit is not an active unit of this item', { itemUnitId: String(itemUnitId) });
    return {
      base: round6(unitQty.times(new Decimal(unit.factorToBase.toString()))),
      unitQty,
      itemUnitId: unit.id,
    };
  }
}

/** A count date as the company's calendar day (a DATE column, so 00:00 UTC). */
const DateOnly = {
  of(value: string): Date {
    return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  },
};

const QTY_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

/** One row of an imported count sheet: the row number, the identity, the unit code and the counted text. */
export interface ImportRow {
  row: number;
  code: string | null;
  barcode: string | null;
  unit: string | null;
  counted: string;
}

function invalidStatus(status: string, expected: string): DomainError {
  return new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, `The count is ${status}; it must be ${expected}`, { status });
}
