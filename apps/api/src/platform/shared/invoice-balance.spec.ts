import { Decimal } from '../../common/decimal/decimal.utils.js';
import { creditedByInvoice, outstandingAmount, withBalance } from './invoice-balance.js';

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
    const row = withBalance({ id: 9n, grandTotal: '31.320', paidAmount: '0', paymentType: 'CASH' }, new Map());
    expect(row.outstanding).toBe('0.000');
  });
});
