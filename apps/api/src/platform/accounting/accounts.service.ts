import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { CreateAccountDto, UpdateAccountDto } from './dto/accounting.dto.js';

// journal_lines is read here, not through JournalModule: JournalModule imports AccountingModule (cycle). Read-only usage checks; both are the accounting domain (CLAUDE.md module list).

type TenantDb = ReturnType<PrismaService['forTenant']>;

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

  private async companyId(db: TenantDb): Promise<bigint> {
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

  private async loadParent(db: TenantDb, companyId: bigint, parentId: bigint) {
    const parent = await db.account.findFirst({
      where: { id: parentId, companyId },
      select: {
        id: true,
        code: true,
        level: true,
        accountType: true,
        normalBalance: true,
        isControl: true,
        controlType: true,
      },
    });
    if (!parent) throw DomainError.notFound('Account', parentId.toString());
    return parent;
  }

  /**
   * A parent that becomes a group must not be a control or cash/bank account,
   * mapped, or used by any journal line. A used account turned into a group
   * stranded its balance and stopped the cash box posting (LEDGER-03).
   * Called inside the transaction, after the parent row is locked.
   */
  private async assertCanBecomeGroup(
    tx: Prisma.TransactionClient,
    parent: { id: bigint; code: string; isControl: boolean; controlType: string | null },
  ): Promise<void> {
    if (parent.isControl || parent.controlType !== null) {
      throw new DomainError(
        ErrorCode.ACCOUNT_IN_USE,
        `Account ${parent.code} is a control or cash/bank account; it cannot become a group account`,
        { reason: 'CONTROL', parentId: parent.id.toString() },
      );
    }
    const mappings = await tx.accountMapping.count({ where: { accountId: parent.id } });
    if (mappings > 0) {
      throw new DomainError(
        ErrorCode.ACCOUNT_IN_USE,
        `Account ${parent.code} is used in account mappings; it cannot become a group account`,
        { reason: 'MAPPED', parentId: parent.id.toString() },
      );
    }
    const lines = await tx.journalLine.count({ where: { accountId: parent.id } });
    if (lines > 0) {
      throw new DomainError(
        ErrorCode.ACCOUNT_IN_USE,
        `Account ${parent.code} has journal lines; it cannot become a group account`,
        { reason: 'HAS_LINES', parentId: parent.id.toString() },
      );
    }
  }

  async create(dto: CreateAccountDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();

    const parent = dto.parentId ? await this.loadParent(db, companyId, BigInt(dto.parentId)) : null;

    if (parent && dto.accountType !== parent.accountType) {
      throw new DomainError(
        ErrorCode.ACCOUNT_TYPE_MISMATCH,
        "A sub-account has its parent's account type",
        { parentType: parent.accountType },
      );
    }

    if (!dto.code && !parent) {
      throw new DomainError(ErrorCode.VALIDATION, 'code is required for a root account');
    }

    // A contra sub-account may still pass its own normalBalance explicitly.
    const normalBalance =
      dto.normalBalance ??
      parent?.normalBalance ??
      (dto.accountType === 'ASSET' || dto.accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT');

    // Auto-generated child codes (`parent-NN`) are recomputed inside the
    // transaction; a unique-collision retries with the next sequence.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const account = await db.$transaction(async (tx) => {
          if (parent) {
            // Lock the parent first: the usage checks and the INSERT below
            // must see the same state (LEDGER-03).
            await tx.$queryRaw`SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND id = ${parent.id} FOR UPDATE`;
            // Re-read the flags under the lock: they may have changed since loadParent.
            const current = await tx.account.findFirst({
              where: { id: parent.id },
              select: { id: true, code: true, isControl: true, controlType: true },
            });
            if (!current) throw DomainError.notFound('Account', parent.id.toString());
            await this.assertCanBecomeGroup(tx, current);
          }
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
        const errCode = (err as { code?: string }).code;
        if (errCode === 'P2002' && !dto.code) continue;
        if (errCode === 'P2002') {
          throw new DomainError(ErrorCode.DUPLICATE_CODE, 'Account code already exists', {
            code: dto.code,
          });
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

  /**
   * Refuses to deactivate an account that is still in use: mapped, a parent,
   * or holding a posted balance or draft lines (LEDGER-04, LEDGER-11).
   */
  private async assertCanDeactivate(db: TenantDb, id: bigint): Promise<void> {
    const mappings = await db.accountMapping.count({ where: { accountId: id } });
    if (mappings > 0) {
      throw new DomainError(
        ErrorCode.ACCOUNT_IN_USE,
        'Cannot deactivate an account used in account mappings',
        { reason: 'MAPPED' },
      );
    }
    const children = await db.account.count({ where: { parentId: id } });
    if (children > 0) {
      throw new DomainError(ErrorCode.ACCOUNT_HAS_CHILDREN, 'Cannot deactivate an account with children');
    }

    const posted = await db.journalLine.aggregate({
      where: { accountId: id, entry: { status: 'POSTED' } },
      _sum: { debit: true, credit: true },
    });
    const net = new Decimal(posted._sum.debit?.toString() ?? 0).minus(posted._sum.credit?.toString() ?? 0);
    if (!net.isZero()) {
      throw new DomainError(ErrorCode.ACCOUNT_HAS_BALANCE, 'Cannot deactivate an account with a balance', {
        balance: net.toFixed(3),
      });
    }

    const drafts = await db.journalLine.count({ where: { accountId: id, entry: { status: 'DRAFT' } } });
    if (drafts > 0) {
      throw new DomainError(ErrorCode.ACCOUNT_HAS_BALANCE, 'Cannot deactivate an account used by draft entries', {
        drafts,
      });
    }
  }

  async update(id: bigint, dto: UpdateAccountDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const existing = await db.account.findFirst({ where: { id, companyId } });
    if (!existing) throw DomainError.notFound('Account', id.toString());

    if (dto.isActive === false) {
      await this.assertCanDeactivate(db, id);
    }

    if (dto.isPostable === true) {
      // Any account with children is a group, root or not (LEDGER-04).
      const children = await db.account.count({ where: { parentId: id } });
      if (children > 0) {
        throw new DomainError(ErrorCode.ACCOUNT_HAS_CHILDREN, 'A parent account cannot be postable');
      }
    }

    if (dto.isPostable === false && existing.isPostable) {
      // Same rule as LEDGER-03: a used account must stay postable.
      const mappings = await db.accountMapping.count({ where: { accountId: id } });
      if (mappings > 0) {
        throw new DomainError(
          ErrorCode.ACCOUNT_IN_USE,
          'Cannot make an account used in account mappings non-postable',
          { reason: 'MAPPED' },
        );
      }
      const lines = await db.journalLine.count({ where: { accountId: id } });
      if (lines > 0) {
        throw new DomainError(
          ErrorCode.ACCOUNT_IN_USE,
          'Cannot make an account with journal lines non-postable',
          { reason: 'HAS_LINES' },
        );
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
