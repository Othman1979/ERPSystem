import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';

export type ChequeDirection = 'INCOMING' | 'OUTGOING';
export type ChequeStatus = 'IN_HAND' | 'DEPOSITED' | 'COLLECTED' | 'ISSUED' | 'CLEARED' | 'RETURNED' | 'CANCELLED';
export type ChequeAction = 'deposit' | 'collect' | 'clear' | 'return';

/** Statuses a cheque is still open (outstanding) in (ADR-037 §7). */
export const OPEN_STATUSES: Record<ChequeDirection, ChequeStatus[]> = {
  INCOMING: ['IN_HAND', 'DEPOSITED'],
  OUTGOING: ['ISSUED'],
};

/** ADR-037 §2: allowed transitions per direction and action. */
const TRANSITIONS: Record<ChequeDirection, Partial<Record<ChequeAction, { from: ChequeStatus[]; to: ChequeStatus }>>> = {
  INCOMING: {
    deposit: { from: ['IN_HAND'], to: 'DEPOSITED' },
    collect: { from: ['DEPOSITED'], to: 'COLLECTED' },
    return: { from: ['IN_HAND', 'DEPOSITED'], to: 'RETURNED' },
  },
  OUTGOING: {
    clear: { from: ['ISSUED'], to: 'CLEARED' },
    return: { from: ['ISSUED'], to: 'RETURNED' },
  },
};

const dateText = (d: Date) => d.toISOString().slice(0, 10);

function chequeKey(direction: ChequeDirection, chequeNo: string, bankName: string | null, bankAccountId: bigint | null) {
  return direction === 'INCOMING'
    ? `I:${(bankName ?? '').trim().toUpperCase()}:${chequeNo.trim()}`
    : `O:${bankAccountId?.toString() ?? ''}:${chequeNo.trim()}`;
}

function isUniqueViolation(e: unknown, field: string): boolean {
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err?.code !== 'P2002') return false;
  return JSON.stringify(err.meta?.target ?? '').includes(field);
}

const chequeInclude = {
  party: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  bankAccount: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  receipt: { select: { id: true, receiptNo: true, receiptDate: true } },
  payment: { select: { id: true, paymentNo: true, paymentDate: true } },
} as const;

type ChequeRow = Prisma.ChequeGetPayload<{ include: typeof chequeInclude }>;

function present(c: ChequeRow) {
  return {
    id: c.id.toString(),
    direction: c.direction as ChequeDirection,
    status: c.status as ChequeStatus,
    chequeNo: c.chequeNo,
    bankName: c.bankName,
    dueDate: dateText(c.dueDate),
    amount: new Decimal(c.amount.toString()).toFixed(3),
    partyType: c.partyType,
    party: { id: c.party.id.toString(), code: c.party.code, nameAr: c.party.nameAr, nameEn: c.party.nameEn },
    bankAccount: c.bankAccount
      ? { id: c.bankAccount.id.toString(), code: c.bankAccount.code, nameAr: c.bankAccount.nameAr, nameEn: c.bankAccount.nameEn }
      : null,
    voucherNo: c.receipt?.receiptNo ?? c.payment?.paymentNo ?? null,
    voucherDate: c.receipt ? dateText(c.receipt.receiptDate) : c.payment ? dateText(c.payment.paymentDate) : null,
    receiptId: c.receiptId?.toString() ?? null,
    paymentId: c.paymentId?.toString() ?? null,
    branchId: c.branchId?.toString() ?? null,
  };
}

export interface ChequeListFilter {
  direction?: ChequeDirection;
  status?: ChequeStatus;
  /** Only outstanding cheques (ADR-037 §7). */
  open?: boolean;
  dueFrom?: string;
  dueTo?: string;
  partyId?: string;
  q?: string;
}

/**
 * Incoming and outgoing cheques (ADR-037): created by receipts and payments,
 * then moved through deposit / collect / clear / return, each posting through
 * PostingService, with the last step undoable by a reversal entry.
 */
