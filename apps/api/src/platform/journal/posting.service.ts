import { Injectable } from '@nestjs/common';
import { currentCompanySqlFilter } from '../../common/cls/current-company.js';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Prisma } from '../../generated/prisma/client.js';
import { assertPostingCentre, lineCostCenter } from '../cost-centers/cost-center-rules.js';
import { CostCentersService } from '../cost-centers/cost-centers.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';

export interface JournalLineInput {
  accountId: bigint;
  debit?: string | number | Decimal;
  credit?: string | number | Decimal;
  partyType?: 'CUSTOMER' | 'SUPPLIER' | null;
  partyId?: bigint | null;
  description?: string | null;
  branchId?: bigint | null;
  /** The line's own cost centre (manual and opening entries, reversals); ADR-024 §1.2. */
  costCenterId?: bigint | null;
}

export interface NormalizedLine {
  line: JournalLineInput;
  debit: Decimal;
  credit: Decimal;
  /** The centre the line posts with: its own, or the document's on an income-statement line. */
  costCenterId: bigint | null;
}

/** How validateLines places cost centres (ADR-024 §1). */
export interface LineValidationOptions {
  /** The document's header centre, copied onto every income-statement line. */
  costCenterId?: bigint | null;
  /** A reversal carries the original's centres as they are: no required / active / leaf checks. */
  reversal?: boolean;
  isClosing?: boolean;
  /**
   * Enforce COST_CENTER_REQUIRED (ADR-024 §1.3): only for entries typed on a screen
   * with a centre field (manual, opening, invoices, returns, vouchers). Default off:
   * stock documents and cash transfers post a flagged line without a centre.
   */
  requireCostCenters?: boolean;
}

export interface PostEntryParams {
  tenantId: bigint;
  companyId: bigint;
  branchId?: bigint | null;
  entryDate: Date;
  fiscalPeriodId: bigint;
  /**
   * Omit it to let postEntry allocate the JOURNAL_ENTRY number after validating
   * the lines, just before the insert (DB-08): the document_sequences row lock
   * is then held only from there to COMMIT.
   * Callers should post the entry as late as possible.
   */
  entryNo?: string;
  sourceType: string;
  sourceId?: bigint | null;
  postingKind?: 'POST' | 'REVERSAL';
  voucherType?: 'JOURNAL' | 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
  reversalOfId?: bigint | null;
  /** Opening balances entry (§8.6): reports show it as the period's opening. */
  isOpening?: boolean;
  isClosing?: boolean;
  description?: string | null;
  lines: JournalLineInput[];
  postedBy?: bigint | null;
  /**
   * The document's cost centre (ADR-024 §1.2): copied onto every line of an
   * income-statement account that has no centre of its own.
   */
  costCenterId?: bigint | null;
  /** See LineValidationOptions.requireCostCenters; set by the posting paths that have a centre field. */
  requireCostCenters?: boolean;
}

/** Party kind a control account expects, or null when any kind is accepted. */
type ExpectedPartyType = 'CUSTOMER' | 'SUPPLIER' | null;

/**
 * Core double-entry posting engine (docs/BUILD_PLAN.md §8.1, §10).
 * All methods run inside the caller's interactive transaction.
 */
