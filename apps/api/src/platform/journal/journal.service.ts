import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, branchWhere, currentBranchId } from '../../common/branch/branch-context.js';
import { findPage } from '../../common/paging/find-page.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PartiesService } from '../parties/parties.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import {
  CreateJournalEntryDto,
  CreateOpeningEntryDto,
  type ListJournalEntriesQueryDto,
  ReverseJournalEntryDto,
} from './dto/journal.dto.js';
import {
  PostingService,
  type JournalLineInput,
  type NormalizedLine,
} from './posting.service.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';

const MANUAL_SOURCE = 'MANUAL_JOURNAL';
const OPENING_SOURCE = 'OPENING_ENTRY';

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const msg = String((err as Error)?.message ?? '');
  return code === 'P2034' || /deadlock|lock wait timeout/i.test(msg);
}

/**
 * Manual journal lifecycle: DRAFT → POSTED, plus reversal and the guided
 * opening-balance entry (docs/BUILD_PLAN.md §8.2, §8.3, §8.6).
 */
@Injectable()
export class JournalService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly parties: PartiesService,
    private readonly partyUsage: PartyUsageRegistry,
  ) {}

  onModuleInit(): void {
    this.partyUsage.register('journal', (tx, partyId) => this.partyInUse(tx, partyId));
  }

  /**
   * DB-15 / ADR-021: the first journal table that references the party in
   * any status (drafts included), or null, read on the caller's transaction.
   * A party used here is deactivated, never deleted.
   */
  async partyInUse(tx: Prisma.TransactionClient, partyId: bigint): Promise<string | null> {
    // journal_lines.party_id has no FK to parties: this check is the only guard.
    const line = await tx.journalLine.findFirst({
      where: { partyType: { in: ['CUSTOMER', 'SUPPLIER'] }, partyId },
      select: { id: true },
    });
    return line ? 'journal_lines' : null;
  }

  /**
   * Party ids typed by the user (manual and opening entries) must be parties
   * of this company, of the line's kind (a BOTH party fits either). Document
   * entries take their party from the document, so they skip this.
   * Runs inside the transaction that inserts the lines: the parties are
   * shared-locked until COMMIT, so a concurrent delete can't orphan a line
   * (journal_lines.party_id has no FK; ADR-021).
   */
  private async assertParties(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    lines: { partyType?: 'CUSTOMER' | 'SUPPLIER' | null; partyId?: string | null }[],
  ): Promise<void> {
    const ids = [...new Set(lines.filter((l) => l.partyId).map((l) => BigInt(l.partyId!)))];
    if (ids.length === 0) return;
    const typeById = await this.parties.lockForReference(tx, companyId, ids);
    lines.forEach((l, i) => {
      if (!l.partyId) return;
      const type = typeById.get(BigInt(l.partyId));
      if (!type) {
        throw new DomainError(ErrorCode.NOT_FOUND, `Line ${i + 1}: party ${l.partyId} not found`, {
          line: i + 1,
          partyId: l.partyId,
        });
      }
      if (l.partyType && type !== 'BOTH' && type !== l.partyType) {
        throw new DomainError(
          ErrorCode.PARTY_TYPE_MISMATCH,
          `Line ${i + 1}: party ${l.partyId} is a ${type}, not a ${l.partyType}`,
          { line: i + 1, partyId: l.partyId },
        );
      }
    });
  }

  /**
   * LEDGER-09: an account id that is missing or belongs to another tenant or
   * company must be a 404 here, not a foreign-key failure (500) at insert time.
   */
  private async assertAccountsExist(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    lines: { accountId: string }[],
  ): Promise<void> {
    const ids = [...new Set(lines.map((l) => BigInt(l.accountId)))];
    const found = new Set(
      (await db.account.findMany({
        where: { companyId, id: { in: ids } },
        select: { id: true },
      })).map((a) => a.id),
    );
    lines.forEach((l, i) => {
      if (!found.has(BigInt(l.accountId))) {
        throw new DomainError(ErrorCode.NOT_FOUND, `Line ${i + 1}: account ${l.accountId} not found`, {
          line: i + 1,
          accountId: l.accountId,
        });
      }
    });
  }

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

  private userId(): bigint | undefined {
    return ClsServiceManager.getClsService<RequestContext>().get('userId');
  }

  /**
   * One numbered page of journal entries (ADR-022, LEDGER-08): the caller's
   * branches only (ADR-003 §10), newest first unless `sort` says otherwise.
   */
  async list(query: ListJournalEntriesQueryDto) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    if (query.from && query.to && query.from > query.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: query.from, to: query.to });
    }
    const q = query.q;
    const where: Prisma.JournalEntryWhereInput = {
      companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.voucherType ? { voucherType: query.voucherType } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.from || query.to
        ? {
            entryDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      AND: [
        branchWhere(),
        q ? { OR: [{ entryNo: { contains: q } }, { description: { contains: q } }] } : {},
      ],
    };
    const orderBy = orderByOf<'entryDate' | 'entryNo', Prisma.JournalEntryOrderByWithRelationInput>(
      query.sort,
      '-entryDate',
      { entryDate: (dir) => ({ entryDate: dir }), entryNo: (dir) => ({ entryNo: dir }) },
      (dir) => ({ id: dir }),
    );
    return findPage(db, pageWindow(query), {
      rows: async (tx, window) => {
        const entries = await tx.journalEntry.findMany({
          where,
          orderBy,
          // reversals: lets the list tag reversed entries.
          include: { reversals: { select: { id: true, entryNo: true } } },
          ...window,
        });
        // Line counts of this page only. Prisma's `_count` include joins a
        // GROUP BY over every tenant's journal_lines (WHERE 1=1): ~3.4 s on
        // 750k lines, whatever the page (Wave 4A). This reads ≤ pageSize
        // entries' lines through (tenant_id, journal_entry_id, line_no).
        const counts = entries.length
          ? await tx.journalLine.groupBy({
              by: ['journalEntryId'],
              where: { journalEntryId: { in: entries.map((e) => e.id) } },
              _count: { _all: true },
            })
          : [];
        const byEntry = new Map(counts.map((c) => [c.journalEntryId, c._count._all]));
        return entries.map((e) => ({ ...e, _count: { lines: byEntry.get(e.id) ?? 0 } }));
      },
      count: (tx) => tx.journalEntry.count({ where }),
    });
  }

  /** One entry; another branch's answers 404 like another tenant's (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.tenant();
    const entry = await db.journalEntry.findFirst({
      where: { id, ...branchWhere() },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            account: { select: { id: true, code: true, nameAr: true, nameEn: true } },
          },
        },
        reversalOf: { select: { id: true, entryNo: true, entryDate: true } },
        reversals: { select: { id: true, entryNo: true, entryDate: true, status: true } },
      },
    });
    if (!entry) throw DomainError.notFound('JournalEntry', id.toString());
    return entry;
  }

  /** Creates a DRAFT manual journal. Posting happens via /post. */
  async createDraft(dto: CreateJournalEntryDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const branchId = currentBranchId();
    await this.assertAccountsExist(db, companyId, dto.lines);

    const entry = await db.$transaction(async (tx) => {
      await this.assertParties(tx, companyId, dto.lines);
      const created = await tx.journalEntry.create({
        data: {
          tenantId,
          companyId,
          // Branch from the request context (BranchGuard), never the body — ADR-003.
          branchId,
          entryDate: new Date(dto.entryDate),
          sourceType: MANUAL_SOURCE,
          voucherType: dto.voucherType ?? 'JOURNAL',
          status: 'DRAFT',
          description: dto.description ?? null,
        },
      });
      // source_id = own id keeps the (source_type, source_id, kind) unique
      // slot occupied for this draft and its future reversal.
      await tx.journalEntry.update({
        where: { id: created.id },
        data: { sourceId: created.id },
      });
      await tx.journalLine.createMany({
        data: dto.lines.map((l, i) => ({
          tenantId,
          journalEntryId: created.id,
          lineNo: i + 1,
          accountId: BigInt(l.accountId),
          debit: l.debit ?? '0',
          credit: l.credit ?? '0',
          partyType: l.partyType ?? null,
          partyId: l.partyId ? BigInt(l.partyId) : null,
          description: l.description ?? null,
          branchId,
          // LEDGER-19: the line keeps its entry's date (a draft's date never changes).
          entryDate: created.entryDate,
        })),
      });
      return created;
    }, POSTING_TX_OPTIONS);

    await this.audit.log({
      action: 'journal.create_draft',
      entityType: 'journal_entry',
      entityId: entry.id,
      after: { entryDate: dto.entryDate, lines: dto.lines.length },
    });
    return this.get(entry.id);
  }

  /** Deletes a DRAFT entry (and its lines via cascade). */
  async deleteDraft(id: bigint) {
    const { tenantId, db } = this.tenant();
    // LEDGER-01: a delete racing a post used to remove a posted entry. Lock the
    // row first and re-check the status inside the same transaction.
    await this.withRetry(() => db.$transaction(async (tx) => {
      const rows = (await tx.$queryRaw`
        SELECT id, status, branch_id FROM journal_entries
        WHERE tenant_id = ${tenantId} AND id = ${id}
        FOR UPDATE
      `) as { id: bigint; status: string; branch_id: bigint | null }[];
      const entry = rows[0];
      if (!entry) throw DomainError.notFound('JournalEntry', id.toString());
      if (entry.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.ENTRY_NOT_DRAFT, 'Only draft entries can be deleted');
      }
      assertBranchAllowed(entry.branch_id);
      const { count } = await tx.journalEntry.deleteMany({
        where: { tenantId, id, status: 'DRAFT' },
      });
      if (count !== 1) {
        throw new DomainError(ErrorCode.ENTRY_NOT_DRAFT, 'Only draft entries can be deleted');
      }
    }, POSTING_TX_OPTIONS));
    await this.audit.log({
      action: 'journal.delete_draft',
      entityType: 'journal_entry',
      entityId: id,
    });
    return { deleted: true };
  }

  /**
   * Posts a DRAFT manual journal: validates period/accounts/balance,
   * allocates the JV number, flips to POSTED — one transaction.
   */
  async postDraft(id: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();

    const result = await this.withRetry(() =>
      db.$transaction(async (tx) => {
        // Lock the draft row.
        const rows = (await tx.$queryRaw`
          SELECT id, status, entry_date, description, branch_id, voucher_type
          FROM journal_entries
          WHERE tenant_id = ${tenantId} AND id = ${id}
          FOR UPDATE
        `) as {
          id: bigint;
          status: string;
          entry_date: Date;
          description: string | null;
          branch_id: bigint | null;
          voucher_type: 'JOURNAL' | 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
        }[];
        const draft = rows[0];
        if (!draft) throw DomainError.notFound('JournalEntry', id.toString());
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.ENTRY_NOT_DRAFT, 'Entry is not a draft');
        }
        assertBranchAllowed(draft.branch_id);

        const lines = await tx.journalLine.findMany({
          where: { tenantId, journalEntryId: id },
          orderBy: { lineNo: 'asc' },
        });

        const entryDate = new Date(draft.entry_date);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, entryDate);

        const input: JournalLineInput[] = lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit.toString(),
          credit: l.credit.toString(),
          partyType: l.partyType,
          partyId: l.partyId,
          description: l.description,
          branchId: l.branchId,
        }));

        const normalized = await this.posting.validateLines(tx, tenantId, companyId, input);
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

        if (draft.voucher_type !== 'JOURNAL') {
          await this.assertVoucherRules(tx, tenantId, companyId, draft.voucher_type, normalized);
        }

        // DB-08: the JOURNAL_ENTRY sequence row lock is held to COMMIT, so the
        // number is taken last, after every check has passed.
        const entryNo = await this.posting.allocateEntryNo(
          tx,
          tenantId,
          companyId,
          'JOURNAL_ENTRY',
          entryDate,
        );

        await tx.journalEntry.update({
          where: { id },
          data: {
            status: 'POSTED',
            entryNo,
            fiscalPeriodId: period.id,
            totalDebit,
            totalCredit,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        return { id, entryNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'journal.post',
      entityType: 'journal_entry',
      entityId: id,
      after: result,
    });
    return this.get(id);
  }

  /**
   * Reverses a POSTED entry: new entry posting_kind=REVERSAL, swapped
   * debit/credit, reversal date = supplied date in an OPEN period.
   */
  async reverse(id: bigint, dto: ReverseJournalEntryDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();

    const result = await this.withRetry(() =>
      db.$transaction(async (tx) => {
        // LEDGER-02: lock first, so this transaction's reads see a concurrent reversal.
        const rows = (await tx.$queryRaw`
          SELECT id, source_type FROM journal_entries
          WHERE tenant_id = ${tenantId} AND id = ${id}
          FOR UPDATE
        `) as { id: bigint; source_type: string }[];
        const original = rows[0];
        if (!original) throw DomainError.notFound('JournalEntry', id.toString());
        // Entries generated by a document (invoice, voucher, stock…) are
        // reversed through that document, so its stock, allocations and
        // status stay consistent with the books.
        if (original.source_type !== MANUAL_SOURCE && original.source_type !== OPENING_SOURCE) {
          throw new DomainError(
            ErrorCode.REVERSE_VIA_DOCUMENT,
            `This entry was generated by ${original.source_type}; reverse that document instead`,
          );
        }
        return this.posting.reverseEntry(tx, {
          tenantId,
          companyId,
          entryId: original.id,
          reversalDate: new Date(dto.reversalDate),
          description: dto.description,
          postedBy: userId ?? null,
        });
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'journal.reverse',
      entityType: 'journal_entry',
      entityId: id,
      after: { reversalId: result.id, entryNo: result.entryNo },
    });
    return this.get(result.id);
  }

  /**
   * Guided opening-balance entry (§8.6): user supplies account lines; the
   * difference is plugged to OPENING_BALANCE_EQUITY and the entry posts
   * immediately as source_type=OPENING_ENTRY.
   */
  async createOpening(dto: CreateOpeningEntryDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const userId = this.userId();
    await this.assertAccountsExist(db, companyId, dto.lines);

    const result = await this.withRetry(() =>
      db.$transaction(async (tx) => {
        await this.assertParties(tx, companyId, dto.lines);
        const entryDate = new Date(dto.entryDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, entryDate);

        // D-3 / LEDGER-16: an opening entry is dated on the first day of its fiscal
        // year. A company that starts mid-year creates a fiscal year that starts on its go-live date.
        const year = await tx.fiscalYear.findFirst({
          where: { tenantId, companyId, startDate: { lte: entryDate }, endDate: { gte: entryDate } },
          select: { startDate: true },
        });
        if (year && year.startDate.getTime() !== entryDate.getTime()) {
          throw new DomainError(
            ErrorCode.OPENING_DATE_NOT_YEAR_START,
            'An opening entry is dated on the first day of its fiscal year',
            { fiscalYearStart: year.startDate.toISOString().slice(0, 10) },
          );
        }

        const mappings = await tx.accountMapping.findMany({
          where: { tenantId, companyId, mappingKey: { in: ['OPENING_BALANCE_EQUITY', 'INVENTORY'] } },
          select: { mappingKey: true, accountId: true },
        });
        const mapping = mappings.find((m) => m.mappingKey === 'OPENING_BALANCE_EQUITY');
        if (!mapping) {
          throw new DomainError(ErrorCode.INTERNAL, 'OPENING_BALANCE_EQUITY mapping missing');
        }

        // §8.6: the inventory account balance must equal the opening stock
        // value, which only an OPENING stock adjustment produces (with its
        // movements and costs). A manual line here would double-count it.
        const inventoryAccountId = mappings.find((m) => m.mappingKey === 'INVENTORY')?.accountId;
        if (inventoryAccountId !== undefined) {
          const lineNo = dto.lines.findIndex((l) => BigInt(l.accountId) === inventoryAccountId);
          if (lineNo >= 0) {
            throw new DomainError(
              ErrorCode.OPENING_INVENTORY_VIA_STOCK,
              'Enter opening stock through an OPENING stock adjustment, not on the inventory account',
              { line: lineNo + 1, accountId: inventoryAccountId.toString() },
            );
          }
        }

        const lines: JournalLineInput[] = dto.lines.map((l) => ({
          accountId: BigInt(l.accountId),
          debit: l.debit ?? '0',
          credit: l.credit ?? '0',
          partyType: l.partyType ?? null,
          partyId: l.partyId ? BigInt(l.partyId) : null,
          description: l.description ?? null,
        }));

        // Plug the difference into OPENING_BALANCE_EQUITY.
        const { debit: td, credit: tc } = this.posting.totals(lines);
        const diff = td.minus(tc);
        if (!diff.isZero()) {
          lines.push(
            diff.gt(0)
              ? { accountId: mapping.accountId, credit: diff.toString() }
              : { accountId: mapping.accountId, debit: diff.abs().toString() },
          );
        }

        const entryNo = await this.posting.allocateEntryNo(
          tx,
          tenantId,
          companyId,
          'OPENING_ENTRY',
          entryDate,
        );

        // source_id stays NULL: the unique index treats NULLs as distinct,
        // and a company may enter its opening balances in several entries.
        // Double-submit protection comes from the mandatory Idempotency-Key
        // on this endpoint (@RequiresIdempotencyKey on the route).
        return this.posting.postEntry(tx, {
          tenantId,
          companyId,
          entryDate,
          fiscalPeriodId: period.id,
          entryNo,
          sourceType: OPENING_SOURCE,
          sourceId: null,
          isOpening: true,
          description: dto.description ?? null,
          lines,
          postedBy: userId ?? null,
        });
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'journal.opening_entry',
      entityType: 'journal_entry',
      entityId: result.id,
      after: { entryNo: result.entryNo },
    });
    return this.get(result.id);
  }

  /**
   * Cash/bank voucher rules (سند قبض / سند صرف): a RECEIPT voucher must
   * debit a cash/bank account and must not credit one; a PAYMENT voucher
   * mirrors this. "Cash/bank" = account.controlType CASH or BANK.
   */
  private async assertVoucherRules(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    voucherType: 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER',
    normalized: NormalizedLine[],
  ): Promise<void> {
    const ids = [...new Set(normalized.map((n) => n.line.accountId))];
    const accounts = await tx.account.findMany({
      where: { tenantId, companyId, id: { in: ids } },
      select: { id: true, controlType: true },
    });
    const controlById = new Map(accounts.map((a) => [a.id, a.controlType]));
    const isCashBank = (id: bigint) => {
      const ct = controlById.get(id);
      return ct === 'CASH' || ct === 'BANK';
    };

    const isReceipt = voucherType === 'RECEIPT_VOUCHER';
    const cashDebit = normalized.some((n) => n.debit.gt(0) && isCashBank(n.line.accountId));
    const cashCredit = normalized.some((n) => n.credit.gt(0) && isCashBank(n.line.accountId));

    if (isReceipt ? !cashDebit : !cashCredit) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        isReceipt
          ? 'Receipt voucher requires a debit line on a cash/bank account'
          : 'Payment voucher requires a credit line on a cash/bank account',
      );
    }
    if (isReceipt ? cashCredit : cashDebit) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        isReceipt
          ? 'Receipt voucher cannot credit a cash/bank account'
          : 'Payment voucher cannot debit a cash/bank account',
      );
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isRetryable(err)) return fn();
      throw err;
    }
  }
}
