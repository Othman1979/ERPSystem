import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { hasAllBranches } from '../../common/branch/branch-context.js';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Prisma } from '../../generated/prisma/client.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import type { UploadedSheet } from '../inventory/count-sheet-import.js';
import { DocumentSupportService, retryOnLockConflict } from '../shared/document-support.service.js';
import { readStatementRows } from './bank-statement-import.js';

type Tx = Prisma.TransactionClient;
type Statement = Prisma.BankStatementGetPayload<object>;

export interface StatementHeaderInput {
  startDate: string;
  endDate: string;
  openingBalance: string;
  closingBalance: string;
}

export interface StatementLineInput {
  lineDate: string;
  description?: string;
  reference?: string;
  deposit?: string;
  withdrawal?: string;
}

/** A posted journal line on the bank's ledger account that no statement has cleared yet. */
interface BookLine {
  id: bigint;
  entryId: bigint;
  entryNo: string | null;
  sourceType: string;
  entryDate: Date;
  description: string | null;
  reference: string | null;
  amount: Decimal;
}

const AUTO_MATCH_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO = new Decimal(0);
const MONEY = /^\d+(\.\d{1,3})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function toDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** A yyyy-mm-dd that names a real day; `toDate` alone rolls 2031-04-31 over to May 1. */
function calendarDate(value: string, field: string): Date {
  const date = toDate(value);
  if (Number.isNaN(date.getTime()) || dateText(date) !== value) {
    throw new DomainError(ErrorCode.VALIDATION, `${field} is not a calendar date`, { field });
  }
  return date;
}

function money(value: Decimal.Value): string {
  return round3(value).toFixed(3);
}

