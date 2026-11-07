import { Decimal } from 'decimal.js';
import { round3, round6, sum } from './decimal.utils.js';

describe('decimal utils', () => {
  it('round3 rounds half up to 3 places', () => {
    expect(round3('1.2345').toString()).toBe('1.235');
    expect(round3('1.2344').toString()).toBe('1.234');
  });

  it('round6 rounds to 6 places', () => {
    expect(round6('5.5803571428').toString()).toBe('5.580357');
  });

  it('sum avoids float drift', () => {
    const result = sum(['0.1', '0.2', '0.3']);
    expect(result.toString()).toBe('0.6');
    expect(result).toBeInstanceOf(Decimal);
  });
});
