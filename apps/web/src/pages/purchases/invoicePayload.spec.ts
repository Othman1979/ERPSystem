import { describe, expect, it } from 'vitest';
import type { PurchaseInvoiceDetailDto } from '@erp/api-client';
import { purchaseInvoiceBody, purchaseInvoiceFormDefaults, type PurchaseInvoiceForm } from './invoicePayload';

const savedInvoice = {
  id: '40',
  description: 'Monthly paper order',
  receivedGrnId: '9',
  paymentType: 'CASH',
  cashAccountId: '77',
  supplierInvoiceNo: 'SUP-1001',
  supplierInvoiceDate: '2025-01-05T00:00:00.000Z',
} as unknown as PurchaseInvoiceDetailDto;

const form: PurchaseInvoiceForm = {
  invoiceDate: '2025-01-09',
  dueDate: '2025-02-09',
  supplierId: '5',
  supplierInvoiceNo: '  SUP-1001  ',
  supplierInvoiceDate: '2025-01-05',
  warehouseId: '3',
  paymentType: 'CASH',
  cashAccountId: '77',
  lines: [{ itemId: 'i1', qty: '2', price: '10.000', discountPct: null }],
};

describe('purchase invoice defaults', () => {
  it('starts a new invoice as CREDIT with nothing filled in', () => {
    expect(purchaseInvoiceFormDefaults(undefined)).toEqual({
      paymentType: 'CREDIT',
      cashAccountId: undefined,
      supplierInvoiceNo: undefined,
      supplierInvoiceDate: undefined,
    });
  });

  it('carries the cash account and the supplier invoice fields of a saved invoice', () => {
    expect(purchaseInvoiceFormDefaults(savedInvoice)).toEqual({
      paymentType: 'CASH',
      cashAccountId: '77',
      supplierInvoiceNo: 'SUP-1001',
      supplierInvoiceDate: '2025-01-05',
    });
  });
});

describe('purchase invoice body', () => {
  it('sends the supplier invoice number and date on save', () => {
    const body = purchaseInvoiceBody(form);
    expect(body.supplierInvoiceNo).toBe('SUP-1001');
    expect(body.supplierInvoiceDate).toBe('2025-01-05');
  });

  it('drops a blank supplier invoice number', () => {
    expect(purchaseInvoiceBody({ ...form, supplierInvoiceNo: '   ' }).supplierInvoiceNo).toBeUndefined();
    expect(purchaseInvoiceBody({ ...form, supplierInvoiceNo: undefined }).supplierInvoiceNo).toBeUndefined();
  });

  it('sends the cash account of an edited CASH invoice, from its defaults', () => {
    const defaults = purchaseInvoiceFormDefaults(savedInvoice);
    const body = purchaseInvoiceBody({ ...form, paymentType: defaults.paymentType, cashAccountId: defaults.cashAccountId }, savedInvoice);
    expect(body.paymentType).toBe('CASH');
    expect(body.cashAccountId).toBe('77');
  });

  it('drops the cash account of a CREDIT invoice', () => {
    expect(purchaseInvoiceBody({ ...form, paymentType: 'CREDIT' }).cashAccountId).toBeUndefined();
  });

  it('passes description and receivedGrnId through from the loaded invoice', () => {
    const body = purchaseInvoiceBody(form, savedInvoice);
    expect(body.description).toBe('Monthly paper order');
    expect(body.receivedGrnId).toBe('9');
  });

  it('sends neither for a new invoice', () => {
    const body = purchaseInvoiceBody(form);
    expect(body.description).toBeUndefined();
    expect(body.receivedGrnId).toBeUndefined();
  });

  it('keeps only the lines that have an item and a quantity, priced as unitCost', () => {
    const body = purchaseInvoiceBody({
      ...form,
      lines: [
        { itemId: 'i1', qty: '2', price: '10.000', discountPct: '5' },
        { itemId: undefined, qty: '3', price: '1.000' },
        { itemId: 'i2', qty: '', price: '1.000' },
        { itemId: 'i3', qty: null, price: null, discountPct: null },
        { itemId: 'i4', qty: '1', price: null, discountPct: null },
      ],
    });
    expect(body.lines).toEqual([
      { itemId: 'i1', qty: '2', unitCost: '10.000', discountPct: '5' },
      { itemId: 'i4', qty: '1', unitCost: '0', discountPct: undefined },
    ]);
  });
});
