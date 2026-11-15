import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';

/**
 * ADR-026 §7: the part of a received value that `through` of `total` units
 * stand for, cumulatively: round3(value × through / total), and exactly the
 * value once everything is taken (through = total).
 *
 * Billing (and returning) in steps takes the difference between two
 * consecutive results, so each step lies between 0 and what is left (round3
 * is monotonic) and the steps add up to the value exactly. Rounding each step
 * on its own (round3(value × qty / total), half up) could overshoot: 6 units
 * worth 0.009 billed one at a time would clear 0.002 five times, more than
 * the value, and leave a negative rest.
 */
export function clearedThrough(value: Decimal.Value, through: Decimal.Value, total: Decimal.Value): Decimal {
  const v = new Decimal(value);
  const t = new Decimal(through);
  const n = new Decimal(total);
  if (t.gte(n)) return v;
  if (t.lte(0)) return new Decimal(0);
  return round3(v.times(t).div(n));
}
