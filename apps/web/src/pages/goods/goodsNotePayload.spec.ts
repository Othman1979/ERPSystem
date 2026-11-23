import { describe, expect, it } from 'vitest';
import { goodsNoteBody, type GoodsNoteFormValues } from './goodsNotePayload';

const WH = 'wh-1';
const base: GoodsNoteFormValues = {
  noteType: 'GRN',
  noteDate: '2026-11-15',
  warehouseId: WH,
  description: 'delivery',
  lines: [{ itemId: 'item-1', qty: '5', unitCost: '1.250000' }],
};

describe('goodsNoteBody', () => {
  it('sends a plain GRN with unit cost and no links or accounts', () => {
    const body = goodsNoteBody({
      ...base,
      expenseAccountId: 'acc-x',
      costCenterId: 'cc-x',
    });
    expect(body).toEqual({
      noteDate: '2026-11-15',
      warehouseId: WH,
      noteType: 'GRN',
      description: 'delivery',
      lines: [{ itemId: 'item-1', qty: '5', unitCost: '1.250000' }],
    });
    expect(body).not.toHaveProperty('expenseAccountId');
    expect(body).not.toHaveProperty('costCenterId');
  });

  it('sends a positive receipt cost for a consignment receipt and no cost for a consignment return', () => {
    const receipt = goodsNoteBody({
      ...base,
      noteType: 'CONSIGNMENT_IN',
      lines: [{ itemId: 'item-1', qty: '2', unitCost: '1.250000' }],
    });
    expect(receipt.lines).toEqual([{ itemId: 'item-1', qty: '2', unitCost: '1.250000' }]);
    expect(receipt).not.toHaveProperty('supplierId');
    expect(receipt).not.toHaveProperty('expenseAccountId');

    const returned = goodsNoteBody({
      ...base,
      noteType: 'CONSIGNMENT_OUT',
      lines: [{ itemId: 'item-1', qty: '1', unitCost: '9.000000' }],
    });
    expect(returned.lines).toEqual([{ itemId: 'item-1', qty: '1' }]);
  });

  it('drops lines without an item or quantity', () => {
    const body = goodsNoteBody({
      ...base,
      lines: [
        { itemId: 'item-1', qty: '2' },
        { itemId: '', qty: '3' },
        { itemId: 'item-2', qty: '' },
      ],
    });
    expect(body.lines).toEqual([{ itemId: 'item-1', qty: '2' }]);
  });

  it('sends the expense account and cost centre of a GIN when chosen, never unit cost', () => {
    const body = goodsNoteBody({
      ...base,
      noteType: 'GIN',
      expenseAccountId: 'acc-5',
      costCenterId: 'cc-2',
      lines: [{ itemId: 'item-1', qty: '3', unitCost: '9.000000' }],
    });
    expect(body.expenseAccountId).toBe('acc-5');
    expect(body.costCenterId).toBe('cc-2');
    expect(body.lines).toEqual([{ itemId: 'item-1', qty: '3' }]);
  });

  it('omits the GIN account and centre when none is chosen', () => {
    const body = goodsNoteBody({ ...base, noteType: 'GIN', lines: [{ itemId: 'item-1', qty: '1' }] });
    expect(body).not.toHaveProperty('expenseAccountId');
    expect(body).not.toHaveProperty('costCenterId');
  });

  it('keeps the order link and order lines on an order-linked GRN update, without unit cost', () => {
    const body = goodsNoteBody(
      {
        ...base,
        lines: [{ itemId: 'item-1', qty: '4', unitCost: '1.250000', poLineId: 'pl-1' }],
      },
      { purchaseOrderId: 'po-9', issueRequestId: null },
    );
    expect(body.purchaseOrderId).toBe('po-9');
    expect(body).not.toHaveProperty('issueRequestId');
    expect(body.lines).toEqual([{ itemId: 'item-1', qty: '4', poLineId: 'pl-1' }]);
    expect(body).not.toHaveProperty('expenseAccountId');
    expect(body).not.toHaveProperty('costCenterId');
  });

  it('keeps the request link and request lines on a request-linked GIN update', () => {
    const body = goodsNoteBody(
      {
        ...base,
        noteType: 'GIN',
        expenseAccountId: 'acc-5',
        costCenterId: 'cc-2',
        lines: [{ itemId: 'item-1', qty: '2', issueRequestLineId: 'rl-7' }],
      },
      { purchaseOrderId: null, issueRequestId: 'ir-3' },
    );
    expect(body.issueRequestId).toBe('ir-3');
    expect(body).not.toHaveProperty('purchaseOrderId');
    expect(body.lines).toEqual([{ itemId: 'item-1', qty: '2', issueRequestLineId: 'rl-7' }]);
    expect(body.expenseAccountId).toBe('acc-5');
    expect(body.costCenterId).toBe('cc-2');
  });

  it('sends null for a GIN account and centre the user cleared, on update', () => {
    const body = goodsNoteBody(
      { ...base, noteType: 'GIN', lines: [{ itemId: 'item-1', qty: '1' }] },
      { purchaseOrderId: null, issueRequestId: 'ir-3' },
      true,
    );
    expect(body.expenseAccountId).toBeNull();
    expect(body.costCenterId).toBeNull();
  });

  it('keeps the chosen GIN account and centre on update', () => {
    const body = goodsNoteBody(
      { ...base, noteType: 'GIN', expenseAccountId: 'acc-5', costCenterId: 'cc-2', lines: [{ itemId: 'item-1', qty: '1' }] },
      { purchaseOrderId: null, issueRequestId: 'ir-3' },
      true,
    );
    expect(body.expenseAccountId).toBe('acc-5');
    expect(body.costCenterId).toBe('cc-2');
  });

  it('never sends a GIN account or centre for a GRN update', () => {
    const body = goodsNoteBody(
      { ...base, expenseAccountId: null, costCenterId: null },
      { purchaseOrderId: 'po-9', issueRequestId: null },
      true,
    );
    expect(body).not.toHaveProperty('expenseAccountId');
    expect(body).not.toHaveProperty('costCenterId');
  });

  it('omits a cleared GIN account and centre on create', () => {
    const body = goodsNoteBody({
      ...base,
      noteType: 'GIN',
      expenseAccountId: null,
      costCenterId: null,
      lines: [{ itemId: 'item-1', qty: '1' }],
    });
    expect(body).not.toHaveProperty('expenseAccountId');
    expect(body).not.toHaveProperty('costCenterId');
  });

  it('clears an empty description to undefined', () => {
    expect(goodsNoteBody({ ...base, description: '' }).description).toBeUndefined();
  });
});
