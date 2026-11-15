import { describe, expect, it } from 'vitest';
import {
  approvalHint,
  isAuthoredBy,
  missingPriceLines,
  purchaseOrderBody,
  purchaseOrderUpdateBody,
  type PurchaseOrderForm,
} from './orderPayload';

const form: PurchaseOrderForm = {
  orderDate: '2026-11-15',
  expectedDate: '  ',
  supplierId: '5',
  warehouseId: '3',
  costCenterId: undefined,
  requestId: '90',
  notes: '  deliver before noon  ',
};

describe('purchase order body', () => {
  it('sends strings only, trims notes, and omits blank optional fields', () => {
    const body = purchaseOrderBody(form, [
      { itemId: 'i1', itemUnitId: '', qty: '2.5', unitPrice: '10.250', discountPct: ' ' },
    ]);
    expect(body).toEqual({
      orderDate: '2026-11-15',
      supplierId: '5',
      warehouseId: '3',
      requestId: '90',
      notes: 'deliver before noon',
      lines: [{ itemId: 'i1', qty: '2.5', unitPrice: '10.250' }],
    });
    expect(body).not.toHaveProperty('expectedDate');
    expect(body).not.toHaveProperty('costCenterId');
  });

  it('keeps the request line, the unit and the discount on a line that has them', () => {
    const body = purchaseOrderBody({ ...form, requestId: undefined }, [
      {
        itemId: 'i2',
        itemUnitId: '44',
        qty: '1',
        unitPrice: '3',
        discountPct: '5',
        requestLineId: '700',
      },
    ]);
    expect(body).not.toHaveProperty('requestId');
    expect(body.lines).toEqual([
      { itemId: 'i2', itemUnitId: '44', qty: '1', unitPrice: '3', discountPct: '5', requestLineId: '700' },
    ]);
  });

  it('drops lines without an item or a quantity', () => {
    const body = purchaseOrderBody(form, [
      { itemId: undefined, qty: '4', unitPrice: '2' },
      { itemId: 'i3', qty: '', unitPrice: '2' },
      { itemId: 'i4', qty: '1', unitPrice: '5' },
    ]);
    expect(body.lines).toEqual([{ itemId: 'i4', qty: '1', unitPrice: '5' }]);
  });

  it('never sends a blank price as zero: a line with an item and a quantity needs a price', () => {
    expect(() => purchaseOrderBody(form, [{ itemId: 'i4', qty: '1', unitPrice: null }])).toThrow();
    expect(() => purchaseOrderBody(form, [{ itemId: 'i4', qty: '1', unitPrice: '  ' }])).toThrow();
  });

  it('sends an explicit zero price as the price it is', () => {
    const body = purchaseOrderBody(form, [{ itemId: 'i4', qty: '1', unitPrice: '0' }]);
    expect(body.lines).toEqual([{ itemId: 'i4', qty: '1', unitPrice: '0' }]);
  });

  it('never carries a total, even when the form holds one', () => {
    const body = purchaseOrderBody(
      { ...form, costCenterId: '12' } as PurchaseOrderForm & { grandTotal: string },
      [{ itemId: 'i1', qty: '1', unitPrice: '1' }],
    );
    expect(body).toMatchObject({ costCenterId: '12' });
    expect(body).not.toHaveProperty('grandTotal');
    expect(body).not.toHaveProperty('netTotal');
    expect(body).not.toHaveProperty('taxTotal');
  });
});

describe('purchase order update body', () => {
  it('is the same body without the request id, which is set at creation only', () => {
    const lines = [{ itemId: 'i1', qty: '2', unitPrice: '1.5' }];
    const update = purchaseOrderUpdateBody(form, lines);
    expect(update).not.toHaveProperty('requestId');
    expect(update).toEqual({
      orderDate: '2026-11-15',
      supplierId: '5',
      warehouseId: '3',
      notes: 'deliver before noon',
      lines: [{ itemId: 'i1', qty: '2', unitPrice: '1.5' }],
    });
  });
});

