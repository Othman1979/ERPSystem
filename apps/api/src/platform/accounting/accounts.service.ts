import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import { hasAllBranches } from '../../common/branch/branch-context.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { calendarDateIn, retryOnLockConflict } from '../shared/document-support.service.js';
import { isIncomeStatement } from '../cost-centers/cost-center-rules.js';
import { CreateAccountDto, UpdateAccountDto } from './dto/accounting.dto.js';
import { currentCompanyFilter, currentCompanySqlFilter } from '../../common/cls/current-company.js';

// journal_lines is read here, not through JournalModule: JournalModule imports AccountingModule (cycle). Read-only usage checks; both are the accounting domain (CLAUDE.md module list).

type TenantDb = ReturnType<PrismaService['forTenant']>;

type MovedLinks = {
  mappings: number;
  cashBoxes: number;
  bankAccounts: number;
  payElements: number;
};

const NO_MOVED_LINKS: MovedLinks = {
  mappings: 0,
  cashBoxes: 0,
  bankAccounts: 0,
  payElements: 0,
};

/** ADR-024 §1.1: "cost centre required" only on an income-statement account. */
/** ADR-036 §3: only non-cash balance sheet accounts carry a cash flow section. */
function assertCashFlowActivityAllowed(accountType: string, controlType: string | null | undefined): void {
  if (isIncomeStatement(accountType) || controlType === 'CASH' || controlType === 'BANK') {
    throw new DomainError(
      ErrorCode.VALIDATION,
      'Only non-cash asset, liability and equity accounts take a cash flow activity',
      { accountType, controlType: controlType ?? null },
    );
  }
}

