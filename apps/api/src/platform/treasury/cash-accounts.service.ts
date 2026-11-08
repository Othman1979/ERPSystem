import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AuditService } from '../../common/audit/audit.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { CreateBankAccountDto, CreateCashBoxDto } from './dto/treasury.dto.js';

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
    const created = await db.cashBox.create({
      data: {
        tenantId,
        companyId,
        code: dto.code,
        name: dto.name,
        accountId: BigInt(dto.accountId),
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.log({ action: 'cash_box.create', entityType: 'cash_box', entityId: created.id });
    return created;
  }

  async updateCashBox(id: bigint, dto: Partial<CreateCashBoxDto>) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const box = await db.cashBox.findFirst({ where: { id, companyId } });
    if (!box) throw DomainError.notFound('CashBox', id.toString());
    if (dto.accountId) await this.assertCashAccount(db, companyId, dto.accountId, 'CASH');
    return db.cashBox.update({
      where: { id },
      data: {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.accountId !== undefined ? { accountId: BigInt(dto.accountId) } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async deleteCashBox(id: bigint) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const box = await db.cashBox.findFirst({ where: { id, companyId } });
    if (!box) throw DomainError.notFound('CashBox', id.toString());
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

  async updateBankAccount(id: bigint, dto: Partial<CreateBankAccountDto>) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const acc = await db.bankAccount.findFirst({ where: { id, companyId } });
    if (!acc) throw DomainError.notFound('BankAccount', id.toString());
    if (dto.accountId) await this.assertCashAccount(db, companyId, dto.accountId, 'BANK');
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
    await db.bankAccount.delete({ where: { id } });
    return { deleted: true };
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
