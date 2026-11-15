import { Decimal } from '../../common/decimal/decimal.utils.js';
import {
  availableQty,
  defaultValidUntil,
  isQuoteExpired,
  needsOrderApproval,
  neededPerItem,
  outstandingValue,
  overCreditLimit,
  reservedQty,
  todayUtc,
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