function assertCostCenterFlagAllowed(accountType: string): void {
  if (!isIncomeStatement(accountType)) {
    throw new DomainError(
      ErrorCode.COST_CENTER_NOT_ALLOWED,
      'Only revenue and expense accounts can require a cost centre',
      { accountType },
    );
  }
}

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
      where: { isActive: true, ...currentCompanyFilter() },
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
        costCenterRequired: true,
        cashFlowActivity: true,
      },
    });
    if (!parent) throw DomainError.notFound('Account', parentId.toString());
    return parent;
  }

  /** A first child cannot strand a journal balance or an existing document reference. */
  private async assertCanBecomeGroup(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    parent: { id: bigint; code: string },
  ): Promise<void> {
    const lines = await tx.journalLine.count({ where: { tenantId, accountId: parent.id } });
    if (lines > 0) {
      throw new DomainError(
        ErrorCode.ACCOUNT_IN_USE,
        `Account ${parent.code} has journal lines; it cannot become a group account`,
        { reason: 'HAS_LINES', parentId: parent.id.toString() },
      );
    }

    const documentCounts = await Promise.all([
      tx.payment.count({
        where: { tenantId, companyId, OR: [{ cashAccountId: parent.id }, { expenseAccountId: parent.id }] },
      }),
      tx.receipt.count({ where: { tenantId, companyId, cashAccountId: parent.id } }),
      tx.salesInvoice.count({ where: { tenantId, companyId, cashAccountId: parent.id } }),
      tx.salesReturn.count({ where: { tenantId, companyId, cashAccountId: parent.id } }),
      tx.purchaseInvoice.count({ where: { tenantId, companyId, cashAccountId: parent.id } }),
      tx.purchaseReturn.count({ where: { tenantId, companyId, cashAccountId: parent.id } }),
      tx.cashTransfer.count({
        where: { tenantId, companyId, OR: [{ fromAccountId: parent.id }, { toAccountId: parent.id }] },
      }),
      tx.goodsNote.count({ where: { tenantId, companyId, expenseAccountId: parent.id } }),
      tx.issueRequest.count({ where: { tenantId, companyId, expenseAccountId: parent.id } }),
      tx.cheque.count({ where: { tenantId, companyId, bankAccountId: parent.id } }),
    ]);
    const documents = [
      'payments',
      'receipts',
      'sales_invoices',
      'sales_returns',
      'purchase_invoices',
      'purchase_returns',
      'cash_transfers',
      'goods_notes',
      'issue_requests',
      'cheques',
    ].filter((_, index) => documentCounts[index] > 0);
    if (documents.length > 0) {
      throw new DomainError(
        ErrorCode.ACCOUNT_IN_USE,
        `Account ${parent.code} is referenced by documents`,
        { reason: 'USED_IN_DOCUMENTS', parentId: parent.id.toString(), documents },
      );
    }
  }

  private async moveConfigurationLinks(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    parent: { id: bigint; code: string },
    child: { id: bigint; code: string },
  ): Promise<MovedLinks> {
    const [mappings, cashBoxes, bankAccounts, payElements] = await Promise.all([
      tx.accountMapping.updateMany({
        where: { tenantId, companyId, accountId: parent.id },
        data: { accountId: child.id },
      }),
      tx.cashBox.updateMany({
        where: { tenantId, companyId, accountId: parent.id },
        data: { accountId: child.id },
      }),
      tx.bankAccount.updateMany({
        where: { tenantId, companyId, accountId: parent.id },
        data: { accountId: child.id },
      }),
      tx.payElement.updateMany({
        where: { tenantId, companyId, accountId: parent.id },
        data: { accountId: child.id },
      }),
    ]);
    const movedLinks = {
      mappings: mappings.count,
      cashBoxes: cashBoxes.count,
      bankAccounts: bankAccounts.count,
      payElements: payElements.count,
    };
    if (Object.values(movedLinks).some((count) => count > 0)) {
      await this.audit.log(
        {
          action: 'account.links_moved',
          entityType: 'account',
          entityId: parent.id,
          before: { accountId: parent.id.toString(), code: parent.code },
          after: {
            accountId: child.id.toString(),
            code: child.code,
            movedLinks,
          },
        },
        tx,
      );
    }
    return movedLinks;
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
    if (parent && dto.code !== undefined && (!dto.code.startsWith(parent.code) || dto.code.length <= parent.code.length)) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        'A child account code must start with its parent code and be longer',
        { reason: 'CODE_PREFIX', parentCode: parent.code },
      );
    }
    if (!parent) {
      if (dto.costCenterRequired) assertCostCenterFlagAllowed(dto.accountType);
      if (dto.cashFlowActivity) assertCashFlowActivityAllowed(dto.accountType, dto.controlType);
    }

    // Auto-generated child codes (`parent-NN`) are recomputed inside the
    // transaction; a unique-collision retries with the next sequence.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // A deadlock with a posting on the same parent rolls this transaction back; run again,
        // it then sees the committed posting and answers ACCOUNT_IN_USE (not CONFLICT).
        const result = await retryOnLockConflict(() => db.$transaction(async (tx) => {
          let currentParent: {
            id: bigint;
            code: string;
            normalBalance: 'DEBIT' | 'CREDIT';
            isControl: boolean;
            controlType: Exclude<CreateAccountDto['controlType'], undefined>;
            costCenterRequired: boolean;
            cashFlowActivity: Exclude<CreateAccountDto['cashFlowActivity'], undefined>;
          } | null = null;
          let firstChild = false;
          if (parent) {
            // Lock the parent first: the usage checks and the INSERT below
            // must see the same state (LEDGER-03).
            await tx.$queryRaw`SELECT id FROM accounts FORCE INDEX (PRIMARY) WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${parent.id} FOR UPDATE`;
            currentParent = await tx.account.findFirst({
              where: { id: parent.id, tenantId, companyId },
              select: {
                id: true,
                code: true,
                normalBalance: true,
                isControl: true,
                controlType: true,
                costCenterRequired: true,
                cashFlowActivity: true,
              },
            });
            if (!currentParent) throw DomainError.notFound('Account', parent.id.toString());
            if (
              currentParent.controlType !== null &&
              dto.controlType !== undefined &&
              dto.controlType !== currentParent.controlType
            ) {
              throw new DomainError(
                ErrorCode.VALIDATION,
                'A child account must keep its parent control type',
                {
                  parentControlType: currentParent.controlType,
                  requestedControlType: dto.controlType,
                },
              );
            }
            const children = await tx.account.count({
              where: { tenantId, companyId, parentId: currentParent.id },
            });
            firstChild = children === 0;
            if (firstChild) {
              await this.assertCanBecomeGroup(tx, tenantId, companyId, currentParent);
            }
          }

          const controlType =
            dto.controlType === undefined ? (currentParent?.controlType ?? null) : dto.controlType;
          const isControl = dto.isControl ?? currentParent?.isControl ?? false;
          const normalBalance =
            dto.normalBalance ??
            currentParent?.normalBalance ??
            (dto.accountType === 'ASSET' || dto.accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT');
          const costCenterRequired = dto.costCenterRequired ?? currentParent?.costCenterRequired ?? false;
          const cashFlowActivity =
            dto.cashFlowActivity === undefined
              ? (currentParent?.cashFlowActivity ?? null)
              : dto.cashFlowActivity;
          if (costCenterRequired) assertCostCenterFlagAllowed(dto.accountType);
          if (cashFlowActivity) assertCashFlowActivityAllowed(dto.accountType, controlType);

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
              isControl,
              controlType,
              costCenterRequired,
              cashFlowActivity,
              createdBy: cls.get('userId') ?? null,
            },
          });
          const movedLinks =
            parent && firstChild && currentParent
              ? await this.moveConfigurationLinks(tx, tenantId, companyId, currentParent, created)
              : NO_MOVED_LINKS;
          // A parent that gains a child can no longer be posted to (§8 rule:
          // الحساب الأب غير قابل للحركة).
          if (parent && firstChild) {
            await tx.account.updateMany({
              where: { id: parent.id, isPostable: true },
              data: { isPostable: false },
            });
          }
          return { account: created, movedLinks };
        }));
        await this.audit.log({
          action: 'account.create',
          entityType: 'account',
          entityId: result.account.id,
          after: { code: result.account.code, nameAr: dto.nameAr },
        });
        return { ...result.account, movedLinks: result.movedLinks };
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
   * Start of the period whose balance a deactivation must find at zero. Profit
   * and loss accounts close into equity at each year end without a closing
   * entry (§8.5, ADR-008 §7), so they only carry the current fiscal year's
   * lines: the year holding today (company timezone), else the latest year
   * already started. Other accounts carry every line (null).
   */
  private async balanceStart(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    accountType: string,
  ): Promise<Date | null> {
    if (accountType !== 'REVENUE' && accountType !== 'EXPENSE') return null;
    const company = await tx.company.findFirst({ where: { id: companyId }, select: { timezone: true } });
    const today = new Date(`${calendarDateIn(company?.timezone || 'Asia/Amman')}T00:00:00.000Z`);
    const year = await tx.fiscalYear.findFirst({
      where: { companyId, startDate: { lte: today } },
      orderBy: { startDate: 'desc' },
      select: { startDate: true },
    });
    return year?.startDate ?? null;
  }

  /**
   * Refuses to deactivate an account that is still in use: mapped, a parent,
   * or holding a posted balance or draft lines (LEDGER-04, LEDGER-11).
   */
  private async assertCanDeactivate(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    account: { id: bigint; accountType: string },
  ): Promise<void> {
    const id = account.id;
    const mappings = await tx.accountMapping.count({ where: { accountId: id } });
    if (mappings > 0) {
      throw new DomainError(
        ErrorCode.ACCOUNT_IN_USE,
        'Cannot deactivate an account used in account mappings',
        { reason: 'MAPPED' },
      );
    }
    const children = await tx.account.count({ where: { parentId: id } });
    if (children > 0) {
      throw new DomainError(ErrorCode.ACCOUNT_HAS_CHILDREN, 'Cannot deactivate an account with children');
    }

    const from = await this.balanceStart(tx, companyId, account.accountType);
    const posted = await tx.journalLine.aggregate({
      where: { accountId: id, entry: { status: 'POSTED', ...(from ? { entryDate: { gte: from } } : {}) } },
      _sum: { debit: true, credit: true },
    });
    const net = new Decimal(posted._sum.debit?.toString() ?? 0).minus(posted._sum.credit?.toString() ?? 0);
    if (!net.isZero()) {
      // The balance is company-wide (all branches): only a member with every branch sees it.
      throw new DomainError(ErrorCode.ACCOUNT_HAS_BALANCE, 'Cannot deactivate an account with a balance', {
        ...(hasAllBranches() ? { balance: net.toFixed(3) } : {}),
        ...(from ? { from: from.toISOString().slice(0, 10) } : {}),
      });
    }

    const drafts = await tx.journalLine.count({ where: { accountId: id, entry: { status: 'DRAFT' } } });
    if (drafts > 0) {
      throw new DomainError(ErrorCode.ACCOUNT_HAS_BALANCE, 'Cannot deactivate an account used by draft entries', {
        drafts,
      });
    }
  }

  async update(id: bigint, dto: UpdateAccountDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;

    // One transaction behind a row lock: postings hold a shared lock on their
    // accounts until COMMIT (PostingService.validateLines), so the checks
    // below and the update see no posting in flight, and a later posting sees
    // the new flags (review of PR #26).
    // Run again on a deadlock with a posting (same reason as in create).
    const { existing, updated } = await retryOnLockConflict(() => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts FORCE INDEX (PRIMARY) WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${id} FOR UPDATE`;
      const existing = await tx.account.findFirst({ where: { id, companyId } });
      if (!existing) throw DomainError.notFound('Account', id.toString());

      if (dto.isActive === false && existing.isActive) {
        await this.assertCanDeactivate(tx, companyId, existing);
      }
      if (dto.costCenterRequired === true) assertCostCenterFlagAllowed(existing.accountType);
      if (dto.cashFlowActivity) assertCashFlowActivityAllowed(existing.accountType, existing.controlType);

      if (dto.isPostable === true) {
        // Any account with children is a group, root or not (LEDGER-04).
        const children = await tx.account.count({ where: { parentId: id } });
        if (children > 0) {
          throw new DomainError(ErrorCode.ACCOUNT_HAS_CHILDREN, 'A parent account cannot be postable');
        }
      }

      if (dto.isPostable === false && existing.isPostable) {
        // Same rule as LEDGER-03: a used account must stay postable.
        const mappings = await tx.accountMapping.count({ where: { accountId: id } });
        if (mappings > 0) {
          throw new DomainError(
            ErrorCode.ACCOUNT_IN_USE,
            'Cannot make an account used in account mappings non-postable',
            { reason: 'MAPPED' },
          );
        }
        const lines = await tx.journalLine.count({ where: { accountId: id } });
        if (lines > 0) {
          throw new DomainError(
            ErrorCode.ACCOUNT_IN_USE,
            'Cannot make an account with journal lines non-postable',
            { reason: 'HAS_LINES' },
          );
        }
      }

      const updated = await tx.account.update({
        where: { id },
        data: {
          nameAr: dto.nameAr,
          nameEn: dto.nameEn,
          isPostable: dto.isPostable,
          isActive: dto.isActive,
          costCenterRequired: dto.costCenterRequired,
          cashFlowActivity: dto.cashFlowActivity,
          updatedBy: userId,
        },
      });
      return { existing, updated };
    }));
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
