import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { ChartProvisioningService } from './chart-provisioning.service.js';
import type { CreateCompanyDto, UpdateCompanyEntryDto } from './dto/companies.dto.js';

/** ADR-040 §4: the companies of a tenant. Creating and changing them is the owner's. */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ChartProvisioningService,
    private readonly audit: AuditService,
  ) {}

  private context() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return {
      tenantId,
      db: this.prisma.forTenant(tenantId),
      userId: cls.get('userId'),
      membershipId: cls.get('membershipId'),
      isOwner: cls.get('roleCode') === 'OWNER',
      companyId: cls.get('companyId'),
    };
  }

  private assertOwner(isOwner: boolean) {
    if (!isOwner) throw new DomainError(ErrorCode.FORBIDDEN, 'Only the owner manages companies');
  }

  /** The caller's companies: every company for the owner, else the active ones the member may use. */
  async list() {
    const { db, membershipId, isOwner, companyId } = this.context();
    const assigned = isOwner
      ? []
      : await db.membershipCompany.findMany({ where: { membershipId }, select: { companyId: true } });
    const restricted = new Set(assigned.map((a) => a.companyId));
    const rows = await db.company.findMany({
      where: isOwner ? {} : { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true, legalNameAr: true, legalNameEn: true, isActive: true },
    });
    return rows
      .filter((c) => restricted.size === 0 || restricted.has(c.id))
      .map((c) => ({ ...c, id: c.id.toString(), current: c.id === companyId }));
  }

  async create(dto: CreateCompanyDto) {
    const { tenantId, db, userId, isOwner, companyId } = this.context();
    this.assertOwner(isOwner);
    const current = companyId
      ? await db.company.findFirst({ where: { id: companyId }, select: { baseCurrencyId: true, timezone: true } })
      : null;
    const company = await db.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: {
          tenantId,
          legalNameAr: dto.legalNameAr,
          legalNameEn: dto.legalNameEn ?? null,
          baseCurrencyId: current?.baseCurrencyId ?? null,
          ...(current ? { timezone: current.timezone } : {}),
        },
      });
      await tx.branch.create({
        data: { tenantId, companyId: created.id, code: 'MAIN', nameAr: 'الفرع الرئيسي' },
      });
      await this.provisioning.provision(tx, tenantId, created.id, userId);
      return created;
    });
    await this.audit.log({
      action: 'company.create',
      entityType: 'company',
      entityId: company.id,
      after: { legalNameAr: company.legalNameAr, legalNameEn: company.legalNameEn },
    });
    return (await this.list()).find((c) => c.id === company.id.toString())!;
  }

  async update(id: bigint, dto: UpdateCompanyEntryDto) {
    const { tenantId, db, isOwner } = this.context();
    this.assertOwner(isOwner);
    const before = await db.company.findFirst({
      where: { id },
      select: { legalNameAr: true, legalNameEn: true, isActive: true },
    });
    if (!before) throw DomainError.notFound('Company', id.toString());
    await db.$transaction(async (tx) => {
      if (dto.isActive === false && before.isActive) {
        // Serialise deactivations: two at once must not both see the other company as active.
        await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} ORDER BY id FOR UPDATE`;
        const others = await tx.company.count({ where: { isActive: true, id: { not: id } } });
        if (others === 0) {
          throw new DomainError(ErrorCode.CONFLICT, 'The last active company cannot be deactivated');
        }
      }
      await tx.company.update({
        where: { id },
        data: {
          ...(dto.legalNameAr !== undefined ? { legalNameAr: dto.legalNameAr } : {}),
          ...(dto.legalNameEn !== undefined ? { legalNameEn: dto.legalNameEn || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    });
    await this.audit.log({ action: 'company.update', entityType: 'company', entityId: id, before, after: dto });
    return (await this.list()).find((c) => c.id === id.toString())!;
  }
}
