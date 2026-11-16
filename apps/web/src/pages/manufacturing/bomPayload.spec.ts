import { describe, expect, it } from 'vitest';
import { bomCreateBody, bomProblems, bomUpdateBody, isPositiveQty, type BomForm } from './bomPayload';

const complete: BomForm = {
  itemId: '5',
  outputQty: '10',
  appliedCostPerUnit: '2.5',
  lines: [{ key: 1, componentItemId: '7', qty: '2', wastePct: '5' }],
};

describe('BOM quantities', () => {
  it('accepts a positive quantity with up to 6 decimals and rejects zero or a bad shape', () => {
    expect(isPositiveQty('0.000001')).toBe(true);
    expect(isPositiveQty('12')).toBe(true);
    expect(isPositiveQty('0')).toBe(false);
    expect(isPositiveQty('1.0000001')).toBe(false);
    expect(isPositiveQty('-1')).toBe(false);
    expect(isPositiveQty('')).toBe(false);
    expect(isPositiveQty(undefined)).toBe(false);
  });
});

describe('bomProblems', () => {
  it('lists each missing or invalid part once', () => {
    const problems = bomProblems({
      outputQty: '0',
      lines: [{ key: 1, componentItemId: '7', qty: '0', wastePct: '150' }],
    });
    expect(new Set(problems)).toEqual(new Set(['item', 'outputQty', 'lines', 'qty', 'waste']));
  });

  it('flags a line that has a quantity but no component, and a bad cost', () => {
    const problems = bomProblems({
      ...complete,
      appliedCostPerUnit: '1.0001',
      lines: [{ key: 1, qty: '3' }],
    });
    expect(new Set(problems)).toEqual(new Set(['lines', 'component', 'cost']));
  });

  it('is empty for a complete form, and a blank line on its own is not a problem', () => {
    expect(bomProblems(complete)).toEqual([]);
    expect(bomProblems({ ...complete, lines: [...complete.lines, { key: 2 }] })).toEqual([]);
  });

  it('accepts a waste of exactly 0 and 100', () => {
    expect(bomProblems({ ...complete, lines: [{ key: 1, componentItemId: '7', qty: '1', wastePct: '0' }] })).toEqual([]);
    expect(bomProblems({ ...complete, lines: [{ key: 1, componentItemId: '7', qty: '1', wastePct: '100' }] })).toEqual([]);
  });
});

describe('BOM bodies', () => {
  it('sends strings, trims them, and leaves out blank optional fields and half-filled lines', () => {
    const body = bomCreateBody({
      itemId: '5',
      outputQty: ' 10 ',
      appliedCostPerUnit: '',
      note: '  ',
      lines: [
        { key: 1, componentItemId: '7', qty: '2', wastePct: '', note: '' },
        { key: 2, componentItemId: '', qty: '1' },
      ],
    });
    expect(body).toEqual({ itemId: '5', outputQty: '10', lines: [{ componentItemId: '7', qty: '2' }] });
  });

  it('keeps the unit, waste, cost and note when they are given', () => {
    const body = bomCreateBody({
      ...complete,
      outputItemUnitId: '31',
      note: ' fixed ',
      lines: [{ key: 1, componentItemId: '7', itemUnitId: '44', qty: '2.5', wastePct: '5', note: 'hot' }],
    });
    expect(body).toEqual({
      itemId: '5',
      outputQty: '10',
      outputItemUnitId: '31',
      appliedCostPerUnit: '2.5',
      note: 'fixed',
      lines: [{ componentItemId: '7', itemUnitId: '44', qty: '2.5', wastePct: '5', note: 'hot' }],
    });
  });

  it('never sends the item on update', () => {
    expect(Object.keys(bomUpdateBody(complete))).not.toContain('itemId');
    expect(bomUpdateBody(complete).outputQty).toBe('10');
  });
});
