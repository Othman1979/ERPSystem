import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ACCOUNT_MAPPING_KEYS } from './chart-template.js';
import { BulkMappingsDto, UpsertMappingDto } from './dto/accounting.dto.js';

@Injectable()
export class MappingsService {
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

  async list() {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const rows = await db.accountMapping.findMany({
      where: { companyId },
      include: { account: { select: { id: true, code: true, nameAr: true } } },
    });
    const byKey = new Map(rows.map((r) => [r.mappingKey, r]));
    return ACCOUNT_MAPPING_KEYS.map((key) => ({
      mappingKey: key,
      accountId: byKey.get(key)?.accountId.toString() ?? null,
      account: byKey.get(key)?.account ?? null,
    }));
  }

  private async validateAccount(db: ReturnType<PrismaService['forTenant']>, companyId: bigint, accountId: bigint) {
    const account = await db.account.findFirst({
      where: { id: accountId, companyId, isActive: true },
    });
    if (!account) throw DomainError.notFound('Account', accountId.toString());
    if (!account.isPostable) {
      throw new DomainError(ErrorCode.VALIDATION, 'Control accounts must be postable');
    }
    return account;
  }

  async upsert(dto: UpsertMappingDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    if (!ACCOUNT_MAPPING_KEYS.includes(dto.mappingKey as never)) {
      throw new DomainError(ErrorCode.VALIDATION, `Unknown mapping key: ${dto.mappingKey}`);
    }
    const accountId = BigInt(dto.accountId);
    await this.validateAccount(db, companyId, accountId);

    const row = await db.accountMapping.upsert({
      where: {
        tenantId_companyId_mappingKey: { tenantId, companyId, mappingKey: dto.mappingKey },
      },
      update: { accountId },
      create: { tenantId, companyId, mappingKey: dto.mappingKey, accountId },
    });
    await this.audit.log({
      action: 'account_mapping.upsert',
      entityType: 'account_mapping',
      entityId: row.id,
      after: { mappingKey: dto.mappingKey, accountId: dto.accountId },
    });
    return row;
  }

  async bulk(dto: BulkMappingsDto) {
    const results = [];
    for (const m of dto.mappings) {
      results.push(await this.upsert(m));
    }
    return results;
  }
}
