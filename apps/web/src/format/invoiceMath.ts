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
 *
 * `pricesIncludeTax` (company setting, ADR-017): the price already includes the
 * tax, so the discounted gross is the line total and the tax is extracted:
 * net = round3(gross / (1 + rate)), tax = gross − net.
 */
export function lineAmounts(line: {
  qty: NumericInput;
  price: NumericInput;
  discountPct?: NumericInput;
  taxRate?: NumericInput;
  pricesIncludeTax?: boolean;
}): LineAmounts {
  const gross = round3(dec(line.qty).times(dec(line.price)));
  const discount = round3(gross.times(dec(line.discountPct)).div(100));
  const afterDiscount = gross.minus(discount);
  if (line.pricesIncludeTax) {
    const net = round3(afterDiscount.div(dec(line.taxRate).div(100).plus(1)));
    return { discount, net, tax: afterDiscount.minus(net), total: afterDiscount };
  }
  const tax = round3(afterDiscount.times(dec(line.taxRate)).div(100));
  return { discount, net: afterDiscount, tax, total: afterDiscount.plus(tax) };
}