@Injectable()
export class PostingService {
  constructor(private readonly costCenters: CostCentersService) {}

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
   * company, are active + postable, debit XOR credit > 0, and parties follow
   * decision D-2 (docs/reviews decisions D-2: a party only on a customers/suppliers
   * control account). A party control account requires a partyType and partyId
   * matching its control type. A party on any other account is rejected, except
   * on the account currently mapped as CUSTOMERS_CONTROL or SUPPLIERS_CONTROL,
   * which stays a party control account for legacy tenants.
   * Cost centres (ADR-024 §1): a line's own centre is for an income-statement
   * account only (COST_CENTER_NOT_ALLOWED); `opts.costCenterId` (a document's)
   * goes onto every income-statement line without one; while the company has
   * centres enabled, a flagged account's line without a centre is refused
   * (COST_CENTER_REQUIRED) when opts.requireCostCenters (an entry with a centre field). The centres are then locked in share mode, after the
   * accounts, ascending, and must be active leaves of the company. A reversal
   * (`opts.reversal`) carries the original's centres as they are.
   * Returns normalized lines with round3 amounts.
   */
  async validateLines(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    lines: JournalLineInput[],
    opts: LineValidationOptions = {},
  ): Promise<NormalizedLine[]> {
    if (lines.length < 2) {
      throw new DomainError(ErrorCode.VALIDATION, 'Journal entry requires at least 2 lines');
    }

    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    // Shared lock on the accounts, held to COMMIT, read with the lock so the
    // flags are the latest committed ones: an account that is turned into a
    // group, deactivated or re-mapped (FOR UPDATE in AccountsService and
    // MappingsService) waits for this posting, and a posting after that change
    // sees it (review of PR #26, LEDGER-03). Ascending id order, so two
    // postings never take these locks in opposite orders.
    // FORCE INDEX (PRIMARY): every statement that locks an account row by id takes
    // the clustered record first, then any index entry. Left to the optimizer, MariaDB
    // 10.11 read through accounts_tenant_id_id_key (S on the index entry, then on the
    // record) while AccountsService held the record and wanted the entry: a deadlock.
    const rows = (await tx.$queryRaw`
      SELECT id, code, account_type, is_active, is_postable, is_control, control_type, cost_center_required
      FROM accounts FORCE INDEX (PRIMARY)
      WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id IN (${Prisma.join(accountIds)})
      ORDER BY id
      LOCK IN SHARE MODE
    `) as {
      id: bigint;
      code: string;
      account_type: string;
      is_active: number | boolean;
      is_postable: number | boolean;
      is_control: number | boolean;
      control_type: string | null;
      cost_center_required: number | boolean;
    }[];
    const accounts = rows.map((r) => ({
      id: BigInt(r.id),
      code: r.code,
      accountType: r.account_type,
      costCenterRequired: Boolean(r.cost_center_required),
      isActive: Boolean(r.is_active),
      isPostable: Boolean(r.is_postable),
      isControl: Boolean(r.is_control),
      controlType: r.control_type,
    }));
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const isPartyControl = (a: (typeof accounts)[number]): boolean =>
      a.isControl || a.controlType === 'CUSTOMERS' || a.controlType === 'SUPPLIERS';
    const expectedOf = (a: (typeof accounts)[number]): ExpectedPartyType =>
      a.controlType === 'CUSTOMERS' ? 'CUSTOMER' : a.controlType === 'SUPPLIERS' ? 'SUPPLIER' : null;

    // Legacy tenants may have mapped CUSTOMERS_CONTROL / SUPPLIERS_CONTROL to
    // an account without control flags: that account is still a party control
    // account, both ways (a party is allowed on it, and required). Two rows by
    // a unique key, so always loaded.
    const legacyExpected = new Map<bigint, ExpectedPartyType>();
    const mappings = await tx.accountMapping.findMany({
      where: { tenantId, companyId, mappingKey: { in: ['CUSTOMERS_CONTROL', 'SUPPLIERS_CONTROL'] } },
      select: { mappingKey: true, accountId: true },
    });
    for (const m of mappings) {
      legacyExpected.set(m.accountId, m.mappingKey === 'CUSTOMERS_CONTROL' ? 'CUSTOMER' : 'SUPPLIER');
    }

    // ADR-024 §1.3, §1.6: "required" applies only while the company has centres on.
    const company = await tx.company.findFirst({
      where: { tenantId, id: companyId },
      select: { costCentersEnabled: true },
    });
    const centreContext = {
      enabled: company?.costCentersEnabled ?? false,
      header: opts.costCenterId ?? null,
      reversal: opts.reversal ?? false,
      required: opts.isClosing ? false : (opts.requireCostCenters ?? false),
    };

    const normalized = lines.map((line, i): NormalizedLine => {
      const lineNo = i + 1;
      const accountId = line.accountId.toString();
      const account = byId.get(line.accountId);
      if (!account) {
        throw new DomainError(ErrorCode.NOT_FOUND, `Account ${accountId} not found`, {
          line: lineNo,
          accountId,
        });
      }
      if (!opts.isClosing && !account.isActive) {
        throw new DomainError(ErrorCode.ACCOUNT_INACTIVE, `Account ${account.code} is inactive`, {
          line: lineNo,
          accountId,
        });
      }
      if (!account.isPostable) {
        throw new DomainError(
          ErrorCode.ACCOUNT_NOT_POSTABLE,
          `Account ${account.code} is not postable (parent/group account)`,
          { line: lineNo, accountId },
        );
      }

      const debit = round3(line.debit ?? 0);
      const credit = round3(line.credit ?? 0);
      const hasDebit = debit.gt(0);
      const hasCredit = credit.gt(0);
      if (hasDebit === hasCredit) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Line ${lineNo}: exactly one of debit/credit must be > 0`,
          { line: lineNo, accountId },
        );
      }

      // Decide whether this account is a party control account, and which party kind it expects.
      let partyControl = false;
      let expected: ExpectedPartyType = null;
      if (isPartyControl(account)) {
        partyControl = true;
        expected = expectedOf(account);
      } else if (legacyExpected.has(line.accountId)) {
        partyControl = true;
        expected = legacyExpected.get(line.accountId) ?? null;
      }

      if (!partyControl) {
        if (line.partyId || line.partyType) {
          throw new DomainError(
            ErrorCode.PARTY_ON_NON_CONTROL_ACCOUNT,
            `Line ${lineNo}: account ${account.code} is not a customers/suppliers control account; remove the party`,
            { line: lineNo, accountId },
          );
        }
      } else {
        if (!line.partyType || !line.partyId) {
          throw new DomainError(
            ErrorCode.PARTY_REQUIRED,
            `Line ${lineNo}: control account ${account.code} requires partyType and partyId`,
            { line: lineNo, accountId },
          );
        }
        if (expected && line.partyType !== expected) {
          throw new DomainError(
            ErrorCode.PARTY_TYPE_MISMATCH,
            `Line ${lineNo}: account ${account.code} expects partyType ${expected}`,
            { line: lineNo, accountId },
          );
        }
      }

      const costCenterId = lineCostCenter(lineNo, account, line.costCenterId, centreContext);
      return { line, debit, credit, costCenterId };
    });

    // Lock the centres after the accounts, ascending (ADR-024 §1.4): a delete
    // or regrouping of a centre waits for this posting, and sees its lines.
    const centreIds = normalized.map((n) => n.costCenterId).filter((id): id is bigint => id !== null);
    if (centreIds.length > 0) {
      const centres = await this.costCenters.lockForPosting(tx, tenantId, companyId, centreIds);
      normalized.forEach((n, i) => {
        if (n.costCenterId !== null) {
          assertPostingCentre(
            i + 1,
            n.costCenterId,
            centres.get(n.costCenterId),
            centreContext.reversal,
            opts.isClosing,
          );
        }
      });
    }
    return normalized;
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

    const normalized = await this.validateLines(tx, tenantId, companyId, params.lines, {
      costCenterId: params.costCenterId,
      reversal: params.postingKind === 'REVERSAL',
      isClosing: params.isClosing,
      requireCostCenters: params.requireCostCenters,
    });

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

    // DB-08: with no number given, take the JOURNAL_ENTRY number only now,
    // after every check: the sequence row lock is held to COMMIT.
    const entryNo =
      params.entryNo ?? (await this.allocateEntryNo(tx, tenantId, companyId, 'JOURNAL_ENTRY', params.entryDate));

    try {
      const entry = await tx.journalEntry.create({
        data: {
          tenantId,
          companyId,
          branchId: params.branchId ?? null,
          entryNo,
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
          isOpening: params.isOpening ?? false,
          isClosing: params.isClosing ?? false,
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
          costCenterId: n.costCenterId,
          // LEDGER-19: the line keeps its entry's date for the statement indexes.
          entryDate: params.entryDate,
        })),
      });

      return { id: entry.id, entryNo, totalDebit, totalCredit };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        if (params.reversalOfId) {
          throw new DomainError(ErrorCode.ENTRY_ALREADY_REVERSED, 'Entry already reversed', {
            entryId: params.reversalOfId.toString(),
          });
        }
        throw new DomainError(
          ErrorCode.CONFLICT,
          'A journal entry already exists for this source document',
        );
      }
      throw err;
    }
  }

  /**
   * Posts the mirror image (debits ↔ credits) of a posted entry, dated
   * `reversalDate` (§8.3). An entry is reversed once: enforced by the row lock
   * on the original and by the unique (tenant_id, reversal_of_id) index. D-1:
   * "reversed" is derived from the reversal entry; there is no REVERSED status.
   * Shared by manual journal reversal and document reversals (vouchers, cash transfers).
   */
  async reverseEntry(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: bigint;
      companyId: bigint;
      entryId: bigint;
      reversalDate: Date;
      isClosing?: boolean;
      description?: string | null;
      postedBy?: bigint | null;
    },
  ) {
    const { tenantId, companyId, reversalDate } = params;

    // Lock the original row first, so every read below sees a consistent state.
    const locked = (await tx.$queryRaw`
      SELECT id FROM journal_entries
      WHERE tenant_id = ${tenantId} ${currentCompanySqlFilter()} AND id = ${params.entryId}
      FOR UPDATE
    `) as { id: bigint }[];
    if (!locked[0]) throw DomainError.notFound('JournalEntry', params.entryId.toString());

    const original = await tx.journalEntry.findFirst({
      where: { tenantId, id: params.entryId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!original) throw DomainError.notFound('JournalEntry', params.entryId.toString());
    if (original.status !== 'POSTED') {
      throw new DomainError(ErrorCode.ENTRY_NOT_POSTED, 'Only posted entries can be reversed', {
        entryId: original.id.toString(),
      });
    }
    if (original.postingKind === 'REVERSAL') {
      throw new DomainError(ErrorCode.REVERSAL_NOT_REVERSIBLE, 'A reversal entry cannot itself be reversed', {
        entryId: original.id.toString(),
      });
    }

    // A plain read: the row lock above already serialises reversals of this
    // entry. A locking read here would match no row and take a gap lock on
    // the reversal_of_id index, which deadlocks reversals of different
    // entries and blocks the tenant's other journal inserts (review of PR #26).
    // If this snapshot predates a concurrent reversal, the unique
    // (tenant_id, reversal_of_id) index refuses the insert: ENTRY_ALREADY_REVERSED.
    const existing = await tx.journalEntry.findFirst({
      where: { tenantId, reversalOfId: original.id },
      select: { id: true },
    });
    if (existing) {
      throw new DomainError(ErrorCode.ENTRY_ALREADY_REVERSED, 'Entry already reversed', {
        entryId: original.id.toString(),
      });
    }

    // LEDGER-10: both dates are calendar dates at UTC midnight.
    if (reversalDate.getTime() < original.entryDate.getTime()) {
      throw new DomainError(
        ErrorCode.REVERSAL_BEFORE_ORIGINAL,
        'The reversal date is before the original entry date',
        { entryDate: original.entryDate.toISOString().slice(0, 10) },
      );
    }

    const period = await this.resolveOpenPeriod(tx, tenantId, companyId, reversalDate);
    const swapped: JournalLineInput[] = original.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit.toString(),
      credit: l.debit.toString(),
      partyType: l.partyType,
      partyId: l.partyId,
      description: l.description,
      branchId: l.branchId,
      // ADR-024 §1.10: the reversal keeps each line's centre.
      costCenterId: l.costCenterId,
    }));
    return this.postEntry(tx, {
      tenantId,
      companyId,
      branchId: original.branchId,
      entryDate: reversalDate,
      fiscalPeriodId: period.id,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      postingKind: 'REVERSAL',
      voucherType: original.voucherType,
      reversalOfId: original.id,
      // A reversed opening entry stays in the opening balance (it nets out).
      isOpening: original.isOpening,
      isClosing: params.isClosing ?? original.isClosing,
      description: params.description ?? null,
      lines: swapped,
      postedBy: params.postedBy ?? null,
    });
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
    // DB-20: re-read the status under a shared lock held to COMMIT. A concurrent
    // close waits for this posting, and a posting after a close sees CLOSED.
    const [row] = (await tx.$queryRaw`
      SELECT status FROM fiscal_periods
      WHERE tenant_id = ${tenantId} AND id = ${period.id}
      LOCK IN SHARE MODE
    `) as { status: string }[];
    if (!row || row.status !== 'OPEN') {
      throw new DomainError(
        ErrorCode.PERIOD_CLOSED,
        `Fiscal period ${period.periodNo} is closed`,
      );
    }
    return { id: period.id, status: row.status };
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
    return allocateDocumentNo(tx, tenantId, companyId, documentType, date);
  }
}
