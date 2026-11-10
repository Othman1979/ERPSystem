import { Num } from '../components/Num';
import { formatAmount, formatQty, formatUnitCost, toDecimal, type NumericInput } from './number';

/*
 * Table cell renderers for numeric columns. Pair them with `align: 'end'`
 * (or the .num-cell class in plain tables) so digits line up.
 */

export const amountCell = (v: NumericInput) => <Num>{formatAmount(v)}</Num>;

export const qtyCell = (v: NumericInput) => <Num>{formatQty(v)}</Num>;

export const unitCostCell = (v: NumericInput) => <Num>{formatUnitCost(v)}</Num>;

/** Blank instead of a dash — for debit/credit columns where one side is empty. */
export const amountOrBlankCell = (v: NumericInput) => <Num>{formatAmount(v, '')}</Num>;

/** Blank when zero — for one-sided debit/credit columns (trial balance). */
export const amountOrBlankZeroCell = (v: NumericInput) =>
  toDecimal(v)?.isZero() ? '' : <Num>{formatAmount(v, '')}</Num>;
