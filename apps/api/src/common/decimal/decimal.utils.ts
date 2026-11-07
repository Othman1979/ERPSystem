import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

/** Round to 3 decimal places (documented money precision). */
export function round3(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

/** Round to 6 decimal places (quantity / unit cost precision). */
export function round6(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/** Sum decimals without float drift. */
export function sum(values: Iterable<Decimal.Value>): Decimal {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(v);
  return acc;
}
