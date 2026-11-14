import { Decimal } from '../../common/decimal/decimal.utils.js';

/** A decimal.js value, a Prisma Decimal, or a decimal string. */
type DecimalLike = string | number | { toString(): string };

/**
 * What a customer/supplier still owes on an invoice (§7.8, §18 S10):
 * outstanding = grand_total − paid_amount (voucher allocations)
 *               − posted CREDIT returns against the invoice.
 * Cash refunds don't reduce it: the money went back, the invoice stays as is.
 * Single source for the treasury allocation check and the invoice API.
 */
export function outstandingAmount(
  grandTotal: DecimalLike,
  paidAmount: DecimalLike,
  creditedAmount: DecimalLike,
): Decimal {
  return new Decimal(grandTotal.toString())
    .minus(paidAmount.toString())
    .minus(creditedAmount.toString());
}

/** Sum posted credit-return totals per original invoice id. */
export function creditedByInvoice(
  returns: { originalInvoiceId: bigint; grandTotal: DecimalLike }[],
): Map<string, Decimal> {
  const map = new Map<string, Decimal>();
  for (const r of returns) {
    const key = r.originalInvoiceId.toString();
    map.set(key, (map.get(key) ?? new Decimal(0)).plus(r.grandTotal.toString()));
  }
  return map;
}

/**
 * Adds `creditedAmount` and `outstanding` (decimal strings) to invoice rows.
 * A CASH invoice is settled at sale (paid_amount stays 0), so it owes nothing.
 */
export function withBalance<
  T extends { id: bigint; grandTotal: DecimalLike; paidAmount: DecimalLike; paymentType?: string },
>(invoice: T, credited: Map<string, Decimal>): T & { creditedAmount: string; outstanding: string } {
  const creditedAmount = credited.get(invoice.id.toString()) ?? new Decimal(0);
  const outstanding =
    invoice.paymentType === 'CASH'
      ? new Decimal(0)
      : outstandingAmount(invoice.grandTotal, invoice.paidAmount, creditedAmount);
  return {
    ...invoice,
    creditedAmount: creditedAmount.toFixed(3),
    outstanding: outstanding.toFixed(3),
  };
}

/** A credit invoice that still owes something as of a date (aging, DB-14). */
export interface OpenInvoiceAsOf {
  id: bigint;
  invoiceNo: string | null;
  invoiceDate: Date;
  dueDate: Date | null;
  partyId: bigint;
  /** grand_total − allocations counted as of the date − credit returns dated on or before it. */
  owed: Decimal;
}

/** Row shape of the sales / purchases `openCreditInvoicesAsOf` queries. */
export interface OpenInvoiceRow {
  id: bigint | number;
  invoice_no: string | null;
  invoice_date: Date;
  due_date: Date | null;
  party_id: bigint | number;
  grand_total: DecimalLike;
  paid_amount: DecimalLike;
  credited: DecimalLike;
}

/**
 * What each row still owes as of the date: paid_amount counts every active
 * allocation, so the allocations not counted then (`allocationShift`, from
 * treasury) are added back. Rows that owe nothing are dropped.
 */
export function owedAsOf(rows: OpenInvoiceRow[], allocationShift: Map<bigint, Decimal>): OpenInvoiceAsOf[] {
  const open: OpenInvoiceAsOf[] = [];
  for (const r of rows) {
    const id = BigInt(r.id);
    const allocated = new Decimal(r.paid_amount.toString()).minus(allocationShift.get(id) ?? 0);
    const owed = outstandingAmount(r.grand_total, allocated, r.credited);
    if (owed.lte(0)) continue;
    open.push({
      id,
      invoiceNo: r.invoice_no,
      invoiceDate: r.invoice_date,
      dueDate: r.due_date,
      partyId: BigInt(r.party_id),
      owed,
    });
  }
  return open;
}

/** Ids per `IN (…)` list: far below MariaDB's 65,535 placeholders per prepared statement. */
export const IN_LIST_CHUNK = 5_000;

/** Splits a list into consecutive chunks of at most `size` items. */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
