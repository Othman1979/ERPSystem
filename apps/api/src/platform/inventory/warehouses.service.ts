import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/inventory.dto.js';
import { PlanLimitsService } from '../../common/plan-limits/plan-limits.service.js';

@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
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

  async list() {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.warehouse.findMany({
      where: { companyId },
      include: {
        branch: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { balances: true } },
      },
      orderBy: { code: 'asc' },
    });
  }

  async get(id: bigint) {
    const { db } = this.tenant();
    const wh = await db.warehouse.findFirst({
      where: { id },
      include: { branch: true },
    });
    if (!wh) throw DomainError.notFound('Warehouse', id.toString());
    return wh;
  }

  async create(dto: CreateWarehouseDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();

    await this.planLimits.assertWarehouseSlotAvailable();

    if (dto.branchId) {
      const branch = await db.branch.findFirst({ where: { id: BigInt(dto.branchId), companyId } });
      if (!branch) throw DomainError.notFound('Branch', dto.branchId);
    }

    try {
      const wh = await db.warehouse.create({
        data: {
          tenantId,
          companyId,
          branchId: dto.branchId ? BigInt(dto.branchId) : null,
          code: dto.code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn ?? null,
          address: dto.address ?? null,
          createdBy: cls.get('userId') ?? null,
        },
      });
      await this.audit.log({
        action: 'warehouse.create',
        entityType: 'warehouse',
        entityId: wh.id,
        after: { code: dto.code, nameAr: dto.nameAr },
      });
      return wh;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.CONFLICT, 'Warehouse code already exists');
      }
      throw err;
    }
  }

  async update(id: bigint, dto: UpdateWarehouseDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const existing = await db.warehouse.findFirst({ where: { id, companyId } });
    if (!existing) throw DomainError.notFound('Warehouse', id.toString());
    if (dto.branchId) {
      const branch = await db.branch.findFirst({ where: { id: BigInt(dto.branchId), companyId } });
      if (!branch) throw DomainError.notFound('Branch', dto.branchId);
    }
    if (dto.isActive === false) {
      const movements = await db.stockMovement.count({ where: { warehouseId: id } });
      if (movements > 0) {
        throw new DomainError(
          ErrorCode.CONFLICT,
          'Cannot deactivate a warehouse that has stock movements',
        );
      }
    }
    const { branchId, ...rest } = dto;
    return db.warehouse.update({
      where: { id },
      data: {
        ...rest,
        ...(branchId !== undefined ? { branchId: branchId ? BigInt(branchId) : null } : {}),
        updatedBy: cls.get('userId') ?? null,
      },
    });
  }
}
