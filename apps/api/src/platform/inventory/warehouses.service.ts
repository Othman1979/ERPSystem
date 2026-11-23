import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/inventory.dto.js';
import { PlanLimitsService } from '../../common/plan-limits/plan-limits.service.js';
import { currentCompanyFilter } from '../../common/cls/current-company.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';

@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
    partyUsage: PartyUsageRegistry,
  ) {
    partyUsage.register('inventory', async (tx, partyId) =>
      (await tx.warehouse.findFirst({ where: { consignmentSupplierId: partyId }, select: { id: true } })) ? 'warehouses' : null,
    );
  }

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

  async list() {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.warehouse.findMany({
      where: { companyId },
      include: {
        branch: { select: { id: true, code: true, nameAr: true } },
        consignmentSupplier: { select: { id: true, code: true, nameAr: true, nameEn: true, partyType: true } },
        _count: { select: { balances: true } },
      },
      orderBy: { code: 'asc' },
    });
  }

  async get(id: bigint) {
    const { db } = this.tenant();
    const wh = await db.warehouse.findFirst({
      where: { id },
      include: {
        branch: true,
        consignmentSupplier: { select: { id: true, code: true, nameAr: true, nameEn: true, partyType: true } },
      },
    });
    if (!wh) throw DomainError.notFound('Warehouse', id.toString());
    return wh;
  }

  /**
   * An active warehouse of the company with its branch, for another module's
   * document header (module boundary); NOT_FOUND otherwise.
   */
  async activeRef(id: bigint): Promise<{ id: bigint; branchId: bigint | null; consignmentSupplierId: bigint | null }> {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const wh = await db.warehouse.findFirst({
      where: { id, companyId, isActive: true },
      select: { id: true, branchId: true, consignmentSupplierId: true },
    });
    if (!wh) throw DomainError.notFound('Warehouse', id.toString());
    return wh;
  }

  async activeOwnedRef(id: bigint) {
    const wh = await this.activeRef(id);
    if (wh.consignmentSupplierId !== null) {
      const { db } = this.tenant();
      const companyId = await this.companyId(db);
      const company = await db.company.findFirst({ where: { id: companyId }, select: { consignmentEnabled: true } });
      if (!company?.consignmentEnabled) {
        throw new DomainError(ErrorCode.CONSIGNMENT_DISABLED, 'Temporary receipt is disabled for this company');
      }
      throw new DomainError(ErrorCode.CONSIGNMENT_WAREHOUSE_NOT_ALLOWED, 'This document cannot use a temporary warehouse');
    }
    return wh;
  }

  async create(dto: CreateWarehouseDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();

    if (dto.branchId) {
      const branch = await db.branch.findFirst({ where: { id: BigInt(dto.branchId), companyId } });
      if (!branch) throw DomainError.notFound('Branch', dto.branchId);
    }
    const supplierId = dto.consignmentSupplierId ? BigInt(dto.consignmentSupplierId) : null;
    if (supplierId !== null) {
      const company = await db.company.findFirst({ where: { id: companyId }, select: { consignmentEnabled: true } });
      if (!company?.consignmentEnabled) {
        throw new DomainError(ErrorCode.CONSIGNMENT_DISABLED, 'Temporary receipt is disabled for this company');
      }
      await this.assertConsignmentSupplier(db, companyId, supplierId);
    }

    try {
      // The plan check locks the tenant row, so it and the insert share one transaction.
      const wh = await db.$transaction(async (tx) => {
        await this.planLimits.assertWarehouseSlotAvailable(tx);
        return tx.warehouse.create({
          data: {
            tenantId,
            companyId,
            branchId: dto.branchId ? BigInt(dto.branchId) : null,
            consignmentSupplierId: supplierId,
            code: dto.code,
            nameAr: dto.nameAr,
            nameEn: dto.nameEn ?? null,
            address: dto.address ?? null,
            createdBy: cls.get('userId') ?? null,
          },
        });
      });
      await this.audit.log({
        action: 'warehouse.create',
        entityType: 'warehouse',
        entityId: wh.id,
        after: { code: dto.code, nameAr: dto.nameAr },
      });
      return db.warehouse.findFirstOrThrow({
        where: { id: wh.id },
        include: { consignmentSupplier: { select: { id: true, code: true, nameAr: true, nameEn: true, partyType: true } } },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.CONFLICT, 'Warehouse code already exists');
      }
      throw err;
    }
  }

  async update(id: bigint, dto: UpdateWarehouseDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const existing = await db.warehouse.findFirst({ where: { id, companyId } });
    if (!existing) throw DomainError.notFound('Warehouse', id.toString());
    if (dto.branchId) {
      const branch = await db.branch.findFirst({ where: { id: BigInt(dto.branchId), companyId } });
      if (!branch) throw DomainError.notFound('Branch', dto.branchId);
    }
    if (dto.consignmentSupplierId !== undefined) {
      const company = await db.company.findFirst({ where: { id: companyId }, select: { consignmentEnabled: true } });
      if (!company?.consignmentEnabled) {
        throw new DomainError(ErrorCode.CONSIGNMENT_DISABLED, 'Temporary receipt is disabled for this company');
      }
    }
    if (dto.consignmentSupplierId === undefined && dto.isActive === false) {
      const movements = await db.stockMovement.count({ where: { warehouseId: id } });
      if (movements > 0) {
        throw new DomainError(
          ErrorCode.CONFLICT,
          'Cannot deactivate a warehouse that has stock movements',
        );
      }
    }
    const { branchId, consignmentSupplierId, ...rest } = dto;
    const data = {
      ...rest,
      ...(branchId !== undefined ? { branchId: branchId ? BigInt(branchId) : null } : {}),
      ...(consignmentSupplierId !== undefined
        ? { consignmentSupplierId: consignmentSupplierId ? BigInt(consignmentSupplierId) : null }
        : {}),
      updatedBy: cls.get('userId') ?? null,
    };
    if (consignmentSupplierId !== undefined) {
      const requestedSupplierId = consignmentSupplierId ? BigInt(consignmentSupplierId) : null;
      await db.$transaction(async (tx) => {
        const [warehouse] = await tx.$queryRaw<{ consignment_supplier_id: bigint | null }[]>`
          SELECT consignment_supplier_id FROM warehouses
           WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id}
           FOR UPDATE`;
        if (!warehouse) throw DomainError.notFound('Warehouse', id.toString());
        const movements = await tx.stockMovement.count({ where: { tenantId, companyId, warehouseId: id } });
        if (requestedSupplierId !== warehouse.consignment_supplier_id && movements > 0) {
          throw new DomainError(ErrorCode.CONFLICT, 'A temporary-receipt supplier cannot change after the first stock movement');
        }
        if (requestedSupplierId !== warehouse.consignment_supplier_id && requestedSupplierId !== null) {
          await this.assertConsignmentSupplier(tx, companyId, requestedSupplierId);
        }
        if (dto.isActive === false && movements > 0) {
          throw new DomainError(
            ErrorCode.CONFLICT,
            'Cannot deactivate a warehouse that has stock movements',
          );
        }
        await tx.warehouse.update({ where: { id }, data });
      });
    } else {
      await db.warehouse.update({ where: { id }, data });
    }
    return db.warehouse.findFirstOrThrow({
      where: { id },
      include: { consignmentSupplier: { select: { id: true, code: true, nameAr: true, nameEn: true, partyType: true } } },
    });
  }

  private async assertConsignmentSupplier(
    db: Pick<Prisma.TransactionClient, 'party'>,
    companyId: bigint,
    supplierId: bigint,
  ) {
    const supplier = await db.party.findFirst({
      where: { id: supplierId, companyId, partyType: { in: ['SUPPLIER', 'BOTH'] }, isActive: true },
      select: { id: true },
    });
    if (!supplier) {
      throw new DomainError(ErrorCode.PARTY_TYPE_MISMATCH, 'Temporary warehouse requires an active supplier of this company');
    }
  }
}
