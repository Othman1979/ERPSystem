import { Decimal } from '../../common/decimal/decimal.utils.js';
import {
  chunks,
  creditedByInvoice,
  IN_LIST_CHUNK,
  outstandingAmount,
  owedAsOf,
  withBalance,
} from './invoice-balance.js';

describe('invoice balance', () => {
  it('outstanding = grand − paid − credited (§18 S10)', () => {
    expect(outstandingAmount('37.120', '0', '9.280').toFixed(3)).toBe('27.840');
    expect(outstandingAmount('37.120', '20', '9.280').toFixed(3)).toBe('7.840');
  });

  it('sums credit returns per original invoice', () => {
    const map = creditedByInvoice([
      { originalInvoiceId: 1n, grandTotal: new Decimal('9.280') },
      { originalInvoiceId: 1n, grandTotal: '1.000' },
      { originalInvoiceId: 2n, grandTotal: '5' },
    ]);
    expect(map.get('1')?.toFixed(3)).toBe('10.280');
    expect(map.get('2')?.toFixed(3)).toBe('5.000');
  });

  it('decorates an invoice row with credited and outstanding strings', () => {
    const row = withBalance(
      { id: 7n, grandTotal: '37.120', paidAmount: '0' },
      new Map([['7', new Decimal('9.28')]]),
    );
    expect(row.creditedAmount).toBe('9.280');
    expect(row.outstanding).toBe('27.840');
    const none = withBalance({ id: 8n, grandTotal: '10', paidAmount: '10' }, new Map());
    expect(none.creditedAmount).toBe('0.000');
    expect(none.outstanding).toBe('0.000');
  });
});

describe('withBalance — cash invoices', () => {
  it('a CASH invoice owes nothing even though paid_amount stays 0', () => {
    const row = withBalance(
      { id: 9n, grandTotal: '31.320', paidAmount: '0', paymentType: 'CASH' },
      new Map(),
    );
    expect(row.outstanding).toBe('0.000');
  });
});

describe('owedAsOf (DB-14)', () => {
  const row = (id: number, grand: string, paid: string, credited: string) => ({
    id: BigInt(id),
    invoice_no: `SI-${id}`,
    invoice_date: new Date('2025-03-01'),
    due_date: null,
    party_id: 7n,
    grand_total: grand,
    paid_amount: paid,
    credited,
  });

  it('adds back allocations not yet counted and drops what owes nothing', () => {
    const shift = new Map([
      [2n, new Decimal('4.000')], // paid 4.000 by a voucher dated after the date
      [3n, new Decimal('-1.000')], // a cancellation that still counts then
    ]);
    const open = owedAsOf(
      [
        row(1, '10.000', '0', '0'),
        row(2, '10.000', '10.000', '0'),
        row(3, '10.000', '9.000', '0'),
        row(4, '10.000', '6.000', '4.000'),
      ],
      shift,
    );
    expect(open.map((o) => [o.id, o.owed.toFixed(3)])).toEqual([
      [1n, '10.000'],
      [2n, '4.000'],
    ]);
  });
});

describe('chunks', () => {
  it('splits into consecutive slices of at most the size', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
  });

  it('keeps an IN list far below the 65,535 placeholders of a prepared statement', () => {
    const ids = Array.from({ length: 70_000 }, (_, i) => i);
    const parts = chunks(ids, IN_LIST_CHUNK);
    expect(parts.every((p) => p.length <= IN_LIST_CHUNK)).toBe(true);
    expect(parts.flat()).toEqual(ids);
    expect(IN_LIST_CHUNK).toBeLessThan(65_535);
  });
});
