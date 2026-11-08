import { Injectable } from '@nestjs/common';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';

export interface JournalLineInput {
  accountId: bigint;
  debit?: string | number | Decimal;
  credit?: string | number | Decimal;
  partyType?: 'CUSTOMER' | 'SUPPLIER' | null;
  partyId?: bigint | null;
  description?: string | null;
  branchId?: bigint | null;
}

export interface NormalizedLine {
  line: JournalLineInput;
  debit: Decimal;
  credit: Decimal;
}

export interface PostEntryParams {
  tenantId: bigint;
  companyId: bigint;
  branchId?: bigint | null;
  entryDate: Date;
  fiscalPeriodId: bigint;
  entryNo: string;
  sourceType: string;
  sourceId?: bigint | null;
  postingKind?: 'POST' | 'REVERSAL';
  voucherType?: 'JOURNAL' | 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
  reversalOfId?: bigint | null;
  description?: string | null;
  lines: JournalLineInput[];
  postedBy?: bigint | null;
}

/**
 * Core double-entry posting engine (docs/BUILD_PLAN.md §8.1, §10).
 * All methods run inside the caller's interactive transaction.
 */
@Injectable()
export class PostingService {
  /** Sums debit/credit across raw line inputs (round3 per line). */
  totals(lines: JournalLineInput[]): { debit: Decimal; credit: Decimal } {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const l of lines) {
      debit = debit.plus(round3(l.debit ?? 0));
      credit = credit.plus(round3(l.credit ?? 0));
    }
    return { debit, credit };
  }

  /**
   * Validates journal lines against §8.1: accounts exist in the same
   * company, are active + postable, debit XOR credit > 0, control accounts
   * carry matching party info. Returns normalized lines with round3 amounts.
   */
  async validateLines(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    lines: JournalLineInput[],
  ): Promise<NormalizedLine[]> {
    if (lines.length < 2) {
      throw new DomainError(ErrorCode.VALIDATION, 'Journal entry requires at least 2 lines');
    }

    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({
      where: { tenantId, companyId, id: { in: accountIds } },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));

    return lines.map((line, i) => {
      const account = byId.get(line.accountId);
      if (!account) {
        throw new DomainError(ErrorCode.NOT_FOUND, `Account ${line.accountId} not found`);
      }
      if (!account.isActive) {
        throw new DomainError(ErrorCode.VALIDATION, `Account ${account.code} is inactive`);
      }
      if (!account.isPostable) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Account ${account.code} is not postable (parent/group account)`,
        );
      }

      const debit = round3(line.debit ?? 0);
      const credit = round3(line.credit ?? 0);
      const hasDebit = debit.gt(0);
      const hasCredit = credit.gt(0);
      if (hasDebit === hasCredit) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Line ${i + 1}: exactly one of debit/credit must be > 0`,
        );
      }

      // Control accounts require party info matching their control type.
      if (account.isControl) {
        if (!line.partyType || !line.partyId) {
          throw new DomainError(
            ErrorCode.VALIDATION,
            `Line ${i + 1}: control account ${account.code} requires partyType and partyId`,
          );
        }
        const expected =
          account.controlType === 'CUSTOMERS'
            ? 'CUSTOMER'
            : account.controlType === 'SUPPLIERS'
              ? 'SUPPLIER'
              : null;
        if (expected && line.partyType !== expected) {
          throw new DomainError(
            ErrorCode.VALIDATION,
            `Line ${i + 1}: account ${account.code} expects partyType ${expected}`,
          );
        }
      }

      return { line, debit, credit };
    });
  }

  /**
   * Validates and inserts a POSTED journal entry + lines.
   * Throws DomainError on any rule violation — the caller's transaction
   * rolls back, so no partial data survives.
   */
  async postEntry(
    tx: Prisma.TransactionClient,
    params: PostEntryParams,
  ): Promise<{ id: bigint; entryNo: string; totalDebit: Decimal; totalCredit: Decimal }> {
    const { tenantId, companyId } = params;

    const normalized = await this.validateLines(tx, tenantId, companyId, params.lines);

    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const n of normalized) {
      totalDebit = totalDebit.plus(n.debit);
      totalCredit = totalCredit.plus(n.credit);
    }
    if (!totalDebit.eq(totalCredit)) {
      throw new DomainError(
        ErrorCode.UNBALANCED_ENTRY,
        `Entry is unbalanced: debit ${totalDebit.toString()} != credit ${totalCredit.toString()}`,
      );
    }

    try {
      const entry = await tx.journalEntry.create({
        data: {
          tenantId,
          companyId,
          branchId: params.branchId ?? null,
          entryNo: params.entryNo,
          entryDate: params.entryDate,
          fiscalPeriodId: params.fiscalPeriodId,
          sourceType: params.sourceType,
          sourceId: params.sourceId ?? null,
          postingKind: params.postingKind ?? 'POST',
          voucherType: params.voucherType ?? 'JOURNAL',
          status: 'POSTED',
          description: params.description ?? null,
          totalDebit,
          totalCredit,
          reversalOfId: params.reversalOfId ?? null,
          postedAt: new Date(),
          postedBy: params.postedBy ?? null,
        },
      });

      await tx.journalLine.createMany({
        data: normalized.map((n, i) => ({
          tenantId,
          journalEntryId: entry.id,
          lineNo: i + 1,
          accountId: n.line.accountId,
          debit: n.debit,
          credit: n.credit,
          partyType: n.line.partyType ?? null,
          partyId: n.line.partyId ?? null,
          description: n.line.description ?? null,
          branchId: n.line.branchId ?? params.branchId ?? null,
        })),
      });

      return { id: entry.id, entryNo: params.entryNo, totalDebit, totalCredit };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DomainError(
          ErrorCode.CONFLICT,
          'A journal entry already exists for this source document',
        );
      }
      throw err;
    }
  }

  /** Finds the OPEN fiscal period covering `date` for the company. */
  async resolveOpenPeriod(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    date: Date,
  ): Promise<{ id: bigint; status: string }> {
    const period = await tx.fiscalPeriod.findFirst({
      where: {
        tenantId,
        startDate: { lte: date },
        endDate: { gte: date },
        fiscalYear: { tenantId, companyId },
      },
      orderBy: { periodNo: 'asc' },
    });
    if (!period) {
      throw new DomainError(
        ErrorCode.PERIOD_CLOSED,
        `No fiscal period covers ${date.toISOString().slice(0, 10)}`,
      );
    }
    if (period.status !== 'OPEN') {
      throw new DomainError(
        ErrorCode.PERIOD_CLOSED,
        `Fiscal period ${period.periodNo} is closed`,
      );
    }
    return period;
  }

  /**
   * Allocates the next document number from document_sequences for the
   * fiscal year covering `date`. Row is locked FOR UPDATE inside tx —
   * numbers are gapless because allocation happens in the posting tx.
   */
  async allocateEntryNo(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    documentType: string,
    date: Date,
  ): Promise<string> {
    const fiscalYear = await tx.fiscalYear.findFirst({
      where: {
        tenantId,
        companyId,
        startDate: { lte: date },
        endDate: { gte: date },
      },
    });
    if (!fiscalYear) {
      throw new DomainError(ErrorCode.PERIOD_CLOSED, 'No fiscal year covers this date');
    }

    const rows = (await tx.$queryRaw`
      SELECT id, prefix, next_number, padding
      FROM document_sequences
      WHERE tenant_id = ${tenantId}
        AND company_id = ${companyId}
        AND document_type = ${documentType}
        AND fiscal_year_id = ${fiscalYear.id}
      FOR UPDATE
    `) as { id: bigint; prefix: string; next_number: number; padding: number }[];

    const seq = rows[0];
    if (!seq) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        `No document sequence for type ${documentType} in fiscal year ${fiscalYear.code}`,
      );
    }

    const padded = String(seq.next_number).padStart(seq.padding, '0');
    await tx.documentSequence.update({
      where: { id: seq.id },
      data: { nextNumber: { increment: 1 } },
    });

    // prefix already contains "{PREFIX}-{YEARCODE}" from provisioning.
    return `${seq.prefix}-${padded}`;
  }
}
