import { describe, expect, it } from 'vitest';
import {
  orderInvoiceBody,
  orderInvoiceGaps,
  salesApprovalHint,
  salesOrderBody,
  type OrderInvoiceForm,
  type SalesOrderForm,
} from './orderPayload';

const form: SalesOrderForm = {
  orderDate: '2026-11-15',
  expectedDate: ' ',
  customerId: '5',
  warehouseId: '3',
  paymentTermsDays: 30,
  description: '  deliver before noon  ',
  lines: [{ itemId: 'i1', qty: '10', unitPrice: '4.000', discountPct: '' }],
};

describe('sales order body', () => {
  it('sends the header and the lines, and omits a blank expected date', () => {
    expect(salesOrderBody(form)).toEqual({
      orderDate: '2026-11-15',
      customerId: '5',
      warehouseId: '3',
      paymentTermsDays: 30,
      description: 'deliver before noon',
      lines: [{ itemId: 'i1', qty: '10', unitPrice: '4.000' }],
    });
  });

  it('keeps payment terms of zero days, which are a value', () => {
    expect(salesOrderBody({ ...form, paymentTermsDays: 0 })).toMatchObject({ paymentTermsDays: 0 });
  });
});

const credit: OrderInvoiceForm = { invoiceDate: '2026-11-16', dueDate: '2026-12-16', paymentType: 'CREDIT' };

describe('order invoice body (ADR-027 §4)', () => {
  it('sends the dates and the payment type of a credit invoice, with no account', () => {
    expect(orderInvoiceBody({ ...credit, cashAccountId: '77' })).toEqual({
      invoiceDate: '2026-11-16',
      paymentType: 'CREDIT',
      dueDate: '2026-12-16',
    });
  });

  it('sends the cash account of a cash invoice, and leaves the due date out when blank', () => {
    expect(orderInvoiceBody({ invoiceDate: '2026-11-16', paymentType: 'CASH', cashAccountId: '77' })).toEqual({
      invoiceDate: '2026-11-16',
      paymentType: 'CASH',
      cashAccountId: '77',
    });
  });

  it('needs an account for a cash invoice and none for a credit one', () => {
    expect(orderInvoiceGaps({ invoiceDate: '2026-11-16', paymentType: 'CASH' })).toEqual({ cashAccount: true });
    expect(orderInvoiceGaps(credit)).toEqual({ cashAccount: false });
  });
});

describe('sales approval hint (ADR-027 §6)', () => {
  it('lets the owner approve any order, and a member approve another member’s', () => {
    expect(salesApprovalHint({ isOwner: true, canApprove: false, authoredByMe: true })).toBe('ok');
    expect(salesApprovalHint({ isOwner: false, canApprove: true, authoredByMe: false })).toBe('ok');
  });

  it('refuses a member without sales.approve, and one who wrote the order', () => {
    expect(salesApprovalHint({ isOwner: false, canApprove: false, authoredByMe: false })).toBe('noApproval');
    expect(salesApprovalHint({ isOwner: false, canApprove: true, authoredByMe: true })).toBe('ownDocument');
  });
});
