import { Injectable } from '@nestjs/common';
import { assertBranchAllowed, currentBranchId } from '../../common/branch/branch-context.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { PostingService } from '../journal/posting.service.js';
import type { CreateCashTransferDto, ReverseVoucherDto } from './dto/treasury.dto.js';

const SOURCE = 'CASH_TRANSFER';
const ACCOUNT_SELECT = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;

/**
 * Cash transfers (Phase 6, §7.8): money moved between two cash/bank accounts.
 * Posted on creation — Dr destination, Cr source — and corrected only by
 * reversal (a mirror entry), like vouchers.
 */
@Injectable()
export class CashTransfersService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.cashTransfer.findMany({
      where: { companyId },
      include: { fromAccount: ACCOUNT_SELECT, toAccount: ACCOUNT_SELECT },
      orderBy: [{ transferDate: 'desc' }, { id: 'desc' }],
      take: 300,
    });
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const t = await db.cashTransfer.findFirst({
      where: { id },
      include: {
        fromAccount: ACCOUNT_SELECT,
        toAccount: ACCOUNT_SELECT,
        journalEntry: { select: { id: true, entryNo: true, status: true } },
      },
    });
    if (!t) throw DomainError.notFound('CashTransfer', id.toString());
    return t;
  }

  async create(dto: CreateCashTransferDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    const amount = new Decimal(dto.amount);
    if (amount.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'amount must be > 0');
    if (dto.fromAccountId === dto.toAccountId) {
      throw new DomainError(ErrorCode.VALIDATION, 'From and to must be different accounts');
    }
    const date = new Date(dto.transferDate);

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await this.assertCashAccount(tx, companyId, dto.fromAccountId, 'fromAccountId');
        await this.assertCashAccount(tx, companyId, dto.toAccountId, 'toAccountId');
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, date);
        const transferNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'CASH_TRANSFER', date);
        const entryNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'JOURNAL_ENTRY', date);
        const branchId = currentBranchId();

        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId,
          entryDate: date,
          fiscalPeriodId: period.id,
          entryNo,
          sourceType: SOURCE,
          sourceId: null, // linked below once the transfer exists
          description: dto.description ?? `Cash transfer ${transferNo}`,
          lines: [
            { accountId: BigInt(dto.toAccountId), debit: amount.toString() },
            { accountId: BigInt(dto.fromAccountId), credit: amount.toString() },
          ],
          postedBy: userId ?? null,
        });

        const transfer = await tx.cashTransfer.create({
          data: {
            tenantId,
            companyId,
            branchId,
            transferNo,
            transferDate: date,
            fromAccountId: BigInt(dto.fromAccountId),
            toAccountId: BigInt(dto.toAccountId),
            amount,
            referenceNo: dto.referenceNo ?? null,
            description: dto.description ?? null,
            status: 'POSTED',
            journalEntryId: entry.id,
            createdBy: userId ?? null,
          },
        });
        await tx.journalEntry.update({ where: { id: entry.id }, data: { sourceId: transfer.id } });
        return { id: transfer.id, transferNo };
      }),
    );

    await this.audit.log({
      action: 'cash_transfer.create',
      entityType: 'cash_transfer',
      entityId: result.id,
      after: { transferNo: result.transferNo },
    });
    return this.get(result.id);
  }

  async reverse(id: bigint, dto: ReverseVoucherDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM cash_transfers WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const t = await tx.cashTransfer.findFirst({
          where: { id },
          select: { branchId: true, reversedAt: true, journalEntryId: true },
        });
        if (!t) throw DomainError.notFound('CashTransfer', id.toString());
        assertBranchAllowed(t.branchId);
        if (t.reversedAt) throw new DomainError(ErrorCode.CONFLICT, 'The transfer is already reversed');
        if (!t.journalEntryId) throw new DomainError(ErrorCode.CONFLICT, 'The transfer has no journal entry');
        const reversal = await this.posting.reverseEntry(tx, {
          tenantId,
          companyId,
          entryId: t.journalEntryId,
          reversalDate: new Date(dto.reversalDate),
          description: dto.description,
          postedBy: userId ?? null,
        });
        await tx.cashTransfer.update({
          where: { id },
          data: { reversedAt: new Date(), reversedBy: userId ?? null, reversalEntryId: reversal.id },
        });
      }),
    );
    await this.audit.log({ action: 'cash_transfer.reverse', entityType: 'cash_transfer', entityId: id });
    return this.get(id);
  }

  private async assertCashAccount(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    accountId: string,
    field: string,
  ) {
    const acc = await tx.account.findFirst({
      where: {
        companyId,
        id: BigInt(accountId),
        isActive: true,
        isPostable: true,
        controlType: { in: ['CASH', 'BANK'] },
      },
      select: { id: true },
    });
    if (!acc) throw new DomainError(ErrorCode.VALIDATION, `${field} must be an active cash/bank account`);
  }
}
