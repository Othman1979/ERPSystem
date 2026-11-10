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
