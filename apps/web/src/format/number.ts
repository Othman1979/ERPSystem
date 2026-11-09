import Decimal from 'decimal.js';

/**
 * Display formatting for money and quantities (BUILD_PLAN §16):
 * Western digits, thousands separators, 3 decimals for the dinar.
 * All maths goes through decimal.js — never JS floats — and rounding is
 * ROUND_HALF_UP, matching the API's round3/round6.
 */

export type NumericInput = Decimal.Value | null | undefined;

const EMPTY = '—';

/** Parses an API string (or a user-typed number) into a Decimal; null if blank or invalid. */
export function toDecimal(v: NumericInput): Decimal | null {
  if (v == null || v === '') return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Same as toDecimal but treats blank as zero (for sums and line maths). */
export function dec(v: NumericInput): Decimal {
  return toDecimal(v) ?? new Decimal(0);
}

export const round3 = (d: Decimal) => d.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
export const round6 = (d: Decimal) => d.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);

export function sum(values: NumericInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

/** Inserts thousands separators into a plain decimal string like "-12345.600". */
function group(fixed: string): string {
  const negative = fixed.startsWith('-');
  const body = negative ? fixed.slice(1) : fixed;
  const [int, frac] = body.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`;
}

/** Formats with between `min` and `max` decimals (trailing zeros past `min` trimmed). */
function format(v: NumericInput, min: number, max: number, empty: string): string {
  const d = toDecimal(v);
  if (!d) return empty;
  let fixed = d.toFixed(max, Decimal.ROUND_HALF_UP);
  if (max > min) {
    const [int, frac = ''] = fixed.split('.');
    const kept = frac.slice(0, min) + frac.slice(min).replace(/0+$/, '');
    fixed = kept ? `${int}.${kept}` : int;
  }
  // "-0.000" after rounding reads as a bug in a report; show zero unsigned.
  if (/^-0(\.0*)?$/.test(fixed)) fixed = fixed.slice(1);
  return group(fixed);
}

/** Money: always 3 decimals — "1,234.500". */
export const formatAmount = (v: NumericInput, empty = EMPTY) => format(v, 3, 3, empty);

/** Quantity: up to 6 decimals, trailing zeros trimmed — "134", "1.5", "0.0005". */
export const formatQty = (v: NumericInput, empty = EMPTY) => format(v, 0, 6, empty);

/** Unit cost: at least 3, up to 6 decimals — "2.100", "0.123456". */
export const formatUnitCost = (v: NumericInput, empty = EMPTY) => format(v, 3, 6, empty);

/** Percentage value (no % sign): up to 3 decimals — "16", "7.5". */
export const formatPercent = (v: NumericInput, empty = EMPTY) => format(v, 0, 3, empty);
