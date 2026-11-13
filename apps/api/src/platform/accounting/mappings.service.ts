import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ACCOUNT_MAPPING_KEYS,
  type AccountMappingKey,
  LOCKED_AFTER_POSTING,
  MAPPING_RULES,
} from './chart-template.js';
import { BulkMappingsDto, UpsertMappingDto } from './dto/accounting.dto.js';

// journal_lines is read here, not through JournalModule: JournalModule imports AccountingModule (cycle). Read-only usage checks; both are the accounting domain (CLAUDE.md module list).

type TenantDb = ReturnType<PrismaService['forTenant']>;

function isMappingKey(value: string): value is AccountMappingKey {
  return (ACCOUNT_MAPPING_KEYS as readonly string[]).includes(value);
}

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

  private async companyId(db: TenantDb): Promise<bigint> {
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
      include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
    });
    const byKey = new Map(rows.map((r) => [r.mappingKey, r]));
    return ACCOUNT_MAPPING_KEYS.map((key) => ({
      mappingKey: key,
      accountId: byKey.get(key)?.accountId.toString() ?? null,
      account: byKey.get(key)?.account ?? null,
    }));
  }

  /**
   * Checks that an account may be mapped to `key` (LEDGER-05): postable,
   * active, of an allowed type, and a control account only for the matching
   * control key. Control and cash/bank accounts never map to other keys.
   */
  private async validateAccount(
    db: TenantDb,
    companyId: bigint,
    key: AccountMappingKey,
    accountId: bigint,
  ) {
    const account = await db.account.findFirst({
      where: { id: accountId, companyId },
    });
    if (!account) throw DomainError.notFound('Account', accountId.toString());
    if (!account.isActive) {
      throw new DomainError(ErrorCode.ACCOUNT_INACTIVE, 'Mapped accounts must be active');
    }
    if (!account.isPostable) {
      throw new DomainError(ErrorCode.ACCOUNT_NOT_POSTABLE, 'Mapped accounts must be postable');
    }

    const rule = MAPPING_RULES[key];
    if (!rule.types.includes(account.accountType)) {
      throw new DomainError(
        ErrorCode.MAPPING_ACCOUNT_INVALID,
        `Account type ${account.accountType} cannot be mapped to ${key}`,
        { mappingKey: key, expected: rule.types, accountType: account.accountType },
      );
    }

    if (rule.controlType) {
      if (account.controlType !== rule.controlType) {
        throw new DomainError(
          ErrorCode.MAPPING_ACCOUNT_INVALID,
          `${key} must be mapped to a ${rule.controlType} control account`,
          { mappingKey: key, expectedControlType: rule.controlType },
        );
      }
    } else if (account.isControl || account.controlType !== null) {
      throw new DomainError(
        ErrorCode.MAPPING_ACCOUNT_INVALID,
        `A control or cash/bank account cannot be mapped to ${key}`,
        { mappingKey: key },
      );
    }
    return account;
  }

  async upsert(dto: UpsertMappingDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    if (!isMappingKey(dto.mappingKey)) {
      throw new DomainError(ErrorCode.VALIDATION, `Unknown mapping key: ${dto.mappingKey}`);
    }
    const key = dto.mappingKey;
    const accountId = BigInt(dto.accountId);
    await this.validateAccount(db, companyId, key, accountId);

    if (LOCKED_AFTER_POSTING.has(key)) {
      const current = await db.accountMapping.findFirst({
        where: { companyId, mappingKey: key },
        select: { accountId: true },
      });
      if (current && current.accountId !== accountId) {
        // Re-saving the same account is allowed; moving a balance someone
        // else settles to another account would split it (LEDGER-05).
        const posted = await db.journalLine.count({
          where: { accountId: current.accountId, entry: { status: 'POSTED' } },
        });
        if (posted > 0) {
          throw new DomainError(
            ErrorCode.MAPPING_LOCKED,
            `${key} cannot change: entries are already posted to its account`,
            { mappingKey: key, accountId: current.accountId.toString() },
          );
        }
      }
    }

    const row = await db.accountMapping.upsert({
      where: {
        tenantId_companyId_mappingKey: { tenantId, companyId, mappingKey: key },
      },
      update: { accountId },
      create: { tenantId, companyId, mappingKey: key, accountId },
    });
    await this.audit.log({
      action: 'account_mapping.upsert',
      entityType: 'account_mapping',
      entityId: row.id,
      after: { mappingKey: key, accountId: dto.accountId },
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
