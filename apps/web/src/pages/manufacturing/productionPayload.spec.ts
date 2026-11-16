import { describe, expect, it } from 'vitest';
import {
  appliedCostPreview,
  productionCreateBody,
  productionProblems,
  standardQtyBase,
  unitFactor,
  varianceOf,
  withStandard,
  type ProductionForm,
  type ProductionLineForm,
} from './productionPayload';

const form: ProductionForm = {
  itemId: '9',
  bomId: '3',
  qty: '5',
  materialsWarehouseId: '1',
  voucherDate: '2026-11-16',
  lines: [{ key: 1, itemId: '7', qty: '1.05' }],
};

describe('standard requirement of a formula line (ADR-031 §5)', () => {
  it('scales the line by produced over output and adds the waste', () => {
    // 2 per 10 output, 5 produced, 5% waste: 1 x 1.05.
    expect(standardQtyBase('2', '5', '10', '5').toFixed(6)).toBe('1.050000');
  });

  it('gives zero when the formula has no output quantity', () => {
    expect(standardQtyBase('2', '5', '0', '0').toFixed(6)).toBe('0.000000');
  });
});

describe('unit factor', () => {
  const units = [{ id: '44', factorToBase: '12' }];
  it('is 1 for the base unit, the unit factor for a known unit, null for an unknown one', () => {
    expect(unitFactor(undefined, units)?.toString()).toBe('1');
    expect(unitFactor('44', units)?.toString()).toBe('12');
    expect(unitFactor('99', units)).toBeNull();
  });
});

describe('standard against actual (the difference of a line)', () => {
  it('shows more than the standard as over, less as under, and equal as even', () => {
    expect(varianceOf('1', '1.5', '2')).toMatchObject({ tone: 'over' });
    expect(varianceOf('5', '4', '1')).toMatchObject({ tone: 'under' });
    expect(varianceOf('2', '2', '1')).toMatchObject({ tone: 'even' });
  });

  it('converts the actual quantity to the base unit before comparing', () => {
    // One box of 12 against a standard of 12 base units: no difference.
    const v = varianceOf('12', '1', '12');
    expect(v.actualBase?.toFixed(6)).toBe('12.000000');
    expect(v.diffBase?.toFixed(6)).toBe('0.000000');
    expect(v.tone).toBe('even');
  });

  it('counts a missing standard (an extra material) as zero', () => {
    const v = varianceOf(null, '3', '1');
    expect(v.diffBase?.toFixed(6)).toBe('3.000000');
    expect(v.tone).toBe('over');
  });

  it('gives no difference without a usable quantity or a unit factor', () => {
    expect(varianceOf('1', '', '1')).toMatchObject({ actualBase: null, diffBase: null, tone: 'even' });
    expect(varianceOf('1', '2', null)).toMatchObject({ actualBase: null, tone: 'even' });
  });
});

describe('productionProblems', () => {
  it('is empty for a complete form', () => {
    expect(productionProblems(form)).toEqual([]);
  });

  it('flags a missing product, formula, quantity, warehouse and material', () => {
    const problems = productionProblems({ ...form, itemId: undefined, bomId: undefined, qty: '0', materialsWarehouseId: undefined, lines: [] });
    expect(new Set(problems)).toEqual(new Set(['item', 'bom', 'qty', 'materialsWarehouse', 'lines']));
  });

  it('flags a material line that has no item or no quantity', () => {
    expect(productionProblems({ ...form, lines: [...form.lines, { key: 2, qty: '2' }]})).toContain('line');
    expect(productionProblems({ ...form, lines: [...form.lines, { key: 2, itemId: '8', qty: '' }]})).toContain('line');
  });
});

describe('productionCreateBody', () => {
  it('sends the lines in their unit, leaves out blank fields, and never sends totals', () => {
    const body = productionCreateBody({
      ...form,
      outputWarehouseId: undefined,
      costCenterId: '',
      description: ' batch 4 ',
      lines: [
        { key: 1, itemId: '7', itemUnitId: '44', qty: '2', note: '' },
        { key: 2, itemId: '8', qty: '1.5', note: 'hot' },
        { key: 3, qty: '4' },
      ],
    });
    expect(body).toEqual({
      itemId: '9',
      bomId: '3',
      qty: '5',
      materialsWarehouseId: '1',
      voucherDate: '2026-11-16',
      description: 'batch 4',
      lines: [
        { itemId: '7', itemUnitId: '44', qty: '2' },
        { itemId: '8', qty: '1.5', note: 'hot' },
      ],
    });
    expect(Object.keys(body)).not.toContain('appliedTotal');
  });
});

describe('withStandard', () => {
  const bomLines = [
    { componentItemId: '7', componentLabel: '7 Flour', qtyBase: '2', wastePct: '0' },
    { componentItemId: '8', componentLabel: '8 Sugar', qtyBase: '1', wastePct: '10' },
  ];
  const nextKey = (() => {
    let k = 100;
    return () => ++k;
  })();

  it('keeps a quantity the user edited when asked, and resets the others to the formula', () => {
    const lines: ProductionLineForm[] = [
      { key: 1, itemId: '7', qty: '9', edited: true, standardQtyBase: '2' },
      { key: 2, itemId: '6', qty: '1', standardQtyBase: '0' },
    ];
    // 5 produced from an output of 5: the standards are 2 (flour) and 1.1 (sugar with waste).
    const out = withStandard(lines, bomLines, '5', '5', nextKey, { keepEdited: true });
    expect(out[0]).toMatchObject({ itemId: '7', qty: '9', standardQtyBase: '2.000000', edited: true });
    expect(out[1]).toMatchObject({ itemId: '6', qty: '1', standardQtyBase: '0' });
    expect(out[2]).toMatchObject({ itemId: '8', itemLabel: '8 Sugar', qty: '1.100000', standardQtyBase: '1.100000', edited: false });
  });

  it('resets an edited quantity and its unit when the user does not keep edits', () => {
    const lines: ProductionLineForm[] = [{ key: 1, itemId: '7', qty: '9', itemUnitId: '44', edited: true }];
    const out = withStandard(lines, bomLines, '5', '5', nextKey, { keepEdited: false });
    expect(out[0]).toMatchObject({ qty: '2.000000', itemUnitId: undefined, edited: false });
  });
});

describe('appliedCostPreview', () => {
  it('is the cost per unit times the produced base quantity, to 3 dp', () => {
    expect(appliedCostPreview('2.5', '10')?.toFixed(3)).toBe('25.000');
    expect(appliedCostPreview('0', '10')?.toFixed(3)).toBe('0.000');
    expect(appliedCostPreview('1.25', '3')?.toFixed(3)).toBe('3.750');
  });

  it('is unknown until both values are known', () => {
    expect(appliedCostPreview(undefined, '10')).toBeNull();
    expect(appliedCostPreview('2', '')).toBeNull();
  });
});
