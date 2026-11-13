import type { Decimal } from '../../common/decimal/decimal.utils.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { outstandingAmount } from './invoice-balance.js';

/** What a voucher allocation needs to know about an invoice, read under its lock. */
export interface SettlementState {
  partyId: bigint;
  /** The invoice's branch: a branch-restricted user settles only their branches' invoices (ADR-003, TRADE-11). */
  branchId: bigint | null;
  status: 'DRAFT' | 'POSTED';
  paymentType: 'CASH' | 'CREDIT';
  /** grand_total − paid_amount − posted CREDIT returns (§7.8). */
  outstanding: Decimal;
}

/**
 * The invoice side of voucher allocation (ADR-004, module boundary): the
 * treasury module settles invoices only through these methods. Each runs on
 * the caller's transaction, so the locks and the locking reads belong to the
 * allocation that needs them. Implemented by the sales and purchase invoice
 * services, the only code that touches their tables.
 */
export interface InvoiceSettlement {
  /** SELECT … FOR UPDATE on the invoices, in ascending id order (§10.1 fixed lock order), one query. */
  lockForSettlement(tx: Prisma.TransactionClient, ids: bigint[]): Promise<void>;
  /** Locking read of the invoice and its credit returns; null when it does not exist. */
  settlementState(tx: Prisma.TransactionClient, id: bigint): Promise<SettlementState | null>;
  /** paid_amount projection += delta (negative undoes an allocation). The caller holds the lock. */
  addPaid(tx: Prisma.TransactionClient, id: bigint, delta: Decimal): Promise<void>;
  /** The party's posted credit invoices with an outstanding balance, oldest first (auto-allocation). */
  creditInvoiceIdsOldestFirst(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    partyId: bigint,
  ): Promise<bigint[]>;
}

/** Row shape of the locking invoice read in `settlementState`. */
export interface SettlementRow {
  party_id: bigint | number | string;
  branch_id: bigint | number | string | null;
  status: 'DRAFT' | 'POSTED';
  payment_type: 'CASH' | 'CREDIT';
  grand_total: { toString(): string };
  paid_amount: { toString(): string };
}

export function toSettlementState(
  row: SettlementRow,
  credited: { toString(): string } | null | undefined,
): SettlementState {
  return {
    partyId: BigInt(row.party_id),
    branchId: row.branch_id === null ? null : BigInt(row.branch_id),
    status: row.status,
    paymentType: row.payment_type,
    outstanding: outstandingAmount(row.grand_total, row.paid_amount, credited ?? 0),
  };
}

/** Distinct ids in ascending order, for a fixed lock order. */
export function lockOrder(ids: bigint[]): bigint[] {
  return [...new Set(ids)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}
