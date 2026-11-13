import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  BarcodeDto,
  CreateItemDto,
  CreateItemGroupDto,
  ItemUnitInputDto,
  UpdateItemDto,
  UpdateItemGroupDto,
} from './dto/inventory.dto.js';

/**
 * Item catalog: groups, items, item units and barcodes (§7.4).
 * All lookups are tenant-scoped via tenantScopedPrisma.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
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

  // ------------------------------------------------------------------ groups

  listGroups() {
    const { db } = this.tenant();
    return db.itemGroup.findMany({ orderBy: { code: 'asc' } });
  }

  async createGroup(dto: CreateItemGroupDto) {
    const { tenantId, db } = this.tenant();
    if (dto.parentId) {
      const parent = await db.itemGroup.findFirst({ where: { id: BigInt(dto.parentId) } });
      if (!parent) throw DomainError.notFound('ItemGroup', dto.parentId);
    }
    try {
      const group = await db.itemGroup.create({
        data: {
          tenantId,
          code: dto.code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn ?? null,
          parentId: dto.parentId ? BigInt(dto.parentId) : null,
        },
      });
      await this.audit.log({
        action: 'item_group.create',
        entityType: 'item_group',
        entityId: group.id,
        after: { code: dto.code },
      });
      return group;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.CONFLICT, 'Item group code already exists');
      }
      throw err;
    }
  }

  async updateGroup(id: bigint, dto: UpdateItemGroupDto) {
    const { db } = this.tenant();
    const existing = await db.itemGroup.findFirst({ where: { id } });
    if (!existing) throw DomainError.notFound('ItemGroup', id.toString());
    if (dto.isActive === false) {
      const items = await db.item.count({ where: { itemGroupId: id, isActive: true } });
      if (items > 0) {
        throw new DomainError(
          ErrorCode.CONFLICT,
          'Cannot deactivate a group that has active items',
        );
      }
    }
    return db.itemGroup.update({ where: { id }, data: dto });
  }

  // -------------------------------------------------------------------- items

  async listItems(query?: { search?: string; itemKind?: string; isActive?: string }) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.item.findMany({
      where: {
        companyId,
        ...(query?.search
          ? {
              OR: [
                { code: { contains: query.search } },
                { nameAr: { contains: query.search } },
                { nameEn: { contains: query.search } },
              ],
            }
          : {}),
        ...(query?.itemKind ? { itemKind: query.itemKind as 'STOCK' | 'SERVICE' } : {}),
        ...(query?.isActive ? { isActive: query.isActive === 'true' } : {}),
      },
      include: {
        baseUnit: { select: { id: true, code: true, nameAr: true } },
        itemGroup: { select: { id: true, code: true, nameAr: true } },
        taxCategory: { select: { id: true, code: true, nameAr: true } },
        defaultWarehouse: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { barcodes: true, units: true } },
      },
      orderBy: { code: 'asc' },
      take: 500,
    });
  }

  async getItem(id: bigint) {
    const { db } = this.tenant();
    const item = await db.item.findFirst({
      where: { id },
      include: {
        baseUnit: true,
        itemGroup: true,
        taxCategory: true,
        units: { include: { unit: true } },
        barcodes: { include: { itemUnit: { include: { unit: true } } } },
        costs: true,
        defaultWarehouse: { select: { id: true, code: true, nameAr: true } },
      },
    });
    if (!item) throw DomainError.notFound('Item', id.toString());
    return item;
  }

  private async validateItemRefs(
    db: ReturnType<PrismaService['forTenant']>,
    dto: {
      itemGroupId?: string;
      baseUnitId: string;
      taxCategoryId?: string;
      defaultWarehouseId?: string | null;
    },
  ) {
    const group = dto.itemGroupId
      ? await db.itemGroup.findFirst({ where: { id: BigInt(dto.itemGroupId) } })
      : null;
    if (dto.itemGroupId && !group) {
      throw DomainError.notFound('ItemGroup', dto.itemGroupId);
    }
    const unit = await db.unit.findFirst({
      where: { id: BigInt(dto.baseUnitId), isActive: true },
    });
    if (!unit) throw DomainError.notFound('Unit', dto.baseUnitId);
    if (dto.taxCategoryId) {
      const tax = await db.taxCategory.findFirst({
        where: { id: BigInt(dto.taxCategoryId), isActive: true },
      });
      if (!tax) throw DomainError.notFound('TaxCategory', dto.taxCategoryId);
    }
    if (dto.defaultWarehouseId) {
      const wh = await db.warehouse.findFirst({
        where: { id: BigInt(dto.defaultWarehouseId), isActive: true },
      });
      if (!wh) throw DomainError.notFound('Warehouse', dto.defaultWarehouseId);
    }
    return { group, unit };
  }

  async createItem(dto: CreateItemDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();
    await this.validateItemRefs(db, dto);

    try {
      const item = await db.$transaction(async (tx) => {
        const created = await tx.item.create({
          data: {
            tenantId,
            companyId,
            code: dto.code,
            nameAr: dto.nameAr,
            nameEn: dto.nameEn ?? null,
            description: dto.description ?? null,
            itemGroupId: dto.itemGroupId ? BigInt(dto.itemGroupId) : null,
            itemKind: dto.itemKind ?? 'STOCK',
            baseUnitId: BigInt(dto.baseUnitId),
            taxCategoryId: dto.taxCategoryId ? BigInt(dto.taxCategoryId) : null,
            salePrice: dto.salePrice ?? null,
            purchasePrice: dto.purchasePrice ?? null,
            minStock: dto.minStock ?? '0',
            maxStock: dto.maxStock ?? null,
            defaultWarehouseId: dto.defaultWarehouseId ? BigInt(dto.defaultWarehouseId) : null,
            salePriceIncludesTax: dto.salePriceIncludesTax ?? false,
            imageUrl: dto.imageUrl ?? null,
            createdBy: cls.get('userId') ?? null,
          },
        });
        if (dto.units?.length) {
          await this.replaceItemUnits(tx, tenantId, created.id, dto.units);
        }
        return created;
      });
      await this.audit.log({
        action: 'item.create',
        entityType: 'item',
        entityId: item.id,
        after: { code: dto.code, nameAr: dto.nameAr },
      });
      return this.getItem(item.id);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.CONFLICT, 'Item code already exists');
      }
      throw err;
    }
  }

  async updateItem(id: bigint, dto: UpdateItemDto) {
    const { db } = this.tenant();
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const existing = await db.item.findFirst({ where: { id } });
    if (!existing) throw DomainError.notFound('Item', id.toString());
    if (dto.isActive === false && existing.isActive) {
      const stock = await db.stockBalance.findFirst({
        where: { itemId: id, qtyOnHand: { not: '0' } },
        select: { id: true },
      });
      if (stock) {
        throw new DomainError(
          ErrorCode.CONFLICT,
          `Item ${existing.code} has stock on hand and cannot be deactivated`,
        );
      }
    }
    if (dto.itemGroupId) {
      const group = await db.itemGroup.findFirst({ where: { id: BigInt(dto.itemGroupId) } });
      if (!group) throw DomainError.notFound('ItemGroup', dto.itemGroupId);
    }
    if (dto.taxCategoryId) {
      const tax = await db.taxCategory.findFirst({
        where: { id: BigInt(dto.taxCategoryId), isActive: true },
      });
      if (!tax) throw DomainError.notFound('TaxCategory', dto.taxCategoryId);
    }
    if (dto.defaultWarehouseId) {
      const wh = await db.warehouse.findFirst({
        where: { id: BigInt(dto.defaultWarehouseId), isActive: true },
      });
      if (!wh) throw DomainError.notFound('Warehouse', dto.defaultWarehouseId);
    }
    const { itemGroupId, taxCategoryId, defaultWarehouseId, ...rest } = dto;
    return db.item.update({
      where: { id },
      data: {
        ...rest,
        ...(itemGroupId !== undefined
          ? { itemGroupId: itemGroupId ? BigInt(itemGroupId) : null }
          : {}),
        ...(taxCategoryId !== undefined
          ? { taxCategoryId: taxCategoryId ? BigInt(taxCategoryId) : null }
          : {}),
        ...(defaultWarehouseId !== undefined
          ? { defaultWarehouseId: defaultWarehouseId ? BigInt(defaultWarehouseId) : null }
          : {}),
        updatedBy: cls.get('userId') ?? null,
      },
    });
  }

  // ------------------------------------------------------------ item units

  /**
   * Replaces the unit set of an item in place: existing rows (matched on unitId)
   * are updated so their ids stay stable for invoice lines and barcodes; units
   * missing from the request are deleted unless still referenced.
   */
  async replaceItemUnits(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    itemId: bigint,
    units: ItemUnitInputDto[],
  ) {
    // Normalise every factor to 6 dp first; a factor that rounds to 0 is rejected.
    const normalised = units.map((u) => {
      const factor = round6(new Decimal(u.factorToBase));
      if (!factor.gt(0)) {
        throw new DomainError(ErrorCode.VALIDATION, 'factorToBase must be > 0');
      }
      return { input: u, unitId: BigInt(u.unitId), factor };
    });

    const requestedUnitIds = new Set(normalised.map((n) => n.unitId.toString()));
    const existingRows = await tx.itemUnit.findMany({
      where: { tenantId, itemId },
      select: { id: true, unitId: true, unit: { select: { code: true } } },
    });
    for (const row of existingRows) {
      if (requestedUnitIds.has(row.unitId.toString())) continue;
      await this.assertItemUnitNotReferenced(tx, tenantId, row.id, row.unit.code);
      await tx.itemUnit.delete({ where: { tenantId_id: { tenantId, id: row.id } } });
    }

    for (const { input: u, unitId, factor } of normalised) {
      const unit = await tx.unit.findFirst({
        where: { tenantId, id: unitId, isActive: true },
      });
      if (!unit) throw DomainError.notFound('Unit', u.unitId);

      const existing = await tx.itemUnit.findFirst({
        where: { tenantId, itemId, unitId },
        select: { id: true, factorToBase: true },
      });
      if (existing) {
        if (!existing.factorToBase.eq(factor)) {
          await this.assertFactorChangeAllowed(tx, tenantId, existing.id, unit.code);
        }
        await tx.itemUnit.update({
          where: { tenantId_id: { tenantId, id: existing.id } },
          data: {
            factorToBase: factor,
            isDefaultSale: u.isDefaultSale ?? false,
            isDefaultPurchase: u.isDefaultPurchase ?? false,
          },
        });
      } else {
        await tx.itemUnit.create({
          data: {
            tenantId,
            itemId,
            unitId,
            factorToBase: factor,
            isDefaultSale: u.isDefaultSale ?? false,
            isDefaultPurchase: u.isDefaultPurchase ?? false,
          },
        });
      }
    }
  }

  /** Refuses removal of an item unit that invoice lines or barcodes still point to. */
  private async assertItemUnitNotReferenced(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    itemUnitId: bigint,
    unitCode: string,
  ) {
    const salesLines = await tx.salesInvoiceLine.count({ where: { tenantId, itemUnitId } });
    const purchaseLines = await tx.purchaseInvoiceLine.count({ where: { tenantId, itemUnitId } });
    const barcodes = await tx.itemBarcode.count({ where: { tenantId, itemUnitId } });
    if (salesLines + purchaseLines + barcodes > 0) {
      throw new DomainError(
        ErrorCode.CONFLICT,
        `Unit ${unitCode} is used by documents or barcodes and cannot be removed`,
      );
    }
  }

  /** Refuses a factor change for a unit any invoice line uses: a draft keeps the qty_base of the old factor. */
  private async assertFactorChangeAllowed(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    itemUnitId: bigint,
    unitCode: string,
  ) {
    const postedSales = await tx.salesInvoiceLine.count({
      where: { tenantId, itemUnitId },
    });
    const postedPurchases = await tx.purchaseInvoiceLine.count({
      where: { tenantId, itemUnitId },
    });
    if (postedSales + postedPurchases > 0) {
      throw new DomainError(
        ErrorCode.CONFLICT,
        `Unit ${unitCode} is used by documents and its factor cannot be changed`,
      );
    }
  }

  async setItemUnits(itemId: bigint, units: ItemUnitInputDto[]) {
    const { tenantId, db } = this.tenant();
    const item = await db.item.findFirst({ where: { id: itemId } });
    if (!item) throw DomainError.notFound('Item', itemId.toString());
    await db.$transaction((tx) => this.replaceItemUnits(tx, tenantId, itemId, units));
    return this.getItem(itemId);
  }

  // -------------------------------------------------------------- barcodes

  async addBarcode(itemId: bigint, dto: BarcodeDto) {
    const { tenantId, db } = this.tenant();
    const item = await db.item.findFirst({ where: { id: itemId } });
    if (!item) throw DomainError.notFound('Item', itemId.toString());
    if (dto.itemUnitId) {
      const iu = await db.itemUnit.findFirst({
        where: { tenantId, id: BigInt(dto.itemUnitId), itemId },
      });
      if (!iu) throw DomainError.notFound('ItemUnit', dto.itemUnitId);
    }
    try {
      return await db.itemBarcode.create({
        data: {
          tenantId,
          itemId,
          itemUnitId: dto.itemUnitId ? BigInt(dto.itemUnitId) : null,
          barcode: dto.barcode,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.CONFLICT, 'Barcode already exists');
      }
      throw err;
    }
  }

  async removeBarcode(barcodeId: bigint) {
    const { db } = this.tenant();
    const bc = await db.itemBarcode.findFirst({ where: { id: barcodeId } });
    if (!bc) throw DomainError.notFound('ItemBarcode', barcodeId.toString());
    await db.itemBarcode.delete({ where: { id: barcodeId } });
    return { deleted: true };
  }

  async findByBarcode(barcode: string) {
    const { db } = this.tenant();
    const bc = await db.itemBarcode.findFirst({
      where: { barcode },
      include: {
        item: {
          include: {
            baseUnit: { select: { code: true, nameAr: true } },
            units: { include: { unit: { select: { code: true, nameAr: true } } } },
          },
        },
      },
    });
    if (!bc) throw DomainError.notFound('ItemBarcode', barcode);
    return bc.item;
  }
}