@Injectable()
export class ChequesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------- vouchers

  /** Inside the voucher's transaction: the cheque row and its first event. */
  async createForVoucher(
    tx: Prisma.TransactionClient,
    p: {
      tenantId: bigint;
      companyId: bigint;
      branchId: bigint | null;
      direction: ChequeDirection;
      cheque: { chequeNo: string; bankName?: string; dueDate: string };
      amount: Decimal;
      partyType: 'CUSTOMER' | 'SUPPLIER';
      partyId: bigint;
      receiptId?: bigint;
      paymentId?: bigint;
      bankAccountId?: bigint;
      date: Date;
      userId: bigint | null;
    },
  ) {
    const dueDate = new Date(`${p.cheque.dueDate}T00:00:00.000Z`);
    if (Number.isNaN(dueDate.getTime()) || dateText(dueDate) !== p.cheque.dueDate) {
      throw new DomainError(ErrorCode.VALIDATION, 'cheque.dueDate is not a calendar date', { field: 'cheque.dueDate' });
    }
    const chequeNo = p.cheque.chequeNo.trim();
    const bankName = p.direction === 'INCOMING' ? (p.cheque.bankName ?? '').trim() : null;
    const status: ChequeStatus = p.direction === 'INCOMING' ? 'IN_HAND' : 'ISSUED';
    const key = chequeKey(p.direction, chequeNo, bankName, p.bankAccountId ?? null);
    // The unique index is the race guard; this read names the error for the usual case.
    if (await tx.cheque.findFirst({ where: { companyId: p.companyId, chequeKey: key }, select: { id: true } })) {
      throw new DomainError(ErrorCode.CHEQUE_DUPLICATE, `Cheque ${chequeNo} is already recorded`, { chequeNo });
    }
    let cheque;
    try {
      cheque = await tx.cheque.create({
        data: {
          tenantId: p.tenantId,
          companyId: p.companyId,
          direction: p.direction,
          status,
          chequeNo,
          bankName,
          dueDate,
          amount: p.amount,
          partyType: p.partyType,
          partyId: p.partyId,
          receiptId: p.receiptId ?? null,
          paymentId: p.paymentId ?? null,
          bankAccountId: p.bankAccountId ?? null,
          chequeKey: key,
          branchId: p.branchId,
          createdBy: p.userId,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e, 'cheque_key')) {
        throw new DomainError(ErrorCode.CHEQUE_DUPLICATE, `Cheque ${chequeNo} is already recorded`, { chequeNo });
      }
      throw e;
    }
    await tx.chequeEvent.create({
      data: {
        tenantId: p.tenantId,
        chequeId: cheque.id,
        action: p.direction === 'INCOMING' ? 'RECEIVE' : 'ISSUE',
        fromStatus: null,
        toStatus: status,
        eventDate: p.date,
        bankAccountId: p.bankAccountId ?? null,
        createdBy: p.userId,
      },
    });
    return cheque;
  }

  /** Voucher reversal (ADR-037 §2): a cheque not yet moved is cancelled with it. */
  async cancelForVoucher(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    kind: 'receipt' | 'payment',
    voucherId: bigint,
    date: Date,
    userId: bigint | null,
  ) {
    const rows = (kind === 'receipt'
      ? await tx.$queryRaw`SELECT id FROM cheques WHERE tenant_id = ${tenantId} AND receipt_id = ${voucherId} FOR UPDATE`
      : await tx.$queryRaw`SELECT id FROM cheques WHERE tenant_id = ${tenantId} AND payment_id = ${voucherId} FOR UPDATE`) as {
      id: bigint;
    }[];
    if (!rows[0]) return;
    const cheque = await tx.cheque.findFirst({ where: { id: rows[0].id } });
    if (!cheque) return;
    if (cheque.status !== 'IN_HAND' && cheque.status !== 'ISSUED') {
      throw new DomainError(ErrorCode.CHEQUE_INVALID_STATUS, 'Undo the cheque movements before reversing its voucher', {
        status: cheque.status,
      });
    }
    await tx.cheque.update({ where: { id: cheque.id }, data: { status: 'CANCELLED', chequeKey: null } });
    await tx.chequeEvent.create({
      data: {
        tenantId,
        chequeId: cheque.id,
        action: 'CANCEL',
        fromStatus: cheque.status,
        toStatus: 'CANCELLED',
        eventDate: date,
        createdBy: userId,
      },
    });
  }

  // ----------------------------------------------------------------- reads

  private where(companyId: bigint, f: ChequeListFilter): Prisma.ChequeWhereInput {
    const due: Prisma.DateTimeFilter = {};
    if (f.dueFrom) due.gte = new Date(`${f.dueFrom}T00:00:00.000Z`);
    if (f.dueTo) due.lte = new Date(`${f.dueTo}T00:00:00.000Z`);
    const statuses = f.open
      ? f.direction
        ? OPEN_STATUSES[f.direction]
        : [...OPEN_STATUSES.INCOMING, ...OPEN_STATUSES.OUTGOING]
      : undefined;
    return {
      companyId,
      ...branchWhere(),
      ...(f.direction ? { direction: f.direction } : {}),
      ...(f.status ? { status: f.status } : statuses ? { status: { in: statuses } } : {}),
      ...(f.dueFrom || f.dueTo ? { dueDate: due } : {}),
      ...(f.partyId ? { partyId: BigInt(f.partyId) } : {}),
      ...(f.q ? { chequeNo: { contains: f.q } } : {}),
    };
  }

  /** Cheques by due date (oldest first), with the count and total of the whole filter. */
  async list(f: ChequeListFilter, page = 1, pageSize = 50) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const where = this.where(companyId, f);
    const [rows, agg] = await Promise.all([
      db.cheque.findMany({
        where,
        include: chequeInclude,
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.cheque.aggregate({ where, _count: { _all: true }, _sum: { amount: true } }),
    ]);
    return {
      items: rows.map(present),
      page,
      pageSize,
      total: agg._count._all,
      totalAmount: new Decimal(agg._sum.amount?.toString() ?? '0').toFixed(3),
    };
  }

  /** Outstanding cheques for the report (ADR-037 §7), every row of the filter. */
  async outstanding(f: ChequeListFilter) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const rows = await db.cheque.findMany({
      where: this.where(companyId, { ...f, open: f.status ? undefined : true }),
      include: chequeInclude,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
    const items = rows.map(present);
    const total = (dir: ChequeDirection) =>
      items
        .filter((c) => c.direction === dir)
        .reduce((s, c) => s.plus(c.amount), new Decimal(0))
        .toFixed(3);
    return { filter: f, items, incomingTotal: total('INCOMING'), outgoingTotal: total('OUTGOING') };
  }

  async detail(id: bigint) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const c = await db.cheque.findFirst({
      where: { id, companyId, ...branchWhere() },
      include: {
        ...chequeInclude,
        events: {
          orderBy: { id: 'asc' },
          include: {
            journalEntry: { select: { id: true, entryNo: true } },
            undoEntry: { select: { id: true, entryNo: true } },
          },
        },
      },
    });
    if (!c) throw DomainError.notFound('Cheque', id.toString());
    return {
      ...present(c),
      events: c.events.map((e) => ({
        id: e.id.toString(),
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        eventDate: dateText(e.eventDate),
        bankAccountId: e.bankAccountId?.toString() ?? null,
        journalEntry: e.journalEntry ? { id: e.journalEntry.id.toString(), entryNo: e.journalEntry.entryNo } : null,
        undoEntry: e.undoEntry ? { id: e.undoEntry.id.toString(), entryNo: e.undoEntry.entryNo } : null,
        notes: e.notes,
        undoneAt: e.undoneAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------- movements

  /** Locks the voucher, then the cheque: the order of voucher reversal and allocation. */
  private async lock(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint, id: bigint) {
    const link = await tx.cheque.findFirst({ where: { id, companyId }, select: { receiptId: true, paymentId: true } });
    if (link?.receiptId) {
      await tx.$queryRaw`SELECT id FROM receipts WHERE tenant_id = ${tenantId} AND id = ${link.receiptId} FOR UPDATE`;
    } else if (link?.paymentId) {
      await tx.$queryRaw`SELECT id FROM payments WHERE tenant_id = ${tenantId} AND id = ${link.paymentId} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM cheques WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    const c = await tx.cheque.findFirst({ where: { id, companyId } });
    if (!c) throw DomainError.notFound('Cheque', id.toString());
    assertBranchAllowed(c.branchId);
    return c;
  }

  private async assertBankAccount(tx: Prisma.TransactionClient, companyId: bigint, accountId: bigint) {
    const acc = await tx.account.findFirst({
      where: { companyId, id: accountId, isActive: true, isPostable: true, controlType: 'BANK' },
      select: { id: true },
    });
    if (!acc) throw new DomainError(ErrorCode.VALIDATION, 'bankAccountId must be an active bank account', { field: 'bankAccountId' });
  }

  /** deposit / collect / clear / return (ADR-037 §2), in one locked transaction. */
  async move(id: bigint, action: ChequeAction, dto: { date: string; bankAccountId?: string; notes?: string }) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId() ?? null;
    const date = new Date(`${dto.date}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || dateText(date) !== dto.date) {
      throw new DomainError(ErrorCode.VALIDATION, 'date is not a calendar date', { field: 'date' });
    }

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const c = await this.lock(tx, tenantId, companyId, id);
        const direction = c.direction as ChequeDirection;
        const rule = TRANSITIONS[direction][action];
        if (!rule || !rule.from.includes(c.status as ChequeStatus)) {
          throw new DomainError(ErrorCode.CHEQUE_INVALID_STATUS, `Cannot ${action} a ${direction} cheque in ${c.status}`, {
            status: c.status,
            action,
          });
        }

        let bankAccountId = c.bankAccountId;
        if (action === 'deposit') {
          if (!dto.bankAccountId) {
            throw new DomainError(ErrorCode.VALIDATION, 'bankAccountId is required', { field: 'bankAccountId' });
          }
          bankAccountId = BigInt(dto.bankAccountId);
          await this.assertBankAccount(tx, companyId, bankAccountId);
        }

        if (action === 'return') {
          const agg = c.receiptId
            ? await tx.allocation.aggregate({ where: { receiptId: c.receiptId, cancelledAt: null }, _sum: { amount: true } })
            : await tx.allocation.aggregate({ where: { paymentId: c.paymentId, cancelledAt: null }, _sum: { amount: true } });
          if (new Decimal(agg._sum.amount?.toString() ?? '0').gt(0)) {
            throw new DomainError(
              ErrorCode.VOUCHER_HAS_ALLOCATIONS,
              'Cancel the allocations of the cheque voucher before returning it',
            );
          }
        }

        // The event is the entry's source: a step redone after an undo posts again (one POST per source).
        const event = await tx.chequeEvent.create({
          data: {
            tenantId,
            chequeId: c.id,
            action: action.toUpperCase(),
            fromStatus: c.status,
            toStatus: rule.to,
            eventDate: date,
            bankAccountId,
            notes: dto.notes ?? null,
            createdBy: userId,
          },
        });
        const lines = await this.entryLines(tx, tenantId, companyId, c, action, bankAccountId);
        if (lines) {
          const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, date);
          const entry = await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: date,
            fiscalPeriodId: period.id,
            sourceType: 'CHEQUE_EVENT',
            sourceId: event.id,
            branchId: c.branchId,
            description: `Cheque ${c.chequeNo} ${action}`,
            lines,
            postedBy: userId,
          });
          await tx.chequeEvent.update({ where: { id: event.id }, data: { journalEntryId: entry.id } });
        }

        await tx.cheque.update({ where: { id: c.id }, data: { status: rule.to, bankAccountId } });
        await this.audit.log({ action: `cheque.${action}`, entityType: 'cheque', entityId: c.id, after: { status: rule.to } }, tx);
      }, POSTING_TX_OPTIONS),
    );
    return this.detail(id);
  }

  /** The entry a movement posts, or null (a deposit only records the bank). */
  private async entryLines(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    c: { direction: string; amount: Prisma.Decimal; partyType: 'CUSTOMER' | 'SUPPLIER'; partyId: bigint; chequeNo: string },
    action: ChequeAction,
    bankAccountId: bigint | null,
  ): Promise<JournalLineInput[] | null> {
    if (action === 'deposit') return null;
    const amount = new Decimal(c.amount.toString()).toString();
    const m = await this.support.mappingAccounts(tx, tenantId, companyId, [
      c.direction === 'INCOMING' ? 'CHEQUES_RECEIVABLE' : 'CHEQUES_PAYABLE',
      'CUSTOMERS_CONTROL',
      'SUPPLIERS_CONTROL',
    ]);
    const party = {
      accountId: c.partyType === 'CUSTOMER' ? m.CUSTOMERS_CONTROL! : m.SUPPLIERS_CONTROL!,
      partyType: c.partyType,
      partyId: c.partyId,
    };
    if (c.direction === 'INCOMING') {
      const cheques = m.CHEQUES_RECEIVABLE!;
      if (action === 'collect') {
        return [
          { accountId: bankAccountId!, debit: amount, description: `Cheque ${c.chequeNo}` },
          { accountId: cheques, credit: amount },
        ];
      }
      return [{ ...party, debit: amount }, { accountId: cheques, credit: amount }];
    }
    const cheques = m.CHEQUES_PAYABLE!;
    if (action === 'clear') {
      return [
        { accountId: cheques, debit: amount },
        { accountId: bankAccountId!, credit: amount, description: `Cheque ${c.chequeNo}` },
      ];
    }
    return [{ accountId: cheques, debit: amount }, { ...party, credit: amount }];
  }

  /** ADR-037 §3: undo the latest movement after receipt/issue, reversing its entry. */
  async undo(id: bigint, dto: { date: string }) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId() ?? null;
    const date = new Date(`${dto.date}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || dateText(date) !== dto.date) {
      throw new DomainError(ErrorCode.VALIDATION, 'date is not a calendar date', { field: 'date' });
    }

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const c = await this.lock(tx, tenantId, companyId, id);
        const last = await tx.chequeEvent.findFirst({
          where: { chequeId: c.id, undoneAt: null },
          orderBy: { id: 'desc' },
        });
        if (!last || !['DEPOSIT', 'COLLECT', 'CLEAR', 'RETURN'].includes(last.action) || !last.fromStatus) {
          throw new DomainError(ErrorCode.CHEQUE_INVALID_STATUS, 'The cheque has no movement to undo', { status: c.status });
        }
        let undoEntryId: bigint | null = null;
        if (last.journalEntryId) {
          const reversal = await this.posting.reverseEntry(tx, {
            tenantId,
            companyId,
            entryId: last.journalEntryId,
            reversalDate: date,
            description: `Undo cheque ${c.chequeNo} ${last.action.toLowerCase()}`,
            postedBy: userId,
          });
          undoEntryId = reversal.id;
        }
        // The bank before the undone deposit: the event before it records it (null for a cheque in hand).
        const previous = await tx.chequeEvent.findFirst({
          where: { chequeId: c.id, undoneAt: null, id: { lt: last.id } },
          orderBy: { id: 'desc' },
        });
        await tx.chequeEvent.update({ where: { id: last.id }, data: { undoneAt: new Date(), undoneBy: userId, undoEntryId } });
        await tx.cheque.update({
          where: { id: c.id },
          data: {
            status: last.fromStatus,
            ...(last.action === 'DEPOSIT' ? { bankAccountId: previous?.bankAccountId ?? null } : {}),
          },
        });
        await this.audit.log({ action: 'cheque.undo', entityType: 'cheque', entityId: c.id, after: { status: last.fromStatus } }, tx);
      }, POSTING_TX_OPTIONS),
    );
    return this.detail(id);
  }
}
