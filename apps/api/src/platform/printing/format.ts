import { Decimal } from '../../common/decimal/decimal.utils.js';

/** "1234567.5" → "1,234,567.500" (§16: three decimals, thousands separators). No float math. */
export function formatAmount(value: Decimal.Value | null | undefined, decimals = 3): string {
  if (value === null || value === undefined || value === '') return '';
  const fixed = new Decimal(value).toFixed(decimals);
  const negative = fixed.startsWith('-');
  const [int, frac] = (negative ? fixed.slice(1) : fixed).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = frac ? `${grouped}.${frac}` : grouped;
  return negative && !new Decimal(fixed).isZero() ? `-${out}` : out;
}

/** Quantities: up to 6 decimals, trailing zeros dropped. */
export function formatQty(value: Decimal.Value | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const s = new Decimal(value).toDecimalPlaces(6).toFixed();
  const [int, frac] = s.replace('-', '').split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${s.startsWith('-') ? '-' : ''}${frac ? `${grouped}.${frac}` : grouped}`;
}

/**
 * Excel cells need JS numbers (ADR-006 exception to "no Number() on
 * money"). Converted only when the number reads back exactly as the
 * decimal it came from; anything else stays text, so a cell is never
 * silently rounded.
 */
export function toExcelNumber(value: Decimal.Value | null | undefined): number | string | null {
  if (value === null || value === undefined || value === '') return null;
  const exact = new Decimal(value);
  const n = exact.toNumber();
  return Number.isFinite(n) && new Decimal(n).eq(exact) ? n : exact.toFixed();
}
