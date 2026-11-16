import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isStocked } from '../../common/inventory/item-kind.js';
import { findPage } from '../../common/paging/find-page.js';
import { pageWindow } from '../../common/paging/page-query.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BomLineDto, CreateBomDto, ListBomsQueryDto, UpdateBomDto } from './dto/bom.dto.js';

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
  componentItem: { id: bigint; code: string; nameAr: string; nameEn: string | null; itemKind: 'STOCK' | 'SERVICE' | 'MANUFACTURED'; baseUnit: { id: bigint; code: string; nameAr: string; nameEn: string | null } };
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

/** Lock one item row (the first lock of every BOM write, ADR-031 §5). */
async function lockItem(tx: Tx, tenantId: bigint, itemId: bigint): Promise<void> {
  await tx.$queryRaw`SELECT id FROM items WHERE tenant_id = ${tenantId} AND id = ${itemId} FOR UPDATE`;
}

/**
 * Bill of materials versions for MANUFACTURED items (ADR-031 §5).
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
      const content = await this.resolveContent(tx, companyId, item.id, dto);
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
      const content = await this.resolveContent(tx, companyId, current.itemId, dto);
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
    const itemId = await db.$transaction(async (tx) => {
      // Company row first: serialises activations, so the loop check sees the others' results.
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const head = await this.versionHead(tx, companyId, id);
      await lockItem(tx, tenantId, head.itemId);
      const current = await tx.bom.findFirst({
        where: { id, companyId },
        select: { itemId: true, status: true, versionNo: true, lines: { select: { componentItemId: true } } },
      });
      if (!current) throw DomainError.notFound('Bom', id.toString());
      if (current.status === 'ACTIVE') return current.itemId;
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
      return current.itemId;
    });
    await this.audit.log({ action: 'bom.activate', entityType: 'bom', entityId: id, after: { itemId: itemId.toString() } });
    return this.get(id);
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
    });
    await this.audit.log({ action: 'bom.deactivate', entityType: 'bom', entityId: id, after: null });
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

  // ------------------------------------------------------------ helpers

  private async detail(db: Tx, companyId: bigint, id: bigint) {
    const bom = await db.bom.findFirst({ where: { id, companyId }, select: DETAIL_SELECT });
    if (!bom) throw DomainError.notFound('Bom', id.toString());
    return bom;
  }

  /** The version's item and status, read in the caller's transaction (after the item lock). */
  private async versionHead(tx: Tx, companyId: bigint, id: bigint) {
    const head = await tx.bom.findFirst({ where: { id, companyId }, select: { itemId: true, status: true } });
    if (!head) throw DomainError.notFound('Bom', id.toString());
    return head;
  }

  private async manufacturedItem(tx: Tx, companyId: bigint, itemId: bigint) {
    const item = await tx.item.findFirst({
      where: { companyId, id: itemId },
      select: { id: true, code: true, itemKind: true, isActive: true },
    });
    if (!item || !item.isActive) throw DomainError.notFound('Item', itemId.toString());
    if (item.itemKind !== 'MANUFACTURED') {
      throw new DomainError(ErrorCode.BOM_ITEM_NOT_MANUFACTURED, `Item ${item.code} is not a manufactured item`);
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
  private async resolveContent(tx: Tx, companyId: bigint, itemId: bigint, dto: CreateBomDto | UpdateBomDto): Promise<ResolvedContent> {
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

    const lines = dto.lines.map((l: BomLineDto, index): ResolvedLine => {
      const componentItemId = BigInt(l.componentItemId);
      if (componentItemId === itemId) {
        throw new DomainError(ErrorCode.BOM_COMPONENT_INVALID, 'An item cannot be its own component', { lineNo: index + 1 });
      }
      const component = componentById.get(componentItemId)!;
      if (!isStocked(component.itemKind)) {
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
