import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import type { JournalLineInput } from '../journal/posting.service.js';
import { PostingService } from '../journal/posting.service.js';
import { retryOnLockConflict } from '../shared/document-support.service.js';
import { FiscalService } from './fiscal.service.js';
import { MappingsService } from './mappings.service.js';
import { YearClosingDraftRegistry, type YearClosingDraft } from './year-closing-draft.registry.js';

type FiscalYear = Prisma.FiscalYearGetPayload<Record<string, never>>;

interface ClosingLine {
  accountId: bigint;
  accountCode: string;
  accountNameAr: string;
  accountNameEn: string | null;
  branchId: bigint | null;
  costCenterId: bigint | null;
  debit: string;
  credit: string;
}

interface ClosingComputation {
  lines: ClosingLine[];
  netResult: Decimal;
}

@Injectable()
export class YearClosingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => PostingService))
    private readonly posting: PostingService,
    private readonly mappings: MappingsService,
    private readonly fiscal: FiscalService,
    private readonly draftRegistry: YearClosingDraftRegistry,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private assertAllBranchScope(): void {
    if (ClsServiceManager.getClsService<RequestContext>().get('branchScope') !== 'ALL') {
      throw new DomainError(ErrorCode.BRANCH_NOT_ALLOWED, 'Year closing requires access to all branches');
    }
  }

  private async year(tx: Prisma.TransactionClient, tenantId: bigint, yearId: bigint): Promise<FiscalYear> {
    const year = await tx.fiscalYear.findFirst({ where: { tenantId, id: yearId } });
    if (!year) throw DomainError.notFound('FiscalYear', yearId.toString());
    return year;
  }

  private async lockYear(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    yearId: bigint,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM fiscal_years WHERE tenant_id = ${tenantId} AND id = ${yearId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM fiscal_periods WHERE tenant_id = ${tenantId} AND fiscal_year_id = ${yearId} ORDER BY id FOR UPDATE`;
  }

  private async drafts(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    year: Pick<FiscalYear, 'startDate' | 'endDate'>,
  ): Promise<YearClosingDraft[]> {
    return this.draftRegistry.list(tx, tenantId, companyId, year.startDate, year.endDate);
  }

  private async compute(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    year: FiscalYear,
  ): Promise<ClosingComputation> {
    const grouped = await tx.journalLine.groupBy({
      by: ['accountId', 'costCenterId', 'branchId'],
      where: {
        tenantId,
        entry: {
          tenantId,
          companyId: year.companyId,
          status: 'POSTED',
          isClosing: false,
          entryDate: { gte: year.startDate, lte: year.endDate },
        },
        account: { accountType: { in: ['REVENUE', 'EXPENSE'] } },
      },
      _sum: { debit: true, credit: true },
    });
    const accounts = grouped.length
      ? await tx.account.findMany({
          where: { tenantId, companyId: year.companyId, id: { in: grouped.map((row) => row.accountId) } },
          select: { id: true, code: true, nameAr: true, nameEn: true },
        })
      : [];
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const branchNet = new Map<string, { branchId: bigint | null; amount: Decimal }>();
    const lines: ClosingLine[] = [];

    for (const row of grouped) {
      const balance = round3(
        new Decimal(row._sum.debit?.toString() ?? 0).minus(row._sum.credit?.toString() ?? 0),
      );
      if (balance.isZero()) continue;
      const account = accountById.get(row.accountId);
      if (!account) continue;

      const branchKey = row.branchId?.toString() ?? 'null';
      const branch = branchNet.get(branchKey) ?? { branchId: row.branchId, amount: new Decimal(0) };
      branch.amount = round3(branch.amount.minus(balance));
      branchNet.set(branchKey, branch);
      lines.push({
        accountId: row.accountId,
        accountCode: account.code,
        accountNameAr: account.nameAr,
        accountNameEn: account.nameEn,
        branchId: row.branchId,
        costCenterId: row.costCenterId,
        debit: balance.lt(0) ? round3(balance.abs()).toString() : '0.000',
        credit: balance.gt(0) ? round3(balance).toString() : '0.000',
      });
    }

    if (lines.length > 0) {
      const retainedEarningsId = await this.mappings.mappedAccountId(
        tx,
        tenantId,
        year.companyId,
        'RETAINED_EARNINGS',
      );
      const retainedAccount = accountById.get(retainedEarningsId) ??
        (await tx.account.findFirst({
          where: { tenantId, companyId: year.companyId, id: retainedEarningsId },
          select: { id: true, code: true, nameAr: true, nameEn: true },
        }));
      if (!retainedAccount) {
        throw new DomainError(ErrorCode.MAPPING_ACCOUNT_INVALID, 'Mapped retained earnings account was not found');
      }
      for (const branch of branchNet.values()) {
        if (branch.amount.isZero()) continue;
        lines.push({
          accountId: retainedEarningsId,
          accountCode: retainedAccount.code,
          accountNameAr: retainedAccount.nameAr,
          accountNameEn: retainedAccount.nameEn,
          branchId: branch.branchId,
          costCenterId: null,
          debit: branch.amount.lt(0) ? round3(branch.amount.abs()).toString() : '0.000',
          credit: branch.amount.gt(0) ? round3(branch.amount).toString() : '0.000',
        });
      }
    }

    const netResult = round3(
      [...branchNet.values()].reduce((total, branch) => total.plus(branch.amount), new Decimal(0)),
    );
    return { lines, netResult };
  }

  private async previousOpenYears(tx: Prisma.TransactionClient, tenantId: bigint, year: FiscalYear) {
    return tx.fiscalYear.findMany({
      where: {
        tenantId,
        companyId: year.companyId,
        endDate: { lt: year.startDate },
        closings: { none: { status: 'ACTIVE' } },
      },
      select: { id: true, code: true, startDate: true, endDate: true },
      orderBy: { startDate: 'asc' },
    });
  }

  private async activeClosing(tx: Prisma.TransactionClient, tenantId: bigint, year: FiscalYear) {
    return tx.fiscalYearClosing.findFirst({
      where: { tenantId, companyId: year.companyId, fiscalYearId: year.id, status: 'ACTIVE' },
      orderBy: { closedAt: 'desc' },
    });
  }

  private async previewForYear(tx: Prisma.TransactionClient, tenantId: bigint, year: FiscalYear) {
    const [activeClosing, previousOpenYears, drafts, computation] = await Promise.all([
      this.activeClosing(tx, tenantId, year),
      this.previousOpenYears(tx, tenantId, year),
      this.drafts(tx, tenantId, year.companyId, year),
      this.compute(tx, tenantId, year),
    ]);
    const warnings = [
      ...(previousOpenYears.length > 0
        ? [{ code: ErrorCode.PREVIOUS_YEAR_OPEN, details: { years: previousOpenYears.map((item) => item.code) } }]
        : []),
      ...(activeClosing ? [{ code: ErrorCode.YEAR_ALREADY_CLOSED, details: {} }] : []),
      ...(drafts.length > 0 ? [{ code: ErrorCode.YEAR_HAS_DRAFTS, details: { count: drafts.length } }] : []),
    ];
    return {
      fiscalYearId: year.id.toString(),
      code: year.code,
      startDate: year.startDate,
      endDate: year.endDate,
      canClose: warnings.length === 0,
      netResult: round3(computation.netResult).toString(),
      lines: computation.lines.map((line) => ({
        accountId: line.accountId.toString(),
        accountCode: line.accountCode,
        accountNameAr: line.accountNameAr,
        accountNameEn: line.accountNameEn,
        branchId: line.branchId?.toString() ?? null,
        costCenterId: line.costCenterId?.toString() ?? null,
        debit: line.debit,
        credit: line.credit,
      })),
      drafts,
      warnings,
    };
  }

  async preview(yearId: bigint) {
    this.assertAllBranchScope();
    const { tenantId, db } = this.tenant();
    return db.$transaction(async (tx) => {
      const year = await this.year(tx, tenantId, yearId);
      return this.previewForYear(tx, tenantId, year);
    }, POSTING_TX_OPTIONS);
  }

  async close(yearId: bigint) {
    this.assertAllBranchScope();
    const { tenantId, db } = this.tenant();
    const row = await db.fiscalYear.findFirst({
      where: { tenantId, id: yearId },
      select: { id: true, companyId: true },
    });
    if (!row) throw DomainError.notFound('FiscalYear', yearId.toString());
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;

    await retryOnLockConflict(() => db.$transaction(async (tx) => {
      await this.lockYear(tx, tenantId, row.companyId, yearId);
      const year = await this.year(tx, tenantId, yearId);
      const previousOpenYears = await this.previousOpenYears(tx, tenantId, year);
      if (previousOpenYears.length > 0) {
        throw new DomainError(ErrorCode.PREVIOUS_YEAR_OPEN, 'Close all earlier fiscal years first', {
          years: previousOpenYears.map((item) => ({ id: item.id.toString(), code: item.code })),
        });
      }

      if (await this.activeClosing(tx, tenantId, year)) {
        throw new DomainError(ErrorCode.YEAR_ALREADY_CLOSED, 'Fiscal year is already closed');
      }

      const drafts = await this.drafts(tx, tenantId, year.companyId, year);
      if (drafts.length > 0) {
        throw new DomainError(ErrorCode.YEAR_HAS_DRAFTS, 'Draft documents dated in this fiscal year must be completed', {
          drafts,
        });
      }

      const periods = await tx.fiscalPeriod.findMany({
        where: { tenantId, fiscalYearId: year.id },
        orderBy: { periodNo: 'asc' },
      });
      const lastPeriod = periods[periods.length - 1];
      if (!lastPeriod) throw new DomainError(ErrorCode.PERIOD_CLOSED, 'Fiscal year has no periods');
      if (lastPeriod.status === 'CLOSED') {
        await tx.fiscalPeriod.updateMany({
          where: { tenantId, id: lastPeriod.id, status: 'CLOSED' },
          data: { status: 'OPEN', closedAt: null, closedBy: null },
        });
      }
      const computation = await this.compute(tx, tenantId, year);
      const closedAt = new Date();
      const closing = await tx.fiscalYearClosing.create({
        data: {
          tenantId,
          companyId: year.companyId,
          fiscalYearId: year.id,
          status: 'ACTIVE',
          netResult: computation.netResult,
          closedBy: userId,
          closedAt,
        },
      });

      let journalEntryId: bigint | null = null;
      if (computation.lines.length > 0) {
        const entryNo = await this.posting.allocateEntryNo(
          tx,
          tenantId,
          year.companyId,
          'YEAR_CLOSING',
          year.endDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId: year.companyId,
          branchId: null,
          entryDate: year.endDate,
          fiscalPeriodId: lastPeriod.id,
          entryNo,
          sourceType: 'YEAR_CLOSING',
          sourceId: closing.id,
          isClosing: true,
          description: null,
          lines: computation.lines.map(
            (line): JournalLineInput => ({
              accountId: line.accountId,
              debit: line.debit,
              credit: line.credit,
              branchId: line.branchId,
              costCenterId: line.costCenterId,
            }),
          ),
          postedBy: userId,
        });
        journalEntryId = entry.id;
        await tx.fiscalYearClosing.update({
          where: { id: closing.id },
          data: { journalEntryId: entry.id },
        });
      }

      await tx.fiscalPeriod.updateMany({
        where: { tenantId, fiscalYearId: year.id },
        data: { status: 'CLOSED', closedAt, closedBy: userId },
      });
      await tx.fiscalYear.update({ where: { id: year.id }, data: { status: 'CLOSED' } });
      await this.audit.log({
        action: 'fiscal_year.close',
        entityType: 'fiscal_year',
        entityId: yearId,
        before: { status: year.status },
        after: {
          status: 'CLOSED',
          closingId: closing.id.toString(),
          journalEntryId: journalEntryId?.toString() ?? null,
          netResult: round3(computation.netResult).toString(),
        },
      }, tx);
    }, POSTING_TX_OPTIONS));

    return this.fiscal.getYear(yearId);
  }

  async reopen(yearId: bigint) {
    this.assertAllBranchScope();
    const { tenantId, db } = this.tenant();
    const cls = ClsServiceManager.getClsService<RequestContext>();
    if (cls.get('roleCode') !== 'OWNER') {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Only an owner can reopen a closed fiscal year');
    }
    const row = await db.fiscalYear.findFirst({
      where: { tenantId, id: yearId },
      select: { id: true, companyId: true },
    });
    if (!row) throw DomainError.notFound('FiscalYear', yearId.toString());
    const userId = cls.get('userId') ?? null;

    await retryOnLockConflict(() => db.$transaction(async (tx) => {
      await this.lockYear(tx, tenantId, row.companyId, yearId);
      const year = await this.year(tx, tenantId, yearId);
      const closing = await this.activeClosing(tx, tenantId, year);
      if (!closing) {
        throw new DomainError(ErrorCode.CONFLICT, 'Fiscal year has no active year closing');
      }
      const laterClosing = await tx.fiscalYear.findFirst({
        where: {
          tenantId,
          companyId: year.companyId,
          startDate: { gt: year.startDate },
          closings: { some: { status: 'ACTIVE' } },
        },
        select: { id: true, code: true },
        orderBy: { startDate: 'asc' },
      });
      if (laterClosing) {
        throw new DomainError(ErrorCode.LATER_YEAR_CLOSED, 'Reopen later fiscal years first', {
          yearId: laterClosing.id.toString(),
          code: laterClosing.code,
        });
      }

      const periods = await tx.fiscalPeriod.findMany({
        where: { tenantId, fiscalYearId: year.id },
        orderBy: { periodNo: 'asc' },
      });
      const lastPeriod = periods[periods.length - 1];
      if (!lastPeriod) throw new DomainError(ErrorCode.PERIOD_CLOSED, 'Fiscal year has no periods');
      await tx.fiscalPeriod.update({
        where: { id: lastPeriod.id },
        data: { status: 'OPEN', closedAt: null, closedBy: null },
      });

      let reversalEntryId: bigint | null = null;
      if (closing.journalEntryId !== null) {
        const reversal = await this.posting.reverseEntry(tx, {
          tenantId,
          companyId: year.companyId,
          entryId: closing.journalEntryId,
          reversalDate: year.endDate,
          isClosing: true,
          postedBy: userId,
        });
        reversalEntryId = reversal.id;
      }

      const reversedAt = new Date();
      await tx.fiscalYearClosing.update({
        where: { id: closing.id },
        data: {
          status: 'REVERSED',
          reversalEntryId,
          reversedBy: userId,
          reversedAt,
        },
      });
      await tx.fiscalPeriod.updateMany({
        where: { tenantId, fiscalYearId: year.id },
        data: { status: 'OPEN', closedAt: null, closedBy: null },
      });
      await tx.fiscalYear.update({ where: { id: year.id }, data: { status: 'OPEN' } });
      await this.audit.log({
        action: 'fiscal_year.open',
        entityType: 'fiscal_year',
        entityId: yearId,
        before: { status: 'CLOSED', closingId: closing.id.toString() },
        after: { status: 'OPEN', reversalEntryId: reversalEntryId?.toString() ?? null },
      }, tx);
    }, POSTING_TX_OPTIONS));

    return this.fiscal.getYear(yearId);
  }
}
