import { Decimal, round3, sum } from '../../common/decimal/decimal.utils.js';
import type { SalesOrderApproval } from '../../generated/prisma/enums.js';

/**
 * Pure rules of the sales quotes and orders (ADR-027). No database, no clock:
 * the callers pass the dates and the figures they read under their locks.
 */

const DAY_MS = 86_400_000;

/** Midnight UTC of the day `now` falls on (dates are stored as @db.Date). */
export function todayUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The default validity of a new quote: `days` after its date; null when `days` is 0 (ADR-027 §1). */
export function defaultValidUntil(quoteDate: Date, days: number): Date | null {
  if (days <= 0) return null;
  return new Date(quoteDate.getTime() + days * DAY_MS);
}

/**
 * A quote past its validity (ADR-027 §2): valid_until is before today. Only the
 * acceptance of a SENT quote is refused; converting an ACCEPTED quote is not
 * (see SalesOrdersService.fromQuote).
 */
export function isQuoteExpired(validUntil: Date | null, today: Date): boolean {
  return validUntil !== null && validUntil.getTime() < today.getTime();
}

/** Whether a confirmation needs approval (ADR-027 §6): ALWAYS, or OVER_CREDIT_LIMIT when over the limit. */
export function needsOrderApproval(mode: SalesOrderApproval, overCreditLimit: boolean): boolean {
  if (mode === 'ALWAYS') return true;
  if (mode === 'NONE') return false;
  return overCreditLimit;
}

/** True when the exposure (receivable plus open orders plus this order) is above the customer's credit limit. */
export function overCreditLimit(limit: Decimal | null, exposure: Decimal): boolean {
  return limit !== null && exposure.gt(limit);
}

/**
 * The value an order still expects to bill: each line's total in proportion
 * to the base quantity not invoiced yet (ADR-027 §6 «باقي أوامره المؤكدة»).
 */
export function outstandingValue(lines: { lineTotal: Decimal; qtyBase: Decimal; invoicedQty: Decimal }[]): Decimal {
  return sum(
    lines.map((l) => {
      if (l.qtyBase.lte(0)) return new Decimal(0);
      const left = Decimal.max(new Decimal(0), l.qtyBase.minus(l.invoicedQty));
      return round3(l.lineTotal.times(left).div(l.qtyBase));
    }),
  );
}

/** Reserved quantity of order lines (base units): what is not invoiced yet (ADR-027 §5). */
export function reservedQty(lines: { qtyBase: Decimal; invoicedQty: Decimal }[]): Decimal {
  return sum(lines.map((l) => Decimal.max(new Decimal(0), l.qtyBase.minus(l.invoicedQty))));
}

/** Available = on hand less reserved; a missing balance row is 0 on hand (ADR-027 §5). */
export function availableQty(onHand: Decimal | null, reserved: Decimal): Decimal {
  return (onHand ?? new Decimal(0)).minus(reserved);
}

/**
 * Sums the stock quantities per item, for the HARD check of one order: an
 * item named on two lines needs both quantities together.
 */
export function neededPerItem(lines: { itemId: bigint; qtyBase: Decimal }[]): Map<bigint, Decimal> {
  const out = new Map<bigint, Decimal>();
  for (const l of lines) out.set(l.itemId, (out.get(l.itemId) ?? new Decimal(0)).plus(l.qtyBase));
  return out;
}

/** Milliseconds in a day, for the due dates of an order's payment terms. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** What an order line still allows to invoice, in base units (ADR-027 §4), never negative. */
export function leftToInvoice(qtyBase: Decimal, invoicedQty: Decimal): Decimal {
  return Decimal.max(new Decimal(0), new Decimal(qtyBase).minus(invoicedQty));
}

/** The quantity in a line's own unit that is `baseQty` base units, rounded DOWN to 6 places so it never exceeds it. */
export function unitQtyFloor(baseQty: Decimal, factorToBase: Decimal): Decimal {
  return new Decimal(baseQty).div(factorToBase).toDecimalPlaces(6, Decimal.ROUND_DOWN);
}

/** A line's net unit price after its discount, exact (ADR-027 §4 compares net prices). */
export function netUnitPrice(unitPrice: Decimal.Value, discountPct: Decimal.Value): Decimal {
  return new Decimal(unitPrice).times(new Decimal(100).minus(discountPct)).div(100);
}

/**
 * ADR-027 §4 (price lock): an invoice line is priced below its order line when its
 * net unit price is lower, or its discount is higher. A higher price is always allowed.
 */
export function pricedBelowOrder(
  line: { unitPrice: Decimal.Value; discountPct: Decimal.Value },
  order: { unitPrice: Decimal.Value; discountPct: Decimal.Value },
): boolean {
  return netUnitPrice(line.unitPrice, line.discountPct).lt(netUnitPrice(order.unitPrice, order.discountPct)) ||
    new Decimal(line.discountPct).gt(new Decimal(order.discountPct));
}
