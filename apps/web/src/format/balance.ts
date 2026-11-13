import Decimal from 'decimal.js';
import { dec, formatAmount, type NumericInput } from './number';

/**
 * How account balances are shown (owner decision, review 2026-11-13 §Design):
 *  - Trial balance and statements: separate Dr and Cr columns (drCrColumns).
 *  - Elsewhere: the amount without a sign, plus a «دائن» / "Cr" suffix for a
 *    credit balance (balanceView + <Balance>).
 *  - Red only when the balance sits on the wrong side of the account's
 *    normal balance (e.g. a cash account in credit), never merely because
 *    the balance is a credit.
 */

export type NormalBalance = 'DEBIT' | 'CREDIT';

export interface BalanceView {
  /** Absolute amount, formatted ("520.000"). */
  amount: string;
  /** Side the balance is on; null for a zero balance. */
  side: 'DR' | 'CR' | null;
  /** True when the balance is on the opposite side of the account's normal balance. */
  wrongSide: boolean;
}

/** Net balance as debit − credit (positive = debit balance). */
export function netBalance(debit: NumericInput, credit: NumericInput): Decimal {
  return dec(debit).minus(dec(credit));
}

/**
 * View of a net balance (debit − credit). Rounded to 3 decimals before the
 * side is decided, so a residue like -0.0004 reads as a zero balance.
 */
export function balanceView(net: NumericInput, normalBalance?: NormalBalance): BalanceView {
  const rounded = dec(net).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  const side = rounded.isZero() ? null : rounded.isPositive() ? 'DR' : 'CR';
  const wrongSide =
    side !== null && normalBalance !== undefined && side !== (normalBalance === 'DEBIT' ? 'DR' : 'CR');
  return { amount: formatAmount(rounded.abs()), side, wrongSide };
}

/**
 * Splits a net balance (debit − credit) into the Dr and Cr columns of a
 * trial balance or statement: one side carries the amount, the other is null.
 */
export function drCrColumns(net: NumericInput): { debit: Decimal | null; credit: Decimal | null } {
  const rounded = dec(net).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
  if (rounded.isZero()) return { debit: null, credit: null };
  return rounded.isPositive()
    ? { debit: rounded, credit: null }
    : { debit: null, credit: rounded.abs() };
}
