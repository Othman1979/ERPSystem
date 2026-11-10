import type Decimal from 'decimal.js';
import { round3, sum, type NumericInput } from '../../format/number';

export interface OpeningPlug {
  totalDebit: Decimal;
  totalCredit: Decimal;
  /** Side the OPENING_BALANCE_EQUITY line takes; null when the lines balance. */
  side: 'DEBIT' | 'CREDIT' | null;
  amount: Decimal;
}

/**
 * Preview of the line the server adds to the opening entry (§8.6): more
 * debit than credit is credited to OPENING_BALANCE_EQUITY, and the reverse.
 * Display only — the server recomputes it.
 */
export function openingPlug(lines: { debit?: NumericInput; credit?: NumericInput }[]): OpeningPlug {
  const totalDebit = round3(sum(lines.map((l) => l.debit)));
  const totalCredit = round3(sum(lines.map((l) => l.credit)));
  const diff = totalDebit.minus(totalCredit);
  return {
    totalDebit,
    totalCredit,
    side: diff.isZero() ? null : diff.gt(0) ? 'CREDIT' : 'DEBIT',
    amount: diff.abs(),
  };
}
