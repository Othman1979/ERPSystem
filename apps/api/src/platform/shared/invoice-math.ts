import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';

export interface ComputedLineAmounts {
  qtyBase: Decimal;
  discountAmount: Decimal;
  netAmount: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
}

/**
 * Computes qty_base / discount / net / tax / line total for an invoice line.
 * `qty` is in the selected sale/purchase unit; `factorToBase` converts it to
 * base units. `unitPrice` is per selected unit, before discount and tax.
 * Money is rounded to 3 decimals per line (§8.1).
 */
export function computeLineAmounts(opts: {
  qty: Decimal.Value;
  factorToBase: Decimal.Value;
  unitPrice: Decimal.Value;
  discountPct?: Decimal.Value;
  taxRate?: Decimal.Value;
}): ComputedLineAmounts {
  const qtyBase = round6(new Decimal(opts.qty).times(opts.factorToBase));
  const gross = round3(new Decimal(opts.qty).times(opts.unitPrice));
  const discountAmount = round3(gross.times(opts.discountPct ?? 0).div(100));
  const netAmount = gross.minus(discountAmount);
  const taxAmount = round3(netAmount.times(opts.taxRate ?? 0).div(100));
  return {
    qtyBase,
    discountAmount,
    netAmount,
    taxAmount,
    lineTotal: netAmount.plus(taxAmount),
  };
}
