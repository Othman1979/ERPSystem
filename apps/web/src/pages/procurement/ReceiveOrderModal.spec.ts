import { describe, expect, it } from 'vitest';
import type { PurchaseOrderLineViewDto } from '@erp/api-client';
import { defaultReceiveQtys, planReceive, remainingBaseQty } from './ReceiveOrderModal';

/** A line as the order returns it; only the quantities matter to these helpers. */
function line(id: string, qtyBase: string, receivedQty: string): PurchaseOrderLineViewDto {
  return { id, qtyBase, receivedQty } as unknown as PurchaseOrderLineViewDto;
}

describe('receive quantities', () => {
  it('defaults each line to what is still left on it', () => {
    const lines = [line('a', '10', '4'), line('b', '3', '0'), line('c', '5', '5')];

    expect(defaultReceiveQtys(lines)).toEqual({ a: '6', b: '3', c: '0' });
  });

  it('never reports a negative remainder', () => {
    expect(remainingBaseQty(line('a', '2', '3')).toFixed()).toBe('0');
  });

  it('keeps decimal base quantities exact', () => {
    expect(remainingBaseQty(line('a', '1.5', '0.25')).toFixed()).toBe('1.25');
  });

  it('plans only the lines with a quantity, as strings, and skips blank and zero lines', () => {
    const lines = [line('a', '10', '4'), line('b', '3', '0'), line('c', '5', '5')];
    const plan = planReceive(lines, { a: '2.5', b: '', c: '0' });

    expect(plan.lines).toEqual([{ poLineId: 'a', qty: '2.5' }]);
    expect(plan.invalid.size).toBe(0);
  });

  it('refuses more than what is left, a negative quantity or a non-number', () => {
    const lines = [line('a', '10', '4'), line('b', '3', '0'), line('c', '5', '0')];
    const plan = planReceive(lines, { a: '7', b: '-1', c: 'abc' });

    expect([...plan.invalid].sort()).toEqual(['a', 'b', 'c']);
    expect(plan.lines).toEqual([]);
  });

  it('accepts exactly what is left', () => {
    const plan = planReceive([line('a', '10', '4')], { a: '6' });

    expect(plan.lines).toEqual([{ poLineId: 'a', qty: '6' }]);
    expect(plan.invalid.size).toBe(0);
  });
});
