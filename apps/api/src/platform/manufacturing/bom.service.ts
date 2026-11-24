import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isRecipe, isStocked, type ItemKindValue } from '../../common/inventory/item-kind.js';
import { findPage } from '../../common/paging/find-page.js';
import { pageWindow } from '../../common/paging/page-query.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BomLineDto, CreateBomDto, ListBomsQueryDto, UpdateBomDto } from './dto/bom.dto.js';
import { currentCompanyFilter, currentCompanySqlFilter } from '../../common/cls/current-company.js';

type Tx = Prisma.TransactionClient;

const UNIT_REF = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;
const ITEM_REF = { select: { id: true, code: true, nameAr: true, nameEn: true, itemKind: true, baseUnit: UNIT_REF } } as const;
const ITEM_UNIT_REF = { select: { id: true, factorToBase: true, unit: UNIT_REF } } as const;

const LIST_SELECT = {
  id: true,
  itemId: true,
  versionNo: true,
  status: true,
  outputQty: true,
  outputQtyBase: true,
  appliedCostPerUnit: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
  item: ITEM_REF,
  outputItemUnit: ITEM_UNIT_REF,
  _count: { select: { lines: true } },
} as const;

const DETAIL_SELECT = {
  id: true,
  itemId: true,
  versionNo: true,
  status: true,
  outputQty: true,
  outputItemUnitId: true,
  outputQtyBase: true,
  appliedCostPerUnit: true,
  note: true,
  activatedAt: true,
  activatedBy: true,
  createdAt: true,
  updatedAt: true,
  item: ITEM_REF,
  outputItemUnit: ITEM_UNIT_REF,
  lines: {
    orderBy: { lineNo: 'asc' },
    select: {
      id: true,
      lineNo: true,
      componentItemId: true,
      qty: true,
      qtyBase: true,
      wastePct: true,
      note: true,
      componentItem: ITEM_REF,
      itemUnit: ITEM_UNIT_REF,
    },
  },
} as const;

/** One checked component line, ready to store (quantities already in the base unit). */
interface ResolvedLine {
  lineNo: number;
  componentItemId: bigint;
  /** Null: the component's base unit. */
  itemUnitId: bigint | null;
  qty: Decimal;
  qtyBase: Decimal;
  wastePct: Decimal;
  note: string | null;
}

/** The checked content of a version: output, applied cost and components. */
interface ResolvedContent {
  outputQty: Decimal;
  /** Null: the output is in the item's base unit. */
  outputItemUnitId: bigint | null;
  outputQtyBase: Decimal;
  appliedCostPerUnit: Decimal;
  note: string | null;
  lines: ResolvedLine[];
}

/** One version as the API returns it (get, create, update, activate). */
export type BomDetail = Awaited<ReturnType<BomService['get']>>;

/** Standard requirement of one component line for a production (ADR-031 §5). */
export interface ExplodedLine {
  lineNo: number;
  componentItemId: bigint;
  componentItem: { id: bigint; code: string; nameAr: string; nameEn: string | null; itemKind: 'STOCK' | 'SERVICE' | 'MANUFACTURED' | 'RECIPE'; baseUnit: { id: bigint; code: string; nameAr: string; nameEn: string | null } };
  wastePct: Decimal;
  /** The line's base quantity per output batch (before scaling). */
  qtyBase: Decimal;
  /** round6(qtyBase × produced ÷ outputQtyBase × (1 + wastePct ÷ 100)). */
  requiredQtyBase: Decimal;
}

export interface BomExplosion {
  bomId: bigint;
  versionNo: number;
  outputQtyBase: Decimal;
  lines: ExplodedLine[];
}

/** ADR-032 §7: nested recipes below the sold one, at most this many levels deep. */
export const RECIPE_MAX_DEPTH = 8;

/** One stock leaf of a recipe explosion: quantity in the base unit (6 dp), merged across levels. */
export interface StockComponent {
  itemId: bigint;
  qtyBase: Decimal;
}

