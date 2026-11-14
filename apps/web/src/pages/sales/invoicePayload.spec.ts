import { describe, expect, it } from 'vitest';
import type { SalesInvoiceDetailDto } from '@erp/api-client';
import { salesInvoiceBody, salesInvoiceFormDefaults, type SalesInvoiceForm } from './invoicePayload';

const savedInvoice = {
  id: '61',
  description: 'Delivered on site',
  paymentType: 'CASH',
  cashAccountId: '88',
} as unknown as SalesInvoiceDetailDto;

const form: SalesInvoiceForm = {
  invoiceDate: '2025-01-09',
  customerId: '5',
  warehouseId: '3',
  paymentType: 'CASH',
  cashAccountId: '88',
  lines: [{ itemId: 'i1', qty: '2', price: '12.500', discountPct: null }],
};

describe('sales invoice defaults', () => {
  it('starts a new invoice as CREDIT with no cash account', () => {
    expect(salesInvoiceFormDefaults(undefined)).toEqual({ paymentType: 'CREDIT', cashAccountId: undefined });
  });

  it('carries the cash account of a saved CASH invoice', () => {
    expect(salesInvoiceFormDefaults(savedInvoice)).toEqual({ paymentType: 'CASH', cashAccountId: '88' });
  });
});

describe('sales invoice body', () => {
  it('sends the cash account of an edited CASH invoice, from its defaults', () => {
    const defaults = salesInvoiceFormDefaults(savedInvoice);
    const body = salesInvoiceBody({ ...form, paymentType: defaults.paymentType, cashAccountId: defaults.cashAccountId }, savedInvoice);
    expect(body.paymentType).toBe('CASH');
    expect(body.cashAccountId).toBe('88');
  });

  it('drops the cash account of a CREDIT invoice', () => {
    expect(salesInvoiceBody({ ...form, paymentType: 'CREDIT' }).cashAccountId).toBeUndefined();
  });

  it('passes the description through from the loaded invoice', () => {
    expect(salesInvoiceBody(form, savedInvoice).description).toBe('Delivered on site');
  });

  it('sends no description for a new invoice', () => {
    expect(salesInvoiceBody(form).description).toBeUndefined();
  });

  it('keeps only the lines that have an item and a quantity, priced as unitPrice', () => {
    const body = salesInvoiceBody({
      ...form,
      lines: [
        { itemId: 'i1', qty: '2', price: '12.500', discountPct: '10' },
        { itemId: undefined, qty: '3', price: '1.000' },
        { itemId: 'i2', qty: '', price: '1.000' },
        { itemId: 'i3', qty: '1', price: null, discountPct: null },
      ],
    });
    expect(body.lines).toEqual([
      { itemId: 'i1', qty: '2', unitPrice: '12.500', discountPct: '10' },
      { itemId: 'i3', qty: '1', unitPrice: '0', discountPct: undefined },
    ]);
  });
});
