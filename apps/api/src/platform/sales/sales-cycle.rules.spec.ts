import { Decimal } from '../../common/decimal/decimal.utils.js';
import {
  addDays,
  availableQty,
  defaultValidUntil,
  isQuoteExpired,
  leftToInvoice,
  needsOrderApproval,
  neededPerItem,
  outstandingValue,
  overCreditLimit,
  pricedBelowOrder,
  reservedQty,
  todayUtc,
  unitQtyFloor,
} from './sales-cycle.rules.js';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const dec = (s: string) => new Decimal(s);

describe('Sales quote dates (ADR-027 §2)', () => {
  it('takes the date at midnight UTC', () => {
    expect(todayUtc(new Date('2026-11-15T23:59:59.000Z')).toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('defaults the validity to the quote date plus the company days, or none at 0', () => {
    expect(defaultValidUntil(d('2026-11-15'), 30)?.toISOString().slice(0, 10)).toBe('2026-12-15');
    expect(defaultValidUntil(d('2026-11-15'), 0)).toBeNull();
  });

  it('is expired only once valid_until is before today; the last valid day is still valid', () => {
    expect(isQuoteExpired(d('2026-11-14'), d('2026-11-15'))).toBe(true);
    expect(isQuoteExpired(d('2026-11-15'), d('2026-11-15'))).toBe(false);
    expect(isQuoteExpired(null, d('2026-11-15'))).toBe(false);
  });
});

describe('Sales order approval (ADR-027 §6)', () => {
  it('needs approval for ALWAYS, never for NONE, and on the credit check for OVER_CREDIT_LIMIT', () => {
    expect(needsOrderApproval('ALWAYS', false)).toBe(true);
    expect(needsOrderApproval('NONE', true)).toBe(false);
    expect(needsOrderApproval('OVER_CREDIT_LIMIT', true)).toBe(true);
    expect(needsOrderApproval('OVER_CREDIT_LIMIT', false)).toBe(false);
  });

  it('is over the credit limit only when the exposure is above it, and never without a limit', () => {
    expect(overCreditLimit(dec('1000'), dec('1000.001'))).toBe(true);
    expect(overCreditLimit(dec('1000'), dec('1000'))).toBe(false);
    expect(overCreditLimit(null, dec('999999'))).toBe(false);
  });
});

describe('Outstanding value and reservations (ADR-027 §5, §6)', () => {
  it('values the part not invoiced yet in proportion to the line total', () => {
    // 10 units for 100.000; 4 invoiced: 60% left.
    expect(outstandingValue([{ lineTotal: dec('100'), qtyBase: dec('10'), invoicedQty: dec('4') }]).toFixed(3)).toBe('60.000');
    expect(outstandingValue([{ lineTotal: dec('100'), qtyBase: dec('0'), invoicedQty: dec('0') }]).toFixed(3)).toBe('0.000');
  });

  it('never counts a negative remainder, and sums the lines', () => {
    const lines = [
      { qtyBase: dec('5'), invoicedQty: dec('0') },
      { qtyBase: dec('5'), invoicedQty: dec('7') },
    ];
    expect(reservedQty(lines).toFixed(6)).toBe('5.000000');
  });

  it('available is on hand less reserved; a missing balance row is 0 on hand', () => {
    expect(availableQty(dec('10'), dec('8')).toFixed(6)).toBe('2.000000');
    expect(availableQty(null, dec('0')).toFixed(6)).toBe('0.000000');
  });

  it('adds up the lines of one item before the HARD check', () => {
    const needed = neededPerItem([
      { itemId: BigInt(7), qtyBase: dec('3') },
      { itemId: BigInt(7), qtyBase: dec('2') },
      { itemId: BigInt(8), qtyBase: dec('1') },
    ]);
    expect(needed.get(BigInt(7))?.toFixed(6)).toBe('5.000000');
    expect(needed.get(BigInt(8))?.toFixed(6)).toBe('1.000000');
  });
});

describe('Invoice from order helpers (ADR-027 §4)', () => {
  const order = { unitPrice: '10', discountPct: '0' };

  it('prices below the order on a lower net price', () => {
    expect(pricedBelowOrder({ unitPrice: '9.999', discountPct: '0' }, order)).toBe(true);
  });

  it('prices below the order on a higher discount', () => {
    expect(pricedBelowOrder({ unitPrice: '10', discountPct: '5' }, order)).toBe(true);
    // A higher list price with a bigger discount: net price 9 equals the order's, the discount is higher.
    expect(pricedBelowOrder({ unitPrice: '12', discountPct: '25' }, { unitPrice: '9', discountPct: '0' })).toBe(true);
  });

  it('is not below when the price and discount are equal', () => {
    expect(pricedBelowOrder({ unitPrice: '10', discountPct: '0' }, order)).toBe(false);
  });

  it('allows a higher net price', () => {
    expect(pricedBelowOrder({ unitPrice: '10.5', discountPct: '0' }, order)).toBe(false);
  });

  it('rounds the unit quantity down so it never exceeds the base quantity', () => {
    // 1 base unit in a pack of 12 is 1/12 = 0.0833333..., floored to 0.083333.
    expect(unitQtyFloor(dec('1'), dec('12')).toFixed(6)).toBe('0.083333');
    expect(unitQtyFloor(dec('24'), dec('12')).toFixed(6)).toBe('2.000000');
    expect(unitQtyFloor(dec('2'), dec('3')).toFixed(6)).toBe('0.666666');
  });

  it('never leaves a negative quantity to invoice', () => {
    expect(leftToInvoice(dec('10'), dec('4')).toFixed(6)).toBe('6.000000');
    expect(leftToInvoice(dec('10'), dec('10')).toFixed(6)).toBe('0.000000');
    expect(leftToInvoice(dec('10'), dec('12')).toFixed(6)).toBe('0.000000');
  });

  it('adds whole days', () => {
    expect(addDays(d('2026-11-15'), 30).toISOString().slice(0, 10)).toBe('2026-12-15');
    expect(addDays(d('2026-02-27'), 2).toISOString().slice(0, 10)).toBe('2026-03-01');
    expect(addDays(d('2026-11-15'), 0).toISOString().slice(0, 10)).toBe('2026-11-15');
  });
});
