import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed, hasAllBranches } from '../../common/branch/branch-context.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type {
  CreateBankAccountDto,
  CreateCashBoxDto,
  UpdateBankAccountDto,
  UpdateCashBoxDto,
} from './dto/treasury.dto.js';

/** Cash boxes (الصناديق) and bank accounts (الحسابات البنكية) → GL accounts. */
@Injectable()
export class CashAccountsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- cash boxes

  async listCashBoxes() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.cashBox.findMany({
      where: { companyId },
      include: { account: { select: { id: true, code: true, nameAr: true } } },
      orderBy: { code: 'asc' },
    });
  }

  async createCashBox(dto: CreateCashBoxDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.assertCashAccount(db, companyId, dto.accountId, 'CASH');
    // No branch = every branch (the box is not restricted, as for documents).
    const branchId = dto.branchId != null ? await this.assertBoxBranch(db, companyId, dto.branchId) : null;
    const created = await db.cashBox.create({
      data: {
        tenantId,
        companyId,
        branchId,
        code: dto.code,
        name: dto.name,
        accountId: BigInt(dto.accountId),
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.log({ action: 'cash_box.create', entityType: 'cash_box', entityId: created.id });
    return created;
  }

  async updateCashBox(id: bigint, dto: UpdateCashBoxDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const box = await db.cashBox.findFirst({ where: { id, companyId } });
    if (!box) throw DomainError.notFound('CashBox', id.toString());
    // A write on another branch's box is refused, as on its documents (ADR-003 §3, §11).
    assertBranchAllowed(box.branchId);
    if (dto.accountId) await this.assertCashAccount(db, companyId, dto.accountId, 'CASH');
    if (dto.accountId && BigInt(dto.accountId) !== box.accountId) {
      await this.assertNoJournalLines(db, box.accountId);
    }
    // Moving a box takes rights on both branches: the one it leaves (checked
    // above) and the one it joins. A box without a branch serves every branch,
    // so taking it onto one branch, or making a box shared, needs all branches.
    let branchId: bigint | null | undefined;
    if (dto.branchId !== undefined) {
      const next = dto.branchId === null ? null : await this.assertBoxBranch(db, companyId, dto.branchId);
      if (next !== box.branchId) {
        if ((box.branchId === null || next === null) && !hasAllBranches()) {
          throw new DomainError(
            ErrorCode.ALL_BRANCHES_REQUIRED,
            'Only a member with every branch may move a cash box to or from all branches',
          );
        }
        branchId = next;
      }
    }
    return db.cashBox.update({
      where: { id },
      data: {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.accountId !== undefined ? { accountId: BigInt(dto.accountId) } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(branchId !== undefined ? { branchId } : {}),
      },
    });
  }

  async deleteCashBox(id: bigint) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const box = await db.cashBox.findFirst({ where: { id, companyId } });
    if (!box) throw DomainError.notFound('CashBox', id.toString());
    assertBranchAllowed(box.branchId);
    if (await this.hasJournalLines(db, box.accountId)) {
      // History exists on the GL account: deactivate instead of hard delete (TRADE-25).
      await db.cashBox.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await db.cashBox.delete({ where: { id } });
    return { deleted: true };
  }

  // ------------------------------------------------------------ bank accounts

  async listBankAccounts() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.bankAccount.findMany({
      where: { companyId },
      include: { account: { select: { id: true, code: true, nameAr: true } } },
      orderBy: { bankName: 'asc' },
    });
  }

  async createBankAccount(dto: CreateBankAccountDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    await this.assertCashAccount(db, companyId, dto.accountId, 'BANK');
    const created = await db.bankAccount.create({
      data: {
        tenantId,
        companyId,
        bankName: dto.bankName,
        accountNoMasked: dto.accountNoMasked ?? null,
        ibanMasked: dto.ibanMasked ?? null,
        accountId: BigInt(dto.accountId),
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.log({ action: 'bank_account.create', entityType: 'bank_account', entityId: created.id });
    return created;
  }

  async updateBankAccount(id: bigint, dto: UpdateBankAccountDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const acc = await db.bankAccount.findFirst({ where: { id, companyId } });
    if (!acc) throw DomainError.notFound('BankAccount', id.toString());
    if (dto.accountId) await this.assertCashAccount(db, companyId, dto.accountId, 'BANK');
    if (dto.accountId && BigInt(dto.accountId) !== acc.accountId) {
      await this.assertNoJournalLines(db, acc.accountId);
    }
    return db.bankAccount.update({
      where: { id },
      data: {
        ...(dto.bankName !== undefined ? { bankName: dto.bankName } : {}),
        ...(dto.accountNoMasked !== undefined ? { accountNoMasked: dto.accountNoMasked } : {}),
        ...(dto.ibanMasked !== undefined ? { ibanMasked: dto.ibanMasked } : {}),
        ...(dto.accountId !== undefined ? { accountId: BigInt(dto.accountId) } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async deleteBankAccount(id: bigint) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const acc = await db.bankAccount.findFirst({ where: { id, companyId } });
    if (!acc) throw DomainError.notFound('BankAccount', id.toString());
    if (await this.hasJournalLines(db, acc.accountId)) {
      // History exists on the GL account: deactivate instead of hard delete (TRADE-25).
      await db.bankAccount.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await db.bankAccount.delete({ where: { id } });
    return { deleted: true };
  }

  /** True when any journal line already references the GL account. */
  private async hasJournalLines(
    db: ReturnType<PrismaService['forTenant']>,
    accountId: bigint,
  ): Promise<boolean> {
    // Read-only check on journal_lines (TRADE-25); no write.
    const line = await db.journalLine.findFirst({ where: { accountId }, select: { id: true } });
    return line !== null;
  }

  /** Blocks re-linking a cash box / bank account whose current GL account has history. */
  private async assertNoJournalLines(
    db: ReturnType<PrismaService['forTenant']>,
    accountId: bigint,
  ): Promise<void> {
    if (await this.hasJournalLines(db, accountId)) {
      throw new DomainError(
        ErrorCode.CONFLICT,
        'The account has journal lines; it cannot be re-linked',
      );
    }
  }

  /**
   * The active branch of the company a cash box is put on. Throws NOT_FOUND
   * for another company's or an unknown branch, and BRANCH_NOT_ALLOWED when
   * the caller may not use it (ADR-003).
   */
  private async assertBoxBranch(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    branchId: string,
  ): Promise<bigint> {
    const branch = await db.branch.findFirst({
      where: { id: BigInt(branchId), companyId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw DomainError.notFound('Branch', branchId);
    assertBranchAllowed(branch.id);
    return branch.id;
  }

  private async assertCashAccount(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    accountId: string,
    controlType: 'CASH' | 'BANK',
  ) {
    const acc = await db.account.findFirst({
      where: {
        companyId,
        id: BigInt(accountId),
        isActive: true,
        isPostable: true,
        controlType,
      },
      select: { id: true },
    });
    if (!acc) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        `accountId must be an active postable ${controlType} account`,
      );
    }
  }
}
