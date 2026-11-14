import { describe, expect, it } from 'vitest';
import { purchaseReturnBody, type PurchaseReturnForm, type ReturnedInvoice } from './returnPayload';

const invoice: ReturnedInvoice = { id: '12', warehouseId: '3', lines: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }] };
const form: PurchaseReturnForm = {
  returnDate: '2025-01-09',
  refundType: 'CREDIT',
  cashAccountId: '77',
  reason: '',
  qtyByLine: { l1: '2', l2: '0', l3: '' },
};

describe('purchase return body (ADR-016 §5)', () => {
  it("sends the original invoice's warehouse, and only the lines with a quantity", () => {
    expect(purchaseReturnBody(invoice, form)).toEqual({
      returnDate: '2025-01-09',
      originalInvoiceId: '12',
      warehouseId: '3',
      refundType: 'CREDIT',
      cashAccountId: undefined,
      reason: undefined,
      lines: [{ originalLineId: 'l1', qty: '2' }],
    });
  });

  it('sends the cash account only for a cash refund', () => {
    expect(purchaseReturnBody(invoice, { ...form, refundType: 'CASH' }).cashAccountId).toBe('77');
  });

  it('sends no warehouse for an invoice without one, so the API answers RETURN_WAREHOUSE_REQUIRED', () => {
    const body = JSON.parse(JSON.stringify(purchaseReturnBody({ ...invoice, warehouseId: null }, form))) as Record<string, unknown>;
    expect(body).not.toHaveProperty('warehouseId');
  });
});
