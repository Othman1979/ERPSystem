import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PlanLimitsService } from '../../common/plan-limits/plan-limits.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateBranchDto, UpdateBranchDto } from './dto/branches.dto.js';

function serialize(b: {
  id: bigint;
  code: string;
  nameAr: string;
  nameEn: string | null;
  address: string | null;
  isActive: boolean;
  companyId: bigint;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: b.id.toString(),
    code: b.code,
    nameAr: b.nameAr,
    nameEn: b.nameEn,
    address: b.address,
    isActive: b.isActive,
    companyId: b.companyId.toString(),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planLimits: PlanLimitsService,
    private readonly audit: AuditService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return this.prisma.forTenant(tenantId);
  }

  async list() {
    const rows = await this.tenant().branch.findMany({ orderBy: { code: 'asc' } });
    return rows.map(serialize);
  }

  private async companyId(): Promise<bigint> {
    const company = await this.tenant().company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  async create(dto: CreateBranchDto) {
    await this.planLimits.assertBranchSlotAvailable();
    const companyId = await this.companyId();
    const cls = ClsServiceManager.getClsService<RequestContext>();
    try {
      const branch = await this.tenant().branch.create({
        data: {
          tenantId: ClsServiceManager.getClsService<RequestContext>().get('tenantId')!,
          companyId,
          code: dto.code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn ?? null,
          address: dto.address ?? null,
          createdBy: cls.get('userId') ?? null,
        },
      });
      await this.audit.log({
        action: 'branch.create',
        entityType: 'branch',
        entityId: branch.id,
        after: { code: dto.code, nameAr: dto.nameAr },
      });
      return serialize(branch);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(ErrorCode.CONFLICT, 'Branch code already exists');
      }
      throw err;
    }
  }

  async update(id: bigint, dto: UpdateBranchDto) {
    const prisma = this.tenant();
    const existing = await prisma.branch.findFirst({ where: { id } });
    if (!existing) throw DomainError.notFound('Branch', id.toString());

    const branch = await prisma.branch.update({
      where: { id },
      data: {
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        address: dto.address,
        isActive: dto.isActive,
        updatedBy: ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null,
      },
    });
    await this.audit.log({
      action: 'branch.update',
      entityType: 'branch',
      entityId: id,
      before: { nameAr: existing.nameAr, isActive: existing.isActive },
      after: dto,
    });
    return serialize(branch);
  }

  async deactivate(id: bigint) {
    const prisma = this.tenant();
    const existing = await prisma.branch.findFirst({ where: { id } });
    if (!existing) throw DomainError.notFound('Branch', id.toString());
    const branch = await prisma.branch.update({
      where: { id },
      data: { isActive: false },
    });
    await this.audit.log({
      action: 'branch.deactivate',
      entityType: 'branch',
      entityId: id,
    });
    return serialize(branch);
  }
}