describe('missingPriceLines', () => {
  it('returns the indexes of the lines with an item and no price', () => {
    expect(
      missingPriceLines([
        { itemId: 'i1', qty: '1', unitPrice: '2' },
        { itemId: 'i2', qty: '1', unitPrice: null },
        { itemId: 'i3', qty: '1' },
        { itemId: 'i4', qty: '1', unitPrice: '   ' },
      ]),
    ).toEqual([1, 2, 3]);
  });

  it('ignores blank rows without an item', () => {
    expect(missingPriceLines([{ qty: '1' }, {}])).toEqual([]);
  });

  it('counts a price of zero as a price', () => {
    expect(missingPriceLines([{ itemId: 'i1', qty: '1', unitPrice: '0' }])).toEqual([]);
  });

  it('is empty when every line with an item has a price', () => {
    expect(missingPriceLines([{ itemId: 'i1', unitPrice: '1.250' }, { itemId: 'i2', unitPrice: '3' }])).toEqual([]);
  });
});

describe('isAuthoredBy', () => {
  const doc = { createdBy: 'u1', updatedBy: 'u2', submittedBy: 'u3' };

  it('is true for the member who created the document', () => {
    expect(isAuthoredBy({ ...doc, updatedBy: null, submittedBy: null }, 'u1')).toBe(true);
  });

  it('is true for the member who last edited the document', () => {
    expect(isAuthoredBy({ ...doc, createdBy: 'u9', submittedBy: null }, 'u2')).toBe(true);
  });

  it('is true for the member who submitted the document', () => {
    expect(isAuthoredBy({ ...doc, createdBy: 'u9', updatedBy: null }, 'u3')).toBe(true);
  });

  it('is false for another member', () => {
    expect(isAuthoredBy(doc, 'u4')).toBe(false);
  });

  it('is false when the fields are empty or the member is unknown', () => {
    expect(isAuthoredBy({ createdBy: null, updatedBy: null, submittedBy: null }, 'u1')).toBe(false);
    expect(isAuthoredBy(doc, undefined)).toBe(false);
  });
});

describe('approvalHint', () => {
  const base = {
    isOwner: false,
    canApprove: true,
    approvalLimit: '1000',
    grandTotal: '500',
    authoredByMe: false,
  };

  it('the owner always approves', () => {
    expect(approvalHint({ ...base, isOwner: true, approvalLimit: '1', grandTotal: '999999', authoredByMe: true })).toBe('ok');
  });

  it('a member without purchase.approve has no approval', () => {
    expect(approvalHint({ ...base, canApprove: false })).toBe('noApproval');
  });

  it('a member does not approve a document they wrote', () => {
    expect(approvalHint({ ...base, authoredByMe: true })).toBe('ownDocument');
  });

  it('an order exactly at the limit is within it', () => {
    expect(approvalHint({ ...base, approvalLimit: '1000', grandTotal: '1000' })).toBe('ok');
  });

  it('one fils over the limit needs the owner', () => {
    expect(approvalHint({ ...base, approvalLimit: '1000', grandTotal: '1000.001' })).toBe('needsOwner');
  });

  it('compares the amounts as decimals, not as strings', () => {
    // As text '1000' sorts before '999'; as decimals 1000 is the larger amount.
    expect(approvalHint({ ...base, approvalLimit: '999', grandTotal: '1000' })).toBe('needsOwner');
    expect(approvalHint({ ...base, approvalLimit: '1000', grandTotal: '999' })).toBe('ok');
  });

  it('no limit (null or undefined) never needs the owner', () => {
    expect(approvalHint({ ...base, approvalLimit: null, grandTotal: '98765.432' })).toBe('ok');
    expect(approvalHint({ ...base, approvalLimit: undefined, grandTotal: '98765.432' })).toBe('ok');
  });

  it('a zero limit is a limit: any positive order needs the owner', () => {
    expect(approvalHint({ ...base, approvalLimit: '0', grandTotal: '0.001' })).toBe('needsOwner');
  });
});
