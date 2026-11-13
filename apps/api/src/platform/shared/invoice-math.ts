import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';

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
 * base units. `unitPrice` is per selected unit, before discount.
 * Money is rounded to 3 decimals per line (§8.1).
 *
 * `pricesIncludeTax` (company setting, ADR-017): the price already includes
 * the line's tax. The amount after discount is then the line total the user
 * typed, and the tax is extracted from it:
 *   net = round3(gross / (1 + rate)),  tax = gross − net.
 * Otherwise the price is net of tax and tax = round3(net × rate).
 * `gross` and `discountAmount` are in the price's own terms (tax-inclusive
 * when the prices are).
 */
export function computeLineAmounts(opts: {
  qty: Decimal.Value;
  factorToBase: Decimal.Value;
  unitPrice: Decimal.Value;
  discountPct?: Decimal.Value;
  taxRate?: Decimal.Value;
  pricesIncludeTax?: boolean;
}): ComputedLineAmounts {
  const pct = new Decimal(opts.discountPct ?? 0);
  // TRADE-23: a discount above 100% made net and tax negative.
  if (pct.lt(0) || pct.gt(100)) {
    throw new DomainError(ErrorCode.VALIDATION, 'discountPct must be between 0 and 100');
  }
  const rate = new Decimal(opts.taxRate ?? 0);
  const qtyBase = round6(new Decimal(opts.qty).times(opts.factorToBase));
  const gross = round3(new Decimal(opts.qty).times(opts.unitPrice));
  const discountAmount = round3(gross.times(pct).div(100));
  const afterDiscount = gross.minus(discountAmount);
  if (opts.pricesIncludeTax) {
    const netAmount = round3(afterDiscount.div(rate.div(100).plus(1)));
    return {
      qtyBase,
      discountAmount,
      netAmount,
      taxAmount: afterDiscount.minus(netAmount),
      lineTotal: afterDiscount,
    };
  }
  const taxAmount = round3(afterDiscount.times(rate).div(100));
  return {
    qtyBase,
    discountAmount,
    netAmount: afterDiscount,
    taxAmount,
    lineTotal: afterDiscount.plus(taxAmount),
  };
}

/**
 * A tax-inclusive line written net of tax for JoFotara (ADR-017), which wants
 * price × quantity − discount = net amount on every line (0005 §6, §9): the
 * unit price net of tax rounded UP to 3 decimals, and the discount absorbing
 * that rounding, so it is never negative and the line adds up exactly.
 */
export function netOfTaxLine(opts: {
  quantity: Decimal.Value;
  discountAmount: Decimal.Value;
  netAmount: Decimal.Value;
  taxRate: Decimal.Value;
}): { unitPrice: Decimal; discount: Decimal } {
  const divisor = new Decimal(opts.taxRate).div(100).plus(1);
  const quantity = new Decimal(opts.quantity);
  const net = new Decimal(opts.netAmount);
  const discountNet = round3(new Decimal(opts.discountAmount).div(divisor));
  const unitPrice = net.plus(discountNet).div(quantity).toDecimalPlaces(3, Decimal.ROUND_UP);
  const discount = round3(quantity.times(unitPrice)).minus(net);
  return { unitPrice, discount: Decimal.max(discount, 0) };
}
