import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { CreateAccountDto, UpdateAccountDto } from './dto/accounting.dto.js';

function levelOfCode(code: string): number {
  if (code.length <= 1) return 1;
  if (code.length <= 2) return 2;
  return 3;
}

@Injectable()
export class AccountsService {
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

  /** Flat list — the web builds the tree (accounts are few hundred max). */
  async list() {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.account.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
    });
  }

  async create(dto: CreateAccountDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();

    let parent: { id: bigint; code: string; level: number } | null = null;
    if (dto.parentId) {
      const found = await db.account.findFirst({
        where: { id: BigInt(dto.parentId), companyId },
        select: { id: true, code: true, level: true },
      });
      if (!found) throw DomainError.notFound('Account', dto.parentId);
      parent = found;
    }

    if (!dto.code && !parent) {
      throw new DomainError(ErrorCode.VALIDATION, 'code is required for a root account');
    }

    const normalBalance =
      dto.normalBalance ??
      (dto.accountType === 'ASSET' || dto.accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT');

    // Auto-generated child codes (`parent-NN`) are recomputed inside the
    // transaction; a unique-collision retries with the next sequence.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const account = await db.$transaction(async (tx) => {
          const code =
            dto.code ??
            (await this.nextChildCode(tx, companyId, parent!.code));
          const created = await tx.account.create({
            data: {
              tenantId,
              companyId,
              code,
              nameAr: dto.nameAr,
              nameEn: dto.nameEn ?? null,
              parentId: parent?.id ?? null,
              level: parent ? parent.level + 1 : levelOfCode(code),
              accountType: dto.accountType,
              normalBalance,
              isPostable: dto.isPostable ?? true,
              isControl: dto.isControl ?? false,
              controlType: dto.controlType ?? null,
              createdBy: cls.get('userId') ?? null,
            },
          });
          // A parent that gains a child can no longer be posted to (§8 rule:
          // الحساب الأب غير قابل للحركة).
          if (parent) {
            await tx.account.updateMany({
              where: { id: parent.id, isPostable: true },
              data: { isPostable: false },
            });
          }
          return created;
        });
        await this.audit.log({
          action: 'account.create',
          entityType: 'account',
          entityId: account.id,
          after: { code: account.code, nameAr: dto.nameAr },
        });
        return account;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002' && !dto.code) continue;
        if ((err as { code?: string }).code === 'P2002') {
          throw new DomainError(ErrorCode.CONFLICT, 'Account code already exists');
        }
        throw err;
      }
    }
    throw new DomainError(ErrorCode.CONFLICT, 'Could not allocate account code');
  }

  /** Next free `parent-NN` code (NN = 01, 02, …) among the parent's children. */
  private async nextChildCode(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    parentCode: string,
  ): Promise<string> {
    const prefix = `${parentCode}-`;
    const siblings = await tx.account.findMany({
      where: { companyId, code: { startsWith: prefix } },
      select: { code: true },
    });
    let max = 0;
    for (const s of siblings) {
      const suffix = s.code.slice(prefix.length);
      if (/^\d+$/.test(suffix)) max = Math.max(max, Number(suffix));
    }
    return `${prefix}${String(max + 1).padStart(2, '0')}`;
  }

  async update(id: bigint, dto: UpdateAccountDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const existing = await db.account.findFirst({ where: { id, companyId } });
    if (!existing) throw DomainError.notFound('Account', id.toString());

    if (dto.isActive === false) {
      const mappings = await db.accountMapping.count({ where: { accountId: id } });
      if (mappings > 0) {
        throw new DomainError(
          ErrorCode.CONFLICT,
          'Cannot deactivate an account used in account mappings',
        );
      }
      const children = await db.account.count({ where: { parentId: id } });
      if (children > 0) {
        throw new DomainError(ErrorCode.CONFLICT, 'Cannot deactivate an account with children');
      }
      // NOTE: journal-line balance check lands with Phase 3 (journal_lines).
    }

    if (dto.isPostable === true && existing.parentId === null) {
      // Root accounts stay non-postable by design; leaf check via children.
      const children = await db.account.count({ where: { parentId: id } });
      if (children > 0) {
        throw new DomainError(ErrorCode.CONFLICT, 'Parent accounts cannot be postable');
      }
    }

    const updated = await db.account.update({
      where: { id },
      data: {
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        isPostable: dto.isPostable,
        isActive: dto.isActive,
        updatedBy: ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null,
      },
    });
    await this.audit.log({
      action: 'account.update',
      entityType: 'account',
      entityId: id,
      before: { nameAr: existing.nameAr, isActive: existing.isActive },
      after: dto,
    });
    return updated;
  }
}
