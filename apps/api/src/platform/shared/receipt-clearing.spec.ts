import { Decimal, sum } from '../../common/decimal/decimal.utils.js';
import { clearedThrough } from './receipt-clearing.js';

/** The steps of billing `total` units one `step` at a time. */
function steps(value: string, total: string, step: string): Decimal[] {
  const out: Decimal[] = [];
  let through = new Decimal(0);
  while (through.lt(total)) {
    const next = Decimal.min(through.plus(step), new Decimal(total));
    out.push(clearedThrough(value, next, total).minus(clearedThrough(value, through, total)));
    through = next;
  }
  return out;
}

describe('clearedThrough (ADR-026 §7)', () => {
  it('6 units worth 0.009 billed one at a time: no step negative, the sum is the value', () => {
    const s = steps('0.009', '6', '1');
    expect(s.map((x) => x.toFixed(3))).toEqual(['0.002', '0.001', '0.002', '0.001', '0.002', '0.001']);
    expect(sum(s).toFixed(3)).toBe('0.009');
  });

  it('3 units worth 10.000: 3.333, 3.334, 3.333', () => {
    expect(steps('10', '3', '1').map((x) => x.toFixed(3))).toEqual(['3.333', '3.334', '3.333']);
  });

  it('the whole quantity is the value; nothing is zero', () => {
    expect(clearedThrough('8.889', '8', '8').toFixed(3)).toBe('8.889');
    expect(clearedThrough('8.889', '0', '8').toFixed(3)).toBe('0.000');
  });

  it('every step lies between 0 and what is left, for awkward values', () => {
    for (const [value, total, step] of [
      ['0.001', '7', '1'],
      ['0.005', '3', '0.5'],
      ['1.234', '9', '2'],
      ['0.999', '1000', '7'],
    ]) {
      const s = steps(value, total, step);
      let left = new Decimal(value);
      for (const x of s) {
        expect(x.gte(0)).toBe(true);
        expect(x.lte(left)).toBe(true);
        left = left.minus(x);
      }
      expect(left.toFixed(3)).toBe('0.000');
    }
  });
});
