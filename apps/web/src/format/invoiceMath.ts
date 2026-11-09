import type Decimal from 'decimal.js';
import { dec, round3, type NumericInput } from './number';

export interface LineAmounts {
  discount: Decimal;
  net: Decimal;
  tax: Decimal;
  total: Decimal;
}

/**
 * Live preview of an invoice line. Mirrors apps/api/src/platform/shared/invoice-math.ts
 * step for step (gross and each component rounded to 3 decimals, half up) so the
 * totals the user sees match what the server stores on posting. The server stays
 * authoritative and recomputes everything.
 */
export function lineAmounts(line: {
  qty: NumericInput;
  price: NumericInput;
  discountPct?: NumericInput;
  taxRate?: NumericInput;
}): LineAmounts {
  const gross = round3(dec(line.qty).times(dec(line.price)));
  const discount = round3(gross.times(dec(line.discountPct)).div(100));
  const net = gross.minus(discount);
  const tax = round3(net.times(dec(line.taxRate)).div(100));
  return { discount, net, tax, total: net.plus(tax) };
}
