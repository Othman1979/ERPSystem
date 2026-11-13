import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';

type DecimalLike = { toString(): string };

/** The invoice line a return line refers to (sales or purchase). */
export interface ReturnableLine {
  id: bigint;
  lineNo: number;
  itemId: bigint;
  /** In the line's own unit. */
  qty: DecimalLike;
  qtyBase: DecimalLike;
  discountAmount: DecimalLike;
  netAmount: DecimalLike;
  taxAmount: DecimalLike;
}

/** What earlier returns already took from one invoice line. */
export interface ReturnedSoFar {
  qtyBase: Decimal;
  discountAmount: Decimal;
  netAmount: Decimal;
  taxAmount: Decimal;
}

export interface ComputedReturnLine<L extends ReturnableLine> {
  orig: L;
  /** In the original line's unit, so qty × the line's price reads right (TRADE-13). */
  qty: Decimal;
  qtyBase: Decimal;
  discountAmount: Decimal;
  netAmount: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
}

/** Adds up return lines per original line id. */
export function returnedByLine(
  rows: { originalLineId: bigint; qtyBase: DecimalLike; discountAmount: DecimalLike; netAmount: DecimalLike; taxAmount: DecimalLike }[],
): Map<bigint, ReturnedSoFar> {
  const map = new Map<bigint, ReturnedSoFar>();
  for (const r of rows) {
    const cur = map.get(r.originalLineId) ?? {
      qtyBase: new Decimal(0),
      discountAmount: new Decimal(0),
      netAmount: new Decimal(0),
      taxAmount: new Decimal(0),
    };
    map.set(r.originalLineId, {
      qtyBase: cur.qtyBase.plus(r.qtyBase.toString()),
      discountAmount: cur.discountAmount.plus(r.discountAmount.toString()),
      netAmount: cur.netAmount.plus(r.netAmount.toString()),
      taxAmount: cur.taxAmount.plus(r.taxAmount.toString()),
    });
  }
  return map;
}

/**
 * Return lines against an invoice's lines (§7.7; TRADE-01, -13, -22),
 * shared by sales and purchase returns:
 *  - each original line at most once per return, qty (base units) > 0 and
 *    not above what earlier returns left;
 *  - amounts pro rata to the base quantity, rounded per line — except the
 *    return that takes the rest of a line, which takes the rest of its
 *    amounts, so three returns of 1 from 3 add up to the line exactly;
 *  - qty stored in the original line's unit.
 * `already` must be read under the invoice's lock (see the callers).
 */
export function computeReturnLines<L extends ReturnableLine>(
  originals: L[],
  requested: { originalLineId: string; qty: string }[],
  already: Map<bigint, ReturnedSoFar>,
): ComputedReturnLine<L>[] {
  const byId = new Map(originals.map((l) => [l.id, l]));
  const seen = new Set<bigint>();
  return requested.map((r, i) => {
    const orig = byId.get(BigInt(r.originalLineId));
    if (!orig) {
      throw new DomainError(ErrorCode.VALIDATION, `Line ${i + 1}: originalLineId not on this invoice`);
    }
    // The remaining-qty check only counts earlier returns, so a repeated line would slip past it.
    if (seen.has(orig.id)) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        `Line ${i + 1}: invoice line ${orig.lineNo} appears more than once in this return`,
      );
    }
    seen.add(orig.id);
    const qtyBase = new Decimal(r.qty);
    if (qtyBase.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Return qty must be > 0');
    const origQtyBase = new Decimal(orig.qtyBase.toString());
    const prior = already.get(orig.id);
    const remaining = origQtyBase.minus(prior?.qtyBase ?? 0);
    if (qtyBase.gt(remaining)) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        `Return qty exceeds remaining qty for line ${orig.lineNo} (remaining ${remaining.toString()})`,
      );
    }
    let discountAmount: Decimal;
    let netAmount: Decimal;
    let taxAmount: Decimal;
    if (qtyBase.eq(remaining)) {
      discountAmount = new Decimal(orig.discountAmount.toString()).minus(prior?.discountAmount ?? 0);
      netAmount = new Decimal(orig.netAmount.toString()).minus(prior?.netAmount ?? 0);
      taxAmount = new Decimal(orig.taxAmount.toString()).minus(prior?.taxAmount ?? 0);
    } else {
      const ratio = qtyBase.div(origQtyBase);
      discountAmount = round3(new Decimal(orig.discountAmount.toString()).times(ratio));
      netAmount = round3(new Decimal(orig.netAmount.toString()).times(ratio));
      taxAmount = round3(new Decimal(orig.taxAmount.toString()).times(ratio));
    }
    return {
      orig,
      qty: round6(qtyBase.times(orig.qty.toString()).div(origQtyBase)),
      qtyBase,
      discountAmount,
      netAmount,
      taxAmount,
      lineTotal: netAmount.plus(taxAmount),
    };
  });
}