/** ADR-035: bank statements, matching against posted ledger lines, and reconciliation. */
@Injectable()
export class BankReconciliationService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
  ) {}

  /** A bank account's ledger lines come from every branch, so reconciliation needs every branch (ADR-035 §8). */
  private context() {
    if (!hasAllBranches()) {
      throw new DomainError(ErrorCode.BRANCH_NOT_ALLOWED, 'Bank reconciliation requires access to all branches');
    }
    return this.support.tenant();
  }

  private write<T>(fn: (tx: Tx, tenantId: bigint) => Promise<T>): Promise<T> {
    const { tenantId, db } = this.context();
    return retryOnLockConflict(() => db.$transaction((tx) => fn(tx, tenantId), POSTING_TX_OPTIONS));
  }

  private async lockBankAccount(tx: Tx, tenantId: bigint, bankAccountId: bigint): Promise<void> {
    await tx.$queryRaw`SELECT id FROM bank_accounts WHERE tenant_id = ${tenantId} AND id = ${bankAccountId} FOR UPDATE`;
  }

  /**
   * Locks the statement, then its bank account, and returns it. The locking read comes
   * first so the transaction's snapshot sees the latest committed status.
   */
  private async lockStatement(tx: Tx, tenantId: bigint, id: bigint, draft = true): Promise<Statement> {
    const rows = await tx.$queryRaw<{ bank_account_id: bigint }[]>`
      SELECT bank_account_id FROM bank_statements WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    if (!rows[0]) throw DomainError.notFound('BankStatement', id.toString());
    await this.lockBankAccount(tx, tenantId, BigInt(rows[0].bank_account_id));
    const statement = await tx.bankStatement.findFirstOrThrow({ where: { tenantId, id } });
    if (draft && statement.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.BANK_STATEMENT_NOT_DRAFT, 'The bank statement is reconciled; reopen it first');
    }
    return statement;
  }

  private parseHeader(input: StatementHeaderInput) {
    const startDate = calendarDate(input.startDate, 'startDate');
    const endDate = calendarDate(input.endDate, 'endDate');
    if (endDate < startDate) {
      throw new DomainError(ErrorCode.VALIDATION, 'The statement ends before it starts', { field: 'endDate' });
    }
    return {
      startDate,
      endDate,
      openingBalance: round3(input.openingBalance),
      closingBalance: round3(input.closingBalance),
    };
  }

  /** ADR-035 §2: statements follow each other; the opening balance carries the previous closing one. */
  private async assertSequence(
    tx: Tx,
    tenantId: bigint,
    bankAccountId: bigint,
    header: ReturnType<BankReconciliationService['parseHeader']>,
    excludeId?: bigint,
  ): Promise<void> {
    const previous = await tx.bankStatement.findFirst({
      where: { tenantId, bankAccountId, ...(excludeId ? { id: { not: excludeId } } : {}) },
      orderBy: { endDate: 'desc' },
    });
    if (!previous) return;
    if (header.startDate <= previous.endDate) {
      throw new DomainError(ErrorCode.BANK_STATEMENT_OVERLAP, 'The statement must start after the previous one ends', {
        previousEndDate: dateText(previous.endDate),
      });
    }
    if (!header.openingBalance.equals(previous.closingBalance)) {
      throw new DomainError(
        ErrorCode.BANK_STATEMENT_OPENING_MISMATCH,
        'The opening balance must equal the previous statement closing balance',
        { expected: money(previous.closingBalance) },
      );
    }
  }

  private async bankAccount(tx: Tx, tenantId: bigint, bankAccountId: bigint) {
    const bank = await tx.bankAccount.findFirst({ where: { tenantId, id: bankAccountId } });
    if (!bank) throw DomainError.notFound('BankAccount', bankAccountId.toString());
    return bank;
  }

  /** The first statement's start: ledger lines before it are part of its opening balance (ADR-035 §3). */
  private async cutoff(tx: Tx, tenantId: bigint, bankAccountId: bigint): Promise<Date> {
    const first = await tx.bankStatement.findFirst({
      where: { tenantId, bankAccountId },
      orderBy: { startDate: 'asc' },
      select: { startDate: true },
    });
    return first!.startDate;
  }

  /**
   * Posted, uncleared ledger lines of the bank account dated from the cutoff to the statement end.
   * Opening entries are left out: their balance is the first statement's opening balance.
   * `asOfStatement`: also the lines a later statement cleared, so a reconciled statement keeps its outstanding items.
   */
  private async openBookLines(
    tx: Tx,
    tenantId: bigint,
    statement: Statement,
    ids?: bigint[],
    asOfStatement = false,
  ): Promise<BookLine[]> {
    const bank = await this.bankAccount(tx, tenantId, statement.bankAccountId);
    const cutoff = await this.cutoff(tx, tenantId, statement.bankAccountId);
    const lines = await tx.journalLine.findMany({
      where: {
        tenantId,
        accountId: bank.accountId,
        entryDate: { gte: cutoff, lte: statement.endDate },
        entry: { companyId: statement.companyId, status: 'POSTED', isOpening: false },
        ...(asOfStatement
          ? {
              OR: [
                { bankStatementMatch: { is: null } },
                { bankStatementMatch: { is: { statement: { startDate: { gt: statement.endDate } } } } },
              ],
            }
          : { bankStatementMatch: { is: null } }),
        ...(ids ? { id: { in: ids } } : {}),
      },
      include: { entry: { select: { id: true, entryNo: true, sourceType: true, description: true } } },
      orderBy: [{ entryDate: 'asc' }, { journalEntryId: 'asc' }, { lineNo: 'asc' }],
    });
    const references = await this.references(tx, tenantId, lines.map((line) => line.journalEntryId));
    return lines.map((line) => ({
      id: line.id,
      entryId: line.entry.id,
      entryNo: line.entry.entryNo,
      sourceType: line.entry.sourceType,
      entryDate: line.entryDate,
      description: line.description ?? line.entry.description,
      reference: references.get(line.journalEntryId) ?? null,
      amount: new Decimal(line.debit.toString()).minus(line.credit.toString()),
    }));
  }

  /** The reference numbers of the treasury documents behind the given entries. */
  private async references(tx: Tx, tenantId: bigint, entryIds: bigint[]): Promise<Map<bigint, string>> {
    const out = new Map<bigint, string>();
    if (entryIds.length === 0) return out;
    const where = { tenantId, journalEntryId: { in: [...new Set(entryIds)] }, referenceNo: { not: null } };
    const select = { journalEntryId: true, referenceNo: true } as const;
    const [receipts, payments, transfers] = await Promise.all([
      tx.receipt.findMany({ where, select }),
      tx.payment.findMany({ where, select }),
      tx.cashTransfer.findMany({ where, select }),
    ]);
    for (const row of [...receipts, ...payments, ...transfers]) {
      if (row.journalEntryId && row.referenceNo) out.set(row.journalEntryId, row.referenceNo);
    }
    // ADR-037 §6: a cheque collection or clearance is referenced by its cheque number.
    const steps = await tx.chequeEvent.findMany({
      where: { tenantId, journalEntryId: { in: [...new Set(entryIds)] } },
      select: { journalEntryId: true, cheque: { select: { chequeNo: true } } },
    });
    for (const step of steps) if (step.journalEntryId) out.set(step.journalEntryId, step.cheque.chequeNo);
    return out;
  }

  /** Book balance up to the statement end and the outstanding items (ADR-035 §6). */
  private async summary(tx: Tx, tenantId: bigint, statement: Statement) {
    const bank = await this.bankAccount(tx, tenantId, statement.bankAccountId);
    const [sums, lines, open] = await Promise.all([
      tx.journalLine.aggregate({
        where: {
          tenantId,
          accountId: bank.accountId,
          entryDate: { lte: statement.endDate },
          entry: { companyId: statement.companyId, status: 'POSTED' },
        },
        _sum: { debit: true, credit: true },
      }),
      tx.bankStatementLine.findMany({ where: { tenantId, statementId: statement.id }, select: { deposit: true, withdrawal: true } }),
      this.openBookLines(tx, tenantId, statement, undefined, true),
    ]);
    const bookBalance = new Decimal(sums._sum.debit?.toString() ?? '0').minus(sums._sum.credit?.toString() ?? '0');
    const deposits = open.filter((line) => line.amount.gt(0));
    const payments = open.filter((line) => line.amount.lt(0));
    const outstandingDeposits = deposits.reduce((s, line) => s.plus(line.amount), ZERO);
    const outstandingPayments = payments.reduce((s, line) => s.minus(line.amount), ZERO);
    const adjustedBookBalance = bookBalance.minus(outstandingDeposits).plus(outstandingPayments);
    const statementMovement = lines.reduce((s, line) => s.plus(line.deposit.toString()).minus(line.withdrawal.toString()), ZERO);
    const computedClosing = new Decimal(statement.openingBalance.toString()).plus(statementMovement);
    return {
      bookBalance,
      outstandingDeposits,
      outstandingPayments,
      adjustedBookBalance,
      computedClosing,
      statementDifference: new Decimal(statement.closingBalance.toString()).minus(computedClosing),
      difference: new Decimal(statement.closingBalance.toString()).minus(adjustedBookBalance),
      deposits,
      payments,
    };
  }

  private bookLineView(line: BookLine) {
    return {
      id: line.id.toString(),
      journalEntryId: line.entryId.toString(),
      entryNo: line.entryNo,
      sourceType: line.sourceType,
      entryDate: dateText(line.entryDate),
      description: line.description,
      reference: line.reference,
      amount: money(line.amount),
    };
  }

  private statementView(
    statement: Statement & { bankAccount: { bankName: string; accountNoMasked: string | null } },
  ) {
    return {
      id: statement.id.toString(),
      bankAccountId: statement.bankAccountId.toString(),
      bankName: statement.bankAccount.bankName,
      accountNoMasked: statement.bankAccount.accountNoMasked,
      startDate: dateText(statement.startDate),
      endDate: dateText(statement.endDate),
      openingBalance: money(statement.openingBalance.toString()),
      closingBalance: money(statement.closingBalance.toString()),
      status: statement.status as 'DRAFT' | 'RECONCILED',
      reconciledAt: statement.reconciledAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------- reads

  async list(bankAccountId?: bigint) {
    const { db } = this.context();
    const rows = await db.bankStatement.findMany({
      where: bankAccountId ? { bankAccountId } : {},
      include: { bankAccount: { select: { bankName: true, accountNoMasked: true } }, _count: { select: { lines: true } } },
      orderBy: [{ endDate: 'desc' }, { id: 'desc' }],
    });
    return rows.map((row) => ({ ...this.statementView(row), lineCount: row._count.lines }));
  }

  async detail(id: bigint) {
    const { tenantId, db } = this.context();
    return db.$transaction(async (tx) => {
      const statement = await tx.bankStatement.findFirst({
        where: { tenantId, id },
        include: { bankAccount: { select: { bankName: true, accountNoMasked: true } } },
      });
      if (!statement) throw DomainError.notFound('BankStatement', id.toString());
      const lines = await tx.bankStatementLine.findMany({
        where: { tenantId, statementId: id },
        include: {
          matches: {
            include: { journalLine: { include: { entry: { select: { id: true, entryNo: true, sourceType: true, description: true } } } } },
            orderBy: { id: 'asc' },
          },
        },
        orderBy: { lineNo: 'asc' },
      });
      const references = await this.references(
        tx,
        tenantId,
        lines.flatMap((line) => line.matches.map((match) => match.journalLine.journalEntryId)),
      );
      const summary = await this.summary(tx, tenantId, statement);
      const reconciled = statement.status === 'RECONCILED';
      return {
        ...this.statementView(statement),
        lines: lines.map((line) => ({
          id: line.id.toString(),
          lineNo: line.lineNo,
          lineDate: dateText(line.lineDate),
          description: line.description,
          reference: line.reference,
          deposit: money(line.deposit.toString()),
          withdrawal: money(line.withdrawal.toString()),
          matched: line.matches.length > 0,
          matches: line.matches.map((match) =>
            this.bookLineView({
              id: match.journalLine.id,
              entryId: match.journalLine.entry.id,
              entryNo: match.journalLine.entry.entryNo,
              sourceType: match.journalLine.entry.sourceType,
              entryDate: match.journalLine.entryDate,
              description: match.journalLine.description ?? match.journalLine.entry.description,
              reference: references.get(match.journalLine.journalEntryId) ?? null,
              amount: new Decimal(match.journalLine.debit.toString()).minus(match.journalLine.credit.toString()),
            }),
          ),
        })),
        summary: {
          // A reconciled statement shows the balances it was approved with (ADR-035 §6).
          bookBalance: money(reconciled ? statement.bookBalance!.toString() : summary.bookBalance),
          outstandingDeposits: money(reconciled ? statement.outstandingDeposits!.toString() : summary.outstandingDeposits),
          outstandingPayments: money(reconciled ? statement.outstandingPayments!.toString() : summary.outstandingPayments),
          adjustedBookBalance: money(
            reconciled
              ? new Decimal(statement.bookBalance!.toString())
                  .minus(statement.outstandingDeposits!.toString())
                  .plus(statement.outstandingPayments!.toString())
              : summary.adjustedBookBalance,
          ),
          computedClosingBalance: money(summary.computedClosing),
          statementDifference: money(summary.statementDifference),
          difference: money(reconciled ? ZERO : summary.difference),
          unmatchedLines: lines.filter((line) => line.matches.length === 0).length,
        },
        outstandingDeposits: summary.deposits.map((line) => this.bookLineView(line)),
        outstandingPayments: summary.payments.map((line) => this.bookLineView(line)),
      };
    }, POSTING_TX_OPTIONS);
  }

  /** Uncleared ledger lines a statement line can be matched with. */
  async candidates(id: bigint) {
    const { tenantId, db } = this.context();
    return db.$transaction(async (tx) => {
      const statement = await tx.bankStatement.findFirst({ where: { tenantId, id } });
      if (!statement) throw DomainError.notFound('BankStatement', id.toString());
      const lines = await this.openBookLines(tx, tenantId, statement);
      return lines.map((line) => this.bookLineView(line));
    });
  }

  // ---------------------------------------------------------------- statements

  async create(input: StatementHeaderInput & { bankAccountId: string }) {
    const bankAccountId = BigInt(input.bankAccountId);
    const header = this.parseHeader(input);
    const id = await this.write(async (tx, tenantId) => {
      await this.lockBankAccount(tx, tenantId, bankAccountId);
      const bank = await this.bankAccount(tx, tenantId, bankAccountId);
      if (!bank.isActive) throw new DomainError(ErrorCode.VALIDATION, 'The bank account is inactive', { field: 'bankAccountId' });
      const draft = await tx.bankStatement.findFirst({ where: { tenantId, bankAccountId, status: 'DRAFT' }, select: { id: true } });
      if (draft) {
        throw new DomainError(ErrorCode.BANK_STATEMENT_DRAFT_EXISTS, 'The bank account already has a draft statement', {
          statementId: draft.id.toString(),
        });
      }
      await this.assertSequence(tx, tenantId, bankAccountId, header);
      const statement = await tx.bankStatement.create({
        data: { tenantId, companyId: bank.companyId, bankAccountId, ...header, createdBy: this.support.userId() ?? null },
      });
      await this.audit.log({
        action: 'bank_statement.create',
        entityType: 'bank_statement',
        entityId: statement.id,
        after: { bankAccountId: bankAccountId.toString(), startDate: input.startDate, endDate: input.endDate },
      }, tx);
      return statement.id;
    });
    return this.detail(id);
  }

  async update(id: bigint, input: StatementHeaderInput) {
    const header = this.parseHeader(input);
    await this.write(async (tx, tenantId) => {
      const statement = await this.lockStatement(tx, tenantId, id);
      await this.assertSequence(tx, tenantId, statement.bankAccountId, header, id);
      const outside = await tx.bankStatementLine.count({
        where: { tenantId, statementId: id, OR: [{ lineDate: { lt: header.startDate } }, { lineDate: { gt: header.endDate } }] },
      });
      const matchedAfterEnd = await tx.bankStatementMatch.count({
        where: { tenantId, statementId: id, journalLine: { entryDate: { gt: header.endDate } } },
      });
      if (outside > 0 || matchedAfterEnd > 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'Lines or matches fall outside the new statement dates', {
          field: 'endDate',
        });
      }
      await tx.bankStatement.update({ where: { id }, data: header });
    });
    return this.detail(id);
  }

  async remove(id: bigint) {
    await this.write(async (tx, tenantId) => {
      await this.lockStatement(tx, tenantId, id);
      await tx.bankStatement.delete({ where: { id } });
      await this.audit.log({ action: 'bank_statement.delete', entityType: 'bank_statement', entityId: id }, tx);
    });
    return { deleted: true as const };
  }

  // ---------------------------------------------------------------- lines

  private lineData(statement: Statement, input: StatementLineInput) {
    const lineDate = calendarDate(input.lineDate, 'lineDate');
    if (lineDate < statement.startDate || lineDate > statement.endDate) {
      throw new DomainError(ErrorCode.VALIDATION, 'The line date is outside the statement dates', { field: 'lineDate' });
    }
    const deposit = round3(input.deposit || '0');
    const withdrawal = round3(input.withdrawal || '0');
    if (deposit.gt(0) === withdrawal.gt(0)) {
      throw new DomainError(ErrorCode.VALIDATION, 'A line has either a deposit or a withdrawal', { field: 'deposit' });
    }
    return {
      lineDate,
      description: input.description?.trim() || null,
      reference: input.reference?.trim() || null,
      deposit,
      withdrawal,
    };
  }

  private async insertLines(tx: Tx, tenantId: bigint, statement: Statement, lines: ReturnType<BankReconciliationService['lineData']>[]) {
    const last = await tx.bankStatementLine.aggregate({ where: { tenantId, statementId: statement.id }, _max: { lineNo: true } });
    const start = last._max.lineNo ?? 0;
    await tx.bankStatementLine.createMany({
      data: lines.map((line, index) => ({ tenantId, statementId: statement.id, lineNo: start + index + 1, ...line })),
    });
  }

  async addLine(id: bigint, input: StatementLineInput) {
    await this.write(async (tx, tenantId) => {
      const statement = await this.lockStatement(tx, tenantId, id);
      await this.insertLines(tx, tenantId, statement, [this.lineData(statement, input)]);
    });
    return this.detail(id);
  }

  async removeLine(id: bigint, lineId: bigint) {
    await this.write(async (tx, tenantId) => {
      await this.lockStatement(tx, tenantId, id);
      const { count } = await tx.bankStatementLine.deleteMany({ where: { tenantId, statementId: id, id: lineId } });
      if (count === 0) throw DomainError.notFound('BankStatementLine', lineId.toString());
    });
    return this.detail(id);
  }

  /** Adds every row of an xlsx statement, or none when a row is invalid (ADR-035 §2). */
  async importLines(id: bigint, file: UploadedSheet | undefined) {
    const rows = await readStatementRows(file);
    if (rows.length === 0) throw new DomainError(ErrorCode.VALIDATION, 'The sheet has no statement rows');
    await this.write(async (tx, tenantId) => {
      const statement = await this.lockStatement(tx, tenantId, id);
      const errors: { row: number; reason: string }[] = [];
      const lines: ReturnType<BankReconciliationService['lineData']>[] = [];
      for (const row of rows) {
        const date = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(row.date)
          ? row.date.split('/').reverse().map((part) => part.padStart(2, '0')).join('-')
          : row.date;
        if (!DATE.test(date) || Number.isNaN(toDate(date).getTime()) || dateText(toDate(date)) !== date) {
          errors.push({ row: row.row, reason: 'INVALID_DATE' });
          continue;
        }
        const amounts = [row.deposit, row.withdrawal].map((value) => value.replace(/,/g, ''));
        if (amounts.some((value) => value !== '' && !MONEY.test(value))) {
          errors.push({ row: row.row, reason: 'INVALID_AMOUNT' });
          continue;
        }
        try {
          lines.push(
            this.lineData(statement, {
              lineDate: date,
              description: row.description.slice(0, 500),
              reference: row.reference.slice(0, 100),
              deposit: amounts[0],
              withdrawal: amounts[1],
            }),
          );
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          errors.push({ row: row.row, reason: err.message });
        }
      }
      if (errors.length > 0) {
        throw new DomainError(ErrorCode.VALIDATION, 'The statement sheet has invalid rows', { errors });
      }
      await this.insertLines(tx, tenantId, statement, lines);
      await this.audit.log({
        action: 'bank_statement.import',
        entityType: 'bank_statement',
        entityId: id,
        after: { lines: lines.length },
      }, tx);
    });
    return this.detail(id);
  }

  // ---------------------------------------------------------------- matching

  private async matchLine(tx: Tx, tenantId: bigint, statement: Statement, lineId: bigint, journalLineIds: bigint[]) {
    const line = await tx.bankStatementLine.findFirst({
      where: { tenantId, statementId: statement.id, id: lineId },
      include: { _count: { select: { matches: true } } },
    });
    if (!line) throw DomainError.notFound('BankStatementLine', lineId.toString());
    if (line._count.matches > 0) {
      throw new DomainError(ErrorCode.BANK_LINE_ALREADY_MATCHED, 'The statement line is already matched', {
        statementLineId: lineId.toString(),
      });
    }
    const unique = [...new Set(journalLineIds.map((value) => value.toString()))].map((value) => BigInt(value));
    const open = await this.openBookLines(tx, tenantId, statement, unique);
    if (open.length !== unique.length) {
      const openIds = new Set(open.map((item) => item.id));
      const missing = unique.filter((value) => !openIds.has(value));
      const matched = await tx.bankStatementMatch.count({ where: { tenantId, journalLineId: { in: missing } } });
      if (matched > 0) {
        throw new DomainError(ErrorCode.BANK_LINE_ALREADY_MATCHED, 'A ledger line is already matched', {
          journalLineIds: missing.map((value) => value.toString()),
        });
      }
      throw new DomainError(ErrorCode.VALIDATION, 'A ledger line is not an open line of this bank account', {
        journalLineIds: missing.map((value) => value.toString()),
      });
    }
    const expected = new Decimal(line.deposit.toString()).minus(line.withdrawal.toString());
    const total = open.reduce((s, item) => s.plus(item.amount), ZERO);
    if (!total.equals(expected)) {
      throw new DomainError(ErrorCode.BANK_MATCH_AMOUNT_MISMATCH, 'The ledger lines do not add up to the statement line', {
        expected: money(expected),
        actual: money(total),
      });
    }
    try {
      await tx.bankStatementMatch.createMany({
        data: unique.map((journalLineId) => ({
          tenantId,
          statementId: statement.id,
          statementLineId: lineId,
          journalLineId,
          createdBy: this.support.userId() ?? null,
        })),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DomainError(ErrorCode.BANK_LINE_ALREADY_MATCHED, 'A ledger line is already matched');
      }
      throw err;
    }
  }

  async match(id: bigint, statementLineId: bigint, journalLineIds: bigint[]) {
    await this.write(async (tx, tenantId) => {
      const statement = await this.lockStatement(tx, tenantId, id);
      await this.matchLine(tx, tenantId, statement, statementLineId, journalLineIds);
    });
    return this.detail(id);
  }

  async unmatch(id: bigint, statementLineId: bigint) {
    await this.write(async (tx, tenantId) => {
      await this.lockStatement(tx, tenantId, id);
      await tx.bankStatementMatch.deleteMany({ where: { tenantId, statementId: id, statementLineId } });
    });
    return this.detail(id);
  }

  /**
   * ADR-035 §3: matches a line only when exactly one open ledger line has its amount
   * within ±3 days (or the same reference), and that ledger line suits no other line.
   */
  async autoMatch(id: bigint) {
    const matched = await this.write(async (tx, tenantId) => {
      const statement = await this.lockStatement(tx, tenantId, id);
      const lines = await tx.bankStatementLine.findMany({
        where: { tenantId, statementId: id, matches: { none: {} } },
        orderBy: { lineNo: 'asc' },
      });
      const open = await this.openBookLines(tx, tenantId, statement);
      const fits = new Map<bigint, BookLine[]>();
      const uses = new Map<bigint, number>();
      for (const line of lines) {
        const amount = new Decimal(line.deposit.toString()).minus(line.withdrawal.toString());
        const reference = line.reference?.toLowerCase() ?? null;
        const candidates = open.filter((book) => {
          if (!book.amount.equals(amount)) return false;
          const days = Math.abs(book.entryDate.getTime() - line.lineDate.getTime()) / DAY_MS;
          const sameReference =
            reference !== null &&
            (book.reference?.toLowerCase() === reference || book.entryNo?.toLowerCase() === reference);
          return days <= AUTO_MATCH_DAYS || sameReference;
        });
        fits.set(line.id, candidates);
        for (const book of candidates) uses.set(book.id, (uses.get(book.id) ?? 0) + 1);
      }
      let count = 0;
      for (const line of lines) {
        const candidates = fits.get(line.id) ?? [];
        if (candidates.length !== 1 || uses.get(candidates[0]!.id) !== 1) continue;
        await this.matchLine(tx, tenantId, statement, line.id, [candidates[0]!.id]);
        count += 1;
      }
      return count;
    });
    return { matched, statement: await this.detail(id) };
  }

  // ---------------------------------------------------------------- reconcile

  async reconcile(id: bigint) {
    await this.write(async (tx, tenantId) => {
      const statement = await this.lockStatement(tx, tenantId, id);
      const unmatched = await tx.bankStatementLine.count({ where: { tenantId, statementId: id, matches: { none: {} } } });
      if (unmatched > 0) {
        throw new DomainError(ErrorCode.BANK_STATEMENT_UNMATCHED, 'Every statement line must be matched', { count: unmatched });
      }
      const summary = await this.summary(tx, tenantId, statement);
      if (!summary.statementDifference.isZero()) {
        throw new DomainError(
          ErrorCode.BANK_RECONCILIATION_UNBALANCED,
          'The closing balance differs from the opening balance plus the lines',
          { kind: 'STATEMENT', difference: money(summary.statementDifference) },
        );
      }
      if (!summary.difference.isZero()) {
        throw new DomainError(ErrorCode.BANK_RECONCILIATION_UNBALANCED, 'The adjusted book balance differs from the statement', {
          kind: 'BOOK',
          difference: money(summary.difference),
        });
      }
      await tx.bankStatement.update({
        where: { id },
        data: {
          status: 'RECONCILED',
          bookBalance: round3(summary.bookBalance),
          outstandingDeposits: round3(summary.outstandingDeposits),
          outstandingPayments: round3(summary.outstandingPayments),
          reconciledBy: this.support.userId() ?? null,
          reconciledAt: new Date(),
        },
      });
      await this.audit.log({
        action: 'bank_statement.reconcile',
        entityType: 'bank_statement',
        entityId: id,
        before: { status: 'DRAFT' },
        after: { status: 'RECONCILED', bookBalance: money(summary.bookBalance) },
      }, tx);
    });
    return this.detail(id);
  }

  /** ADR-035 §6: only the bank account's latest statement reopens. */
  async reopen(id: bigint) {
    await this.write(async (tx, tenantId) => {
      const statement = await this.lockStatement(tx, tenantId, id, false);
      if (statement.status !== 'RECONCILED') {
        throw new DomainError(ErrorCode.BANK_STATEMENT_NOT_DRAFT, 'Only a reconciled statement can be reopened');
      }
      const later = await tx.bankStatement.count({
        where: { tenantId, bankAccountId: statement.bankAccountId, endDate: { gt: statement.endDate } },
      });
      if (later > 0) {
        throw new DomainError(ErrorCode.BANK_STATEMENT_NOT_LATEST, 'Only the latest statement of the bank account can be reopened');
      }
      await tx.bankStatement.update({
        where: { id },
        data: {
          status: 'DRAFT',
          bookBalance: null,
          outstandingDeposits: null,
          outstandingPayments: null,
          reconciledBy: null,
          reconciledAt: null,
        },
      });
      await this.audit.log({
        action: 'bank_statement.reopen',
        entityType: 'bank_statement',
        entityId: id,
        before: { status: 'RECONCILED', bookBalance: statement.bookBalance?.toString() ?? null },
        after: { status: 'DRAFT' },
      }, tx);
    });
    return this.detail(id);
  }
}