/** The stock leaves a sale of a recipe consumes (ADR-032 §7). */
export interface StockExplosion {
  /** The ACTIVE version of the sold recipe (or the explicit one), null when missing. */
  bomId: bigint | null;
  /** True when a recipe in the tree has no ACTIVE version (ADR-032 §1): no components, cost 0. */
  missing: boolean;
  components: StockComponent[];
}

/** The BOM fields an explosion reads (one level). */
const EXPLODE_BOM_SELECT = {
  id: true,
  versionNo: true,
  outputQtyBase: true,
  lines: {
    orderBy: { lineNo: 'asc' },
    select: { lineNo: true, componentItemId: true, qtyBase: true, wastePct: true, componentItem: { select: { itemKind: true } } },
  },
} as const;

/** Lock one item row (the first lock of every BOM write, ADR-031 §5). */
async function lockItem(tx: Tx, tenantId: bigint, itemId: bigint): Promise<void> {
  await tx.$queryRaw`SELECT id FROM items WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${itemId} FOR UPDATE`;
}

/**
 * Bill of materials versions for MANUFACTURED items (ADR-031 §5) and for recipes (ADR-032 §6).
 *
 * Only a DRAFT is edited or deleted. Activation takes the company row lock and
 * then the item row lock, so two activations in one company run one after the
 * other and the loop check sees the other's result (a cycle across two items
 * cannot slip through two concurrent activations). Other writes lock only the
 * item row. At most one version per item is ACTIVE: activation sets the others
 * to INACTIVE in the same transaction.
 */
@Injectable()
export class BomService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: Tx): Promise<bigint> {
    const company = await db.company.findFirst({
      where: { isActive: true, ...currentCompanyFilter() },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  private userId(): bigint | undefined {
    return ClsServiceManager.getClsService<RequestContext>().get('userId');
  }

  /** One numbered page of versions (ADR-022), grouped by item, newest version first. */
  async list(query: ListBomsQueryDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const where: Prisma.BomWhereInput = {
      companyId,
      ...(query.itemId ? { itemId: BigInt(query.itemId) } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) => {
        const rows = await tx.bom.findMany({
          where,
          select: LIST_SELECT,
          orderBy: [{ itemId: 'asc' }, { versionNo: 'desc' }],
          ...window,
        });
        return rows.map(({ _count, ...row }) => ({ ...row, lineCount: _count.lines }));
      },
      count: (tx) => tx.bom.count({ where }),
    });
  }

  /** One version with its components. */
  async get(id: bigint) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return this.detail(db, companyId, id);
  }

