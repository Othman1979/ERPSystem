import { describe, expect, it } from 'vitest';
import type { BillableLineDto, PurchaseOrderBillableDto } from '@erp/api-client';
import {
  aboveRows,
  billBody,
  billIssues,
  defaultBillRows,
  invoiceNetUnitPrice,
  isAbovePrice,
  type BillHeaderForm,
  type BillRow,
} from './billPayload';

const header: BillHeaderForm = { invoiceDate: '2026-11-15', paymentType: 'CREDIT', supplierInvoiceNo: '  INV-7  ' };

function line(overrides: Partial<BillableLineDto> = {}): BillableLineDto {
  return {
    grnLineId: 'g1',
    grnId: 'grn1',
    grnDocNo: 'GRN-1',
    item: { id: 'i1', code: 'I1', nameAr: 'صنف', nameEn: 'Item' },
    poLineId: 'p1',
    poLineNo: 1,
    receivedQty: '10',
    billedQty: '4',
    unbilledQty: '6',
    receiptUnitCost: '9',
    orderUnitPrice: '10',
    orderDiscountPct: '0',
    orderNetUnitPrice: '10.000000',
    defaultUnitCost: '10',
    defaultDiscountPct: '0',
    taxCategoryId: 't1',
    taxRate: '16',
    ...overrides,
  };
}

function billable(lines: BillableLineDto[], pricesIncludeTax = false): PurchaseOrderBillableDto {
  return {
    orderId: 'o1',
    orderNo: 'PO-1',
    status: 'APPROVED',
    supplierId: 's1',
    warehouseId: 'w1',
    costCenterId: null,
    orderPricesIncludeTax: pricesIncludeTax,
    pricesIncludeTax,
    lines,
  };
}

const row = (overrides: Partial<BillRow> = {}): BillRow => ({
  grnLineId: 'g1',
  selected: true,
  qty: '6',
  unitCost: '10',
  discountPct: '0',
  ...overrides,
});

describe('invoiceNetUnitPrice', () => {
  it('applies the discount and, tax-inclusive, divides out the tax', () => {
    expect(invoiceNetUnitPrice({ unitCost: '10', discountPct: '10', taxRate: '16', pricesIncludeTax: false }).toString()).toBe('9');
    expect(invoiceNetUnitPrice({ unitCost: '11.6', discountPct: '', taxRate: '16', pricesIncludeTax: true }).toString()).toBe('10');
  });
});

describe('isAbovePrice', () => {
  const orderLine = line({ orderNetUnitPrice: '10.000000', taxRate: '16' });

  it('is not above when the price equals the order price', () => {
    expect(isAbovePrice(orderLine, row({ unitCost: '10' }), false)).toBe(false);
  });

  it('is above when the price is higher than the order price', () => {
    expect(isAbovePrice(orderLine, row({ unitCost: '10.5' }), false)).toBe(true);
  });

  it('compares net of tax when the company prices include tax', () => {
    expect(isAbovePrice(orderLine, row({ unitCost: '11.6' }), true)).toBe(false);
    expect(isAbovePrice(orderLine, row({ unitCost: '11.7' }), true)).toBe(true);
  });

  it('is never above when the order has no net price to compare with', () => {
    expect(isAbovePrice(line({ orderNetUnitPrice: null }), row({ unitCost: '999' }), false)).toBe(false);
  });

  it('uses a discount on the invoice price', () => {
    expect(isAbovePrice(orderLine, row({ unitCost: '11', discountPct: '10' }), false)).toBe(false);
  });
});

describe('defaultBillRows', () => {
  it('returns one selected row per line with something unbilled, at the suggested price', () => {
    const rows = defaultBillRows(
      billable([
        line({ grnLineId: 'g1', unbilledQty: '6', defaultUnitCost: '10', defaultDiscountPct: '2' }),
        line({ grnLineId: 'g2', unbilledQty: '0' }),
      ]),
    );
    expect(rows).toEqual([{ grnLineId: 'g1', selected: true, qty: '6', unitCost: '10', discountPct: '2' }]);
  });
});

describe('billBody', () => {
  it('omits unselected rows and rows with a zero quantity, and sends strings only', () => {
    const body = billBody(header, [
      row({ grnLineId: 'g1', qty: '2.5', unitCost: '10.25', discountPct: ' ' }),
      row({ grnLineId: 'g2', selected: false }),
      row({ grnLineId: 'g3', qty: '0' }),
    ]);
    expect(body).toEqual({
      invoiceDate: '2026-11-15',
      paymentType: 'CREDIT',
      supplierInvoiceNo: 'INV-7',
      lines: [{ grnLineId: 'g1', qty: '2.5', unitCost: '10.25' }],
    });
  });

  it('keeps the discount when given and the cash account only for a cash bill', () => {
    const cash = billBody({ ...header, paymentType: 'CASH', cashAccountId: '55' }, [row({ discountPct: '5' })]);
    expect(cash.cashAccountId).toBe('55');
    expect(cash.lines[0]).toEqual({ grnLineId: 'g1', qty: '6', unitCost: '10', discountPct: '5' });
    const credit = billBody({ ...header, cashAccountId: '55' }, [row()]);
    expect(credit).not.toHaveProperty('cashAccountId');
  });

  it('keeps quantities and prices exact as strings', () => {
    const body = billBody(header, [row({ qty: '1.25', unitCost: '3.333333' })]);
    expect(body.lines[0]).toEqual({ grnLineId: 'g1', qty: '1.25', unitCost: '3.333333', discountPct: '0' });
  });
});

describe('billIssues', () => {
  const base = billable([line({ unbilledQty: '6' })]);

  it('is clean for a valid bill', () => {
    expect(billIssues(base, header, [row()])).toEqual([]);
  });

  it('reports no lines when nothing is billed', () => {
    expect(billIssues(base, header, [row({ selected: false })])).toEqual([{ code: 'NO_LINES' }]);
  });

  it('reports a quantity above what is unbilled', () => {
    expect(billIssues(base, header, [row({ qty: '6.000001' })])).toEqual([
      { code: 'QTY_ABOVE_UNBILLED', grnLineId: 'g1' },
    ]);
  });

  it('reports a blank or negative quantity on a selected row', () => {
    expect(billIssues(base, header, [row({ qty: '' })])).toContainEqual({ code: 'QTY_INVALID', grnLineId: 'g1' });
    expect(billIssues(base, header, [row({ qty: '-1' })])).toContainEqual({ code: 'QTY_INVALID', grnLineId: 'g1' });
  });

  it('reports a cash bill without a cash account', () => {
    expect(billIssues(base, { ...header, paymentType: 'CASH' }, [row()])).toEqual([{ code: 'CASH_ACCOUNT_REQUIRED' }]);
  });

  it('reports a unit cost with more than 6 decimals and a discount above 100', () => {
    expect(billIssues(base, header, [row({ unitCost: '1.1234567' })])).toEqual([
      { code: 'UNIT_COST_INVALID', grnLineId: 'g1' },
    ]);
    expect(billIssues(base, header, [row({ discountPct: '101' })])).toEqual([
      { code: 'DISCOUNT_INVALID', grnLineId: 'g1' },
    ]);
  });
});

describe('aboveRows', () => {
  it('lists the selected rows priced above the order', () => {
    const b = billable([line({ grnLineId: 'g1' }), line({ grnLineId: 'g2' })]);
    const rows = [row({ grnLineId: 'g1', unitCost: '10' }), row({ grnLineId: 'g2', unitCost: '12' })];
    expect(aboveRows(b, rows).map((r) => r.grnLineId)).toEqual(['g2']);
  });
});
