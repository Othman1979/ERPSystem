import { Decimal } from '../../common/decimal/decimal.utils.js';
import { salesInvoicePrint } from './sales.print.js';

describe('sales invoice print totals', () => {
  it('shows an invoice-level discount separately from the line discount', () => {
    const print = salesInvoicePrint({
      invoiceNo: 'SI-2025-000001',
      invoiceDate: new Date('2025-01-01T00:00:00.000Z'),
      dueDate: null,
      status: 'POSTED',
      paymentType: 'CREDIT',
      netTotal: new Decimal('9.000'),
      taxTotal: new Decimal('1.440'),
      grandTotal: new Decimal('10.440'),
      invoiceDiscountAmount: new Decimal('1.000'),
      customer: null,
      warehouse: null,
      description: null,
      lines: [{
        lineNo: 1,
        qty: new Decimal(1),
        unitPrice: new Decimal('10.000'),
        discountAmount: new Decimal('1.000'),
        invoiceDiscountShare: new Decimal('1.000'),
        taxAmount: new Decimal('1.440'),
        lineTotal: new Decimal('10.440'),
        item: null,
      }],
    }, 'en');

    expect(print.lines?.rows[0].discount).toBe('0');
    expect(print.totals).toContainEqual({ label: 'Invoice discount', value: '1.000' });
  });
});
