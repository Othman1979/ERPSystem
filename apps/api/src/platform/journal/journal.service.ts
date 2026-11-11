import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PartiesService } from '../parties/parties.service.js';
import {
  CreateJournalEntryDto,
  CreateOpeningEntryDto,
  ReverseJournalEntryDto,
} from './dto/journal.dto.js';
import {
  PostingService,
  type JournalLineInput,
  type NormalizedLine,
} from './posting.service.js';

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
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly parties: PartiesService,
  ) {}

  /**
   * Party ids typed by the user (manual and opening entries) must be parties
   * of this company, of the line's kind (a BOTH party fits either). Document
   * entries take their party from the document, so they skip this.
   */
  private async assertParties(
    lines: { partyType?: 'CUSTOMER' | 'SUPPLIER' | null; partyId?: string | null }[],
  ): Promise<void> {
    const ids = [...new Set(lines.filter((l) => l.partyId).map((l) => BigInt(l.partyId!)))];
    if (ids.length === 0) return;
    const typeById = new Map((await this.parties.summaries(ids)).map((p) => [p.id, p.partyType]));
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
          ErrorCode.VALIDATION,
          `Line ${i + 1}: party ${l.partyId} is a ${type}, not a ${l.partyType}`,
          { line: i + 1, partyId: l.partyId },
        );
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

  async list(status?: string, voucherType?: string, sourceType?: string) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    if (sourceType && sourceType !== MANUAL_SOURCE && sourceType !== OPENING_SOURCE) {
      throw new DomainError(ErrorCode.VALIDATION, `Unsupported sourceType filter: ${sourceType}`);
    }
    return db.journalEntry.findMany({
      where: {
        companyId,
        ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}),
        ...(voucherType ? { voucherType: voucherType as 'JOURNAL' | 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER' } : {}),
        ...(sourceType ? { sourceType } : {}),
      },
      orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
      // reversals: lets the list tag reversed entries.
      include: { _count: { select: { lines: true } }, reversals: { select: { id: true, entryNo: true } } },
      take: 200,
    });
  }

  async get(id: bigint) {
    const { db } = this.tenant();
    const entry = await db.journalEntry.findFirst({
      where: { id },
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
    await this.assertParties(dto.lines);

    const entry = await db.$transaction(async (tx) => {
      const created = await tx.journalEntry.create({
        data: {
          tenantId,
          companyId,
          branchId: dto.branchId ? BigInt(dto.branchId) : null,
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
          branchId: l.branchId
            ? BigInt(l.branchId)
            : dto.branchId
              ? BigInt(dto.branchId)
              : null,
        })),
      });
      return created;
    });

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
    const { db } = this.tenant();
    const entry = await db.journalEntry.findFirst({ where: { id } });
    if (!entry) throw DomainError.notFound('JournalEntry', id.toString());
    if (entry.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft entries can be deleted');
    }
    await db.journalEntry.delete({ where: { id } });
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
          throw new DomainError(ErrorCode.CONFLICT, 'Entry is not a draft');
        }

        const lines = await tx.journalLine.findMany({
          where: { tenantId, journalEntryId: id },
          orderBy: { lineNo: 'asc' },
        });

        const entryDate = new Date(draft.entry_date);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, entryDate);
        const entryNo = await this.posting.allocateEntryNo(
          tx,
          tenantId,
          companyId,
          'JOURNAL_ENTRY',
          entryDate,
        );

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
      }),
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
        const original = await tx.journalEntry.findFirst({
          where: { tenantId, id },
          select: { id: true, sourceType: true },
        });
        if (!original) throw DomainError.notFound('JournalEntry', id.toString());
        // Entries generated by a document (invoice, voucher, stock…) are
        // reversed through that document, so its stock, allocations and
        // status stay consistent with the books.
        if (original.sourceType !== MANUAL_SOURCE && original.sourceType !== OPENING_SOURCE) {
          throw new DomainError(
            ErrorCode.REVERSE_VIA_DOCUMENT,
            `This entry was generated by ${original.sourceType}; reverse that document instead`,
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
      }),
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
    await this.assertParties(dto.lines);

    const result = await this.withRetry(() =>
      db.$transaction(async (tx) => {
        const entryDate = new Date(dto.entryDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, entryDate);

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
        // on this endpoint (ACTIVITY_PATH in the idempotency interceptor).
        return this.posting.postEntry(tx, {
          tenantId,
          companyId,
          entryDate,
          fiscalPeriodId: period.id,
          entryNo,
          sourceType: OPENING_SOURCE,
          sourceId: null,
          description: dto.description ?? 'Opening balances',
          lines,
          postedBy: userId ?? null,
        });
      }),
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