  /** Creates a DRAFT version for a MANUFACTURED item (version_no = max + 1). */
  async create(dto: CreateBomDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId() ?? null;
    const id = await db.$transaction(async (tx) => {
      const itemId = BigInt(dto.itemId);
      const item = await this.manufacturedItem(tx, companyId, itemId);
      await lockItem(tx, tenantId, item.id);
      const content = await this.resolveContent(tx, companyId, item.id, item.itemKind, dto);
      const bom = await tx.bom.create({
        data: {
          tenantId,
          companyId,
          itemId: item.id,
          versionNo: await this.nextVersion(tx, item.id),
          status: 'DRAFT',
          outputQty: content.outputQty,
          outputItemUnitId: content.outputItemUnitId,
          outputQtyBase: content.outputQtyBase,
          appliedCostPerUnit: content.appliedCostPerUnit,
          note: content.note,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      await tx.bomLine.createMany({ data: lineRows(tenantId, bom.id, content.lines) });
      return bom.id;
    });
    await this.audit.log({ action: 'bom.create', entityType: 'bom', entityId: id, after: { itemId: dto.itemId } });
    return this.get(id);
  }

  /** Replaces a DRAFT's content. An ACTIVE or INACTIVE version is never edited: copy it instead. */
  async update(id: bigint, dto: UpdateBomDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId() ?? null;
    await db.$transaction(async (tx) => {
      const head = await this.versionHead(tx, companyId, id);
      await lockItem(tx, tenantId, head.itemId);
      const current = await this.versionHead(tx, companyId, id);
      if (current.status !== 'DRAFT') throw new DomainError(ErrorCode.BOM_NOT_DRAFT, 'Only a draft version can be changed', { status: current.status });
      const content = await this.resolveContent(tx, companyId, current.itemId, current.item.itemKind, dto);
      await tx.bomLine.deleteMany({ where: { bomId: id } });
      await tx.bom.update({
        where: { id },
        data: {
          outputQty: content.outputQty,
          outputItemUnitId: content.outputItemUnitId,
          outputQtyBase: content.outputQtyBase,
          appliedCostPerUnit: content.appliedCostPerUnit,
          note: content.note,
          updatedBy: userId,
        },
      });
      await tx.bomLine.createMany({ data: lineRows(tenantId, id, content.lines) });
    });
    await this.audit.log({ action: 'bom.update', entityType: 'bom', entityId: id, after: { lines: dto.lines.length } });
    return this.get(id);
  }

  /** Deletes a DRAFT version (its lines go with it). */
  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    await db.$transaction(async (tx) => {
      const head = await this.versionHead(tx, companyId, id);
      await lockItem(tx, tenantId, head.itemId);
      const current = await this.versionHead(tx, companyId, id);
      if (current.status !== 'DRAFT') throw new DomainError(ErrorCode.BOM_NOT_DRAFT, 'Only a draft version can be deleted', { status: current.status });
      await tx.bom.delete({ where: { id } });
    });
    await this.audit.log({ action: 'bom.delete', entityType: 'bom', entityId: id, after: null });
    return { deleted: true as const };
  }

  /** A new DRAFT with the same output, applied cost and components as any version (ADR-031 §5). */
  async copy(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId() ?? null;
    const newId = await db.$transaction(async (tx) => {
      const head = await this.versionHead(tx, companyId, id);
      await lockItem(tx, tenantId, head.itemId);
      const src = await tx.bom.findFirst({
        where: { id, companyId },
        select: {
          itemId: true,
          outputQty: true,
          outputItemUnitId: true,
          outputQtyBase: true,
          appliedCostPerUnit: true,
          note: true,
          lines: { orderBy: { lineNo: 'asc' }, select: { lineNo: true, componentItemId: true, itemUnitId: true, qty: true, qtyBase: true, wastePct: true, note: true } },
        },
      });
      if (!src) throw DomainError.notFound('Bom', id.toString());
      const bom = await tx.bom.create({
        data: {
          tenantId,
          companyId,
          itemId: src.itemId,
          versionNo: await this.nextVersion(tx, src.itemId),
          status: 'DRAFT',
          outputQty: src.outputQty,
          outputItemUnitId: src.outputItemUnitId,
          outputQtyBase: src.outputQtyBase,
          appliedCostPerUnit: src.appliedCostPerUnit,
          note: src.note,
          createdBy: userId,
          updatedBy: userId,
        },
        select: { id: true },
      });
      await tx.bomLine.createMany({
        data: src.lines.map((l) => ({
          tenantId,
          bomId: bom.id,
          lineNo: l.lineNo,
          componentItemId: l.componentItemId,
          itemUnitId: l.itemUnitId,
          qty: l.qty,
          qtyBase: l.qtyBase,
          wastePct: l.wastePct,
          note: l.note,
        })),
      });
      return bom.id;
    });
    await this.audit.log({ action: 'bom.copy', entityType: 'bom', entityId: newId, after: { from: id.toString() } });
    return this.get(newId);
  }

  /**
   * Makes this version the item's only ACTIVE one (ADR-031 §5). Refused when a
   * loop runs through the active versions of the components.
   */
  async activate(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId() ?? null;
    await db.$transaction(async (tx) => {
      // Company row first: serialises activations, so the loop check sees the others' results.
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const head = await this.versionHead(tx, companyId, id);
      await lockItem(tx, tenantId, head.itemId);
      const current = await tx.bom.findFirst({
        where: { id, companyId },
        select: { itemId: true, status: true, versionNo: true, lines: { select: { componentItemId: true } } },
      });
      if (!current) throw DomainError.notFound('Bom', id.toString());
      if (current.status === 'ACTIVE') {
        await this.audit.log({
          action: 'bom.activate',
          entityType: 'bom',
          entityId: id,
          after: { itemId: current.itemId.toString() },
        }, tx);
        return current.itemId;
      }
      if (current.lines.length === 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'A bill of materials needs at least one component', { bomId: id.toString() });
      }
      await this.assertNoLoop(
        tx,
        companyId,
        current.itemId,
        current.lines.map((l) => l.componentItemId),
      );
      await tx.bom.updateMany({
        where: { companyId, itemId: current.itemId, status: 'ACTIVE', NOT: { id } },
        data: { status: 'INACTIVE', updatedBy: userId },
      });
      await tx.bom.update({
        where: { id },
        data: { status: 'ACTIVE', activatedAt: new Date(), activatedBy: userId, updatedBy: userId },
      });
      await this.audit.log({
        action: 'bom.activate',
        entityType: 'bom',
        entityId: id,
        after: { itemId: current.itemId.toString() },
      }, tx);
      return current.itemId;
    });
    return this.get(id);
  }

  /**
   * ADR-032 §4 (GET boms/:id/cost): one output unit of this version costed at the current average
   * cost of its stock leaves, with the zero-cost warning. For a recipe, also its sale price net of
   * tax (ADR-017: a tax-inclusive price is divided by 1 + rate) and the margin in value and percent.
   */
  async costCard(id: bigint) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const bom = await db.bom.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        itemId: true,
        versionNo: true,
        status: true,
        outputQtyBase: true,
        item: {
          select: {
            itemKind: true,
            salePrice: true,
            salePriceIncludesTax: true,
            taxCategory: { select: { rate: true } },
          },
        },
      },
    });
    if (!bom) throw DomainError.notFound('Bom', id.toString());
    const exploded = await this.explodeToStock(db, companyId, bom.itemId, bom.outputQtyBase.toString(), false, bom.id);
    const leafIds = exploded.components.map((c) => c.itemId);
    const [costs, leaves] = await Promise.all([
      leafIds.length === 0 ? [] : db.itemCost.findMany({ where: { companyId, poolWarehouseId: 0n, itemId: { in: leafIds } }, select: { itemId: true, avgCost: true } }),
      leafIds.length === 0 ? [] : db.item.findMany({ where: { companyId, id: { in: leafIds } }, select: ITEM_REF.select }),
    ]);
    const avgById = new Map(costs.map((c) => [c.itemId, new Decimal(c.avgCost.toString())]));
    const leafById = new Map(leaves.map((l) => [l.id, l]));
    const lines = exploded.components.map((c) => {
      const avgCost = avgById.get(c.itemId) ?? new Decimal(0);
      return {
        componentItemId: c.itemId,
        componentItem: leafById.get(c.itemId)!,
        qtyBase: c.qtyBase,
        avgCost: round6(avgCost),
        totalCost: round3(c.qtyBase.times(avgCost)),
        zeroCost: avgCost.isZero(),
      };
    });
    const outputQtyBase = new Decimal(bom.outputQtyBase.toString());
    const totalCost = round3(lines.reduce((acc, l) => acc.plus(l.totalCost), new Decimal(0)));
    const unitCost = round6(totalCost.div(outputQtyBase));

    // ADR-017 / ADR-032 §4: the sale price of a recipe, net of its tax, and the margin per output unit.
    let salePriceNet: Decimal | null = null;
    let margin: Decimal | null = null;
    let marginPct: Decimal | null = null;
    if (bom.item.itemKind === 'RECIPE' && bom.item.salePrice !== null) {
      const price = new Decimal(bom.item.salePrice.toString());
      const rate = new Decimal((bom.item.taxCategory?.rate ?? 0).toString());
      salePriceNet = bom.item.salePriceIncludesTax ? round3(price.div(new Decimal(1).plus(rate.div(100)))) : round3(price);
      margin = round3(salePriceNet.minus(unitCost));
      marginPct = salePriceNet.gt(0) ? margin.div(salePriceNet).times(100).toDecimalPlaces(2) : null;
    }
    return {
      bomId: bom.id,
      versionNo: bom.versionNo,
      status: bom.status,
      isRecipe: bom.item.itemKind === 'RECIPE',
      outputQtyBase,
      missingBom: exploded.missing,
      zeroCostWarning: lines.some((l) => l.zeroCost),
      lines,
      totalCost,
      unitCost,
      salePrice: bom.item.salePrice === null ? null : new Decimal(bom.item.salePrice.toString()),
      pricesIncludeTax: bom.item.itemKind === 'RECIPE' ? bom.item.salePriceIncludesTax : null,
      salePriceNet,
      margin,
      marginPct,
    };
  }

  /** Marks an ACTIVE version INACTIVE; the item then has no active version until another is activated. */
  async deactivate(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId() ?? null;
    await db.$transaction(async (tx) => {
      const head = await this.versionHead(tx, companyId, id);
      await lockItem(tx, tenantId, head.itemId);
      const current = await this.versionHead(tx, companyId, id);
      if (current.status !== 'ACTIVE') {
        throw new DomainError(ErrorCode.BOM_NOT_ACTIVE, 'Only an active version can be deactivated', { status: current.status });
      }
      await tx.bom.update({ where: { id }, data: { status: 'INACTIVE', updatedBy: userId } });
      await this.audit.log({ action: 'bom.deactivate', entityType: 'bom', entityId: id, after: null }, tx);
    });
    return this.get(id);
  }

  /**
   * Preview of the standard requirements for `qty` of the output, in the BOM's
   * output unit (GET boms/:id/requirements). Same rule as production (ADR-031 §6).
   */
  async requirements(id: bigint, qty: string) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const bom = await db.bom.findFirst({
      where: { id, companyId },
      select: { id: true, itemId: true, versionNo: true, outputItemUnit: { select: { factorToBase: true } } },
    });
    if (!bom) throw DomainError.notFound('Bom', id.toString());
    const produced = new Decimal(qty);
    if (!produced.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'qty must be greater than zero', { qty });
    const outputFactor = bom.outputItemUnit ? new Decimal(bom.outputItemUnit.factorToBase.toString()) : new Decimal(1);
    const qtyBase = round6(produced.times(outputFactor));
    const exploded = await this.explode(db, bom.itemId, qtyBase, bom.id);
    return {
      bomId: bom.id,
      versionNo: bom.versionNo,
      qty,
      qtyBase,
      outputQtyBase: exploded.outputQtyBase,
      lines: exploded.lines.map((l) => ({
        lineNo: l.lineNo,
        componentItemId: l.componentItemId,
        componentItem: l.componentItem,
        wastePct: l.wastePct,
        qtyBase: l.qtyBase,
        requiredQtyBase: l.requiredQtyBase,
      })),
    };
  }

  /**
   * Standard component requirements for producing `qtyBase` of `itemId` (ADR-031 §5-§6).
   * One level only: a MANUFACTURED component is consumed from stock, not exploded.
   * Without `bomId`, the item's ACTIVE version is used; an explicit version is used as given.
   */
  async explode(tx: Tx, itemId: bigint, qtyBase: Decimal.Value, bomId?: bigint): Promise<BomExplosion> {
    const bom = await tx.bom.findFirst({
      where: bomId !== undefined ? { id: bomId, itemId } : { itemId, status: 'ACTIVE' },
      select: {
        id: true,
        versionNo: true,
        outputQtyBase: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          select: { lineNo: true, componentItemId: true, qtyBase: true, wastePct: true, componentItem: ITEM_REF },
        },
      },
    });
    if (!bom) {
      if (bomId !== undefined) throw DomainError.notFound('Bom', bomId.toString());
      throw new DomainError(ErrorCode.BOM_NOT_ACTIVE, 'This item has no active bill of materials', { itemId: itemId.toString() });
    }
    const produced = new Decimal(qtyBase);
    if (!produced.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'The produced quantity must be greater than zero');
    const ratio = produced.div(new Decimal(bom.outputQtyBase.toString()));
    return {
      bomId: bom.id,
      versionNo: bom.versionNo,
      outputQtyBase: new Decimal(bom.outputQtyBase.toString()),
      lines: bom.lines.map((line) => {
        const base = new Decimal(line.qtyBase.toString());
        const waste = new Decimal(line.wastePct.toString());
        return {
          lineNo: line.lineNo,
          componentItemId: line.componentItemId,
          componentItem: line.componentItem,
          wastePct: waste,
          qtyBase: base,
          requiredQtyBase: round6(base.times(ratio).times(new Decimal(1).plus(waste.div(100)))),
        };
      }),
    };
  }

  /**
   * ADR-032 §7: the stock leaves of `qtyBase` of a recipe. A nested recipe is exploded
   * too; a stocked or MANUFACTURED component is a leaf. Duplicates across the levels are
   * merged, and each leaf is rounded to 6 dp once. The versions are read with a shared lock
   * when `lock` is set (ADR-032 §7), so an activation waits until the sale posts.
   * A recipe with no ACTIVE version (the top one or a nested one) sets `missing` (ADR-032 §1).
   * `bomId` names the top version explicitly (costing a given version); otherwise ACTIVE.
   */
  async explodeToStock(
    tx: Tx,
    companyId: bigint,
    recipeItemId: bigint,
    qtyBase: Decimal.Value,
    lock: boolean,
    bomId?: bigint,
  ): Promise<StockExplosion> {
    const { tenantId } = this.tenant();
    const produced = new Decimal(qtyBase);
    if (!produced.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'The sold quantity must be greater than zero');
    const totals = new Map<bigint, Decimal>();
    let topBomId: bigint | null = null;
    let missing = false;

    const visit = async (itemId: bigint, qty: Decimal, depth: number, ancestors: Set<bigint>, explicitBomId?: bigint): Promise<void> => {
      if (ancestors.has(itemId)) throw new DomainError(ErrorCode.BOM_CYCLE, 'The recipe forms a loop', { itemId: itemId.toString() });
      if (depth > RECIPE_MAX_DEPTH) {
        throw new DomainError(ErrorCode.RECIPE_DEPTH_EXCEEDED, `A recipe nests deeper than ${RECIPE_MAX_DEPTH} levels`, { itemId: itemId.toString() });
      }
      if (lock) {
        if (explicitBomId !== undefined) {
          await tx.$queryRaw`SELECT id FROM boms WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${explicitBomId} LOCK IN SHARE MODE`;
        } else {
          await tx.$queryRaw`SELECT id FROM boms WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND item_id = ${itemId} AND status = 'ACTIVE' LOCK IN SHARE MODE`;
        }
      }
      const bom = await tx.bom.findFirst({
        where: explicitBomId !== undefined ? { id: explicitBomId, companyId, itemId } : { companyId, itemId, status: 'ACTIVE' },
        select: EXPLODE_BOM_SELECT,
      });
      if (!bom) {
        missing = true;
        return;
      }
      if (depth === 0) topBomId = bom.id;
      const ratio = qty.div(new Decimal(bom.outputQtyBase.toString()));
      const next = new Set(ancestors).add(itemId);
      for (const line of bom.lines) {
        const waste = new Decimal(line.wastePct.toString());
        const need = new Decimal(line.qtyBase.toString()).times(ratio).times(new Decimal(1).plus(waste.div(100)));
        if (isRecipe(line.componentItem.itemKind)) {
          await visit(line.componentItemId, need, depth + 1, next);
          if (missing) return;
        } else if (isStocked(line.componentItem.itemKind)) {
          totals.set(line.componentItemId, (totals.get(line.componentItemId) ?? new Decimal(0)).plus(need));
        }
      }
    };

    await visit(recipeItemId, produced, 0, new Set<bigint>(), bomId);
    if (missing) return { bomId: null, missing: true, components: [] };
    const components = [...totals.entries()]
      .map(([itemId, q]) => ({ itemId, qtyBase: round6(q) }))
      .filter((c) => c.qtyBase.gt(0))
      .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
    return { bomId: topBomId, missing: false, components };
  }

  // ------------------------------------------------------------ helpers

  private async detail(db: Tx, companyId: bigint, id: bigint) {
    const bom = await db.bom.findFirst({ where: { id, companyId }, select: DETAIL_SELECT });
    if (!bom) throw DomainError.notFound('Bom', id.toString());
    return bom;
  }

  /** The version's item and status, read in the caller's transaction (after the item lock). */
  private async versionHead(tx: Tx, companyId: bigint, id: bigint) {
    const head = await tx.bom.findFirst({
      where: { id, companyId },
      select: { itemId: true, status: true, item: { select: { itemKind: true } } },
    });
    if (!head) throw DomainError.notFound('Bom', id.toString());
    return head;
  }

  /** The owner of a version: a MANUFACTURED item, or a RECIPE (ADR-032 §6). */
  private async manufacturedItem(tx: Tx, companyId: bigint, itemId: bigint) {
    const item = await tx.item.findFirst({
      where: { companyId, id: itemId },
      select: { id: true, code: true, itemKind: true, isActive: true },
    });
    if (!item || !item.isActive) throw DomainError.notFound('Item', itemId.toString());
    if (item.itemKind !== 'MANUFACTURED' && item.itemKind !== 'RECIPE') {
      throw new DomainError(ErrorCode.BOM_ITEM_NOT_MANUFACTURED, `Item ${item.code} is neither a manufactured item nor a recipe`);
    }
    return item;
  }

  private async nextVersion(tx: Tx, itemId: bigint): Promise<number> {
    const max = await tx.bom.aggregate({ where: { itemId }, _max: { versionNo: true } });
    return (max._max.versionNo ?? 0) + 1;
  }

  /**
   * Checks an incoming content against the database and computes the base
   * quantities (ADR-031 §10): output and components, units of their items,
   * stocked components only (no service, no the item itself).
   */
  private async resolveContent(
    tx: Tx,
    companyId: bigint,
    itemId: bigint,
    ownerKind: ItemKindValue,
    dto: CreateBomDto | UpdateBomDto,
  ): Promise<ResolvedContent> {
    // No output unit given: the item's base unit (no item unit row, as on the documents).
    const outputUnit =
      dto.outputItemUnitId === undefined
        ? null
        : await tx.itemUnit.findFirst({
            where: { id: BigInt(dto.outputItemUnitId) },
            select: { id: true, itemId: true, factorToBase: true },
          });
    if (dto.outputItemUnitId !== undefined && (!outputUnit || outputUnit.itemId !== itemId)) {
      throw new DomainError(ErrorCode.BOM_UNIT_INVALID, 'The output unit does not belong to the item', { itemUnitId: dto.outputItemUnitId });
    }
    const outputQty = new Decimal(dto.outputQty);
    if (!outputQty.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'The output quantity must be greater than zero');
    const outputQtyBase = round6(outputQty.times(outputUnit ? outputUnit.factorToBase.toString() : new Decimal(1)));
    if (!outputQtyBase.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'The output quantity must be greater than zero');
    const appliedCost = round3(new Decimal(dto.appliedCostPerUnit ?? '0'));
    if (appliedCost.lt(0)) throw new DomainError(ErrorCode.VALIDATION, 'The applied cost cannot be negative');

    const componentIds = [...new Set(dto.lines.map((l) => BigInt(l.componentItemId)))];
    const components = await tx.item.findMany({
      where: { companyId, id: { in: componentIds } },
      select: { id: true, code: true, itemKind: true, isActive: true },
    });
    const componentById = new Map(components.map((c) => [c.id, c]));
    for (const cid of componentIds) {
      if (!componentById.has(cid)) throw DomainError.notFound('Item', cid.toString());
    }
    const unitIds = [...new Set(dto.lines.flatMap((l) => (l.itemUnitId === undefined ? [] : [BigInt(l.itemUnitId)])))];
    const units = await tx.itemUnit.findMany({ where: { id: { in: unitIds } }, select: { id: true, itemId: true, factorToBase: true } });
    const unitById = new Map(units.map((u) => [u.id, u]));

    // One line per component (review #62): the voucher keys standards by item and refuses duplicates.
    const seen = new Set<bigint>();
    const lines = dto.lines.map((l: BomLineDto, index): ResolvedLine => {
      const componentItemId = BigInt(l.componentItemId);
      if (seen.has(componentItemId)) {
        throw new DomainError(ErrorCode.BOM_COMPONENT_INVALID, 'A component appears on two lines: merge them', { lineNo: index + 1 });
      }
      seen.add(componentItemId);
      if (componentItemId === itemId) {
        throw new DomainError(ErrorCode.BOM_COMPONENT_INVALID, 'An item cannot be its own component', { lineNo: index + 1 });
      }
      const component = componentById.get(componentItemId)!;
      // ADR-032 §6: a recipe is a component only of another recipe, never of a manufactured item.
      if (isRecipe(component.itemKind)) {
        if (ownerKind !== 'RECIPE') {
          throw new DomainError(ErrorCode.BOM_COMPONENT_INVALID, `Component ${component.code} is a recipe: only a recipe can use it`, { lineNo: index + 1 });
        }
      } else if (!isStocked(component.itemKind)) {
        throw new DomainError(ErrorCode.BOM_COMPONENT_INVALID, `Component ${component.code} is a service`, { lineNo: index + 1 });
      }
      if (!component.isActive) throw DomainError.notFound('Item', componentItemId.toString());
      const unit = l.itemUnitId === undefined ? null : unitById.get(BigInt(l.itemUnitId));
      if (l.itemUnitId !== undefined && (!unit || unit.itemId !== componentItemId)) {
        throw new DomainError(ErrorCode.BOM_UNIT_INVALID, 'The unit does not belong to the component', { lineNo: index + 1 });
      }
      const qty = new Decimal(l.qty);
      if (!qty.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'A component quantity must be greater than zero', { lineNo: index + 1 });
      const wastePct = new Decimal(l.wastePct ?? '0');
      if (wastePct.lt(0) || wastePct.gt(100)) {
        throw new DomainError(ErrorCode.VALIDATION, 'The waste percentage must be between 0 and 100', { lineNo: index + 1 });
      }
      return {
        lineNo: index + 1,
        componentItemId,
        itemUnitId: unit ? unit.id : null,
        qty: round6(qty),
        qtyBase: round6(qty.times(unit ? unit.factorToBase.toString() : new Decimal(1))),
        wastePct,
        note: l.note ?? null,
      };
    });

    return {
      outputQty: round6(outputQty),
      outputItemUnitId: outputUnit ? outputUnit.id : null,
      outputQtyBase,
      appliedCostPerUnit: appliedCost,
      note: dto.note ?? null,
      lines,
    };
  }

  /**
   * Refuses the activation when the item is reachable from its own components
   * through the ACTIVE versions (ADR-031 §5). The item's own version is taken
   * as the candidate, replacing its current ACTIVE one.
   */
  private async assertNoLoop(tx: Tx, companyId: bigint, itemId: bigint, componentIds: bigint[]): Promise<void> {
    const active = await tx.bom.findMany({
      where: { companyId, status: 'ACTIVE', NOT: { itemId } },
      select: { itemId: true, lines: { select: { componentItemId: true } } },
    });
    const graph = new Map<bigint, bigint[]>();
    for (const bom of active) graph.set(bom.itemId, bom.lines.map((l) => l.componentItemId));
    graph.set(itemId, componentIds);

    const seen = new Set<bigint>();
    const stack = [...componentIds];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === itemId) {
        throw new DomainError(ErrorCode.BOM_CYCLE, 'The bill of materials forms a loop', { itemId: itemId.toString() });
      }
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of graph.get(node) ?? []) stack.push(next);
    }
  }
}

/** Line rows for createMany (the tenant scope is added by the scoped client). */
function lineRows(tenantId: bigint, bomId: bigint, lines: ResolvedLine[]) {
  return lines.map((l) => ({
    tenantId,
    bomId,
    lineNo: l.lineNo,
    componentItemId: l.componentItemId,
    itemUnitId: l.itemUnitId,
    qty: l.qty,
    qtyBase: l.qtyBase,
    wastePct: l.wastePct,
    note: l.note,
  }));
}
