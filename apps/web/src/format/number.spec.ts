import { describe, expect, it } from 'vitest';
import {
  dec,
  formatAmount,
  formatPercent,
  formatQty,
  formatUnitCost,
  sum,
  toDecimal,
} from './number';

describe('formatAmount', () => {
  it('always shows 3 decimals with thousands separators', () => {
    expect(formatAmount('91083.595')).toBe('91,083.595');
    expect(formatAmount('508.95')).toBe('508.950');
    expect(formatAmount('0')).toBe('0.000');
    expect(formatAmount('1234567.1')).toBe('1,234,567.100');
  });

  it('rounds half up', () => {
    expect(formatAmount('2.0005')).toBe('2.001');
    expect(formatAmount('2.0004')).toBe('2.000');
    expect(formatAmount('-2.0005')).toBe('-2.001');
  });

  it('keeps the minus sign for negatives and drops it for negative zero', () => {
    expect(formatAmount('-200')).toBe('-200.000');
    expect(formatAmount('-1234.5')).toBe('-1,234.500');
    expect(formatAmount('-0.0001')).toBe('0.000');
  });

  it('is exact where floats are not', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in floats
    expect(formatAmount(sum(['0.1', '0.2']))).toBe('0.300');
    expect(formatAmount('9999999999999.9995')).toBe('10,000,000,000,000.000');
  });

  it('shows a dash for missing or invalid values', () => {
    expect(formatAmount(null)).toBe('—');
    expect(formatAmount(undefined)).toBe('—');
    expect(formatAmount('')).toBe('—');
    expect(formatAmount('abc')).toBe('—');
    expect(formatAmount(null, '')).toBe('');
  });
});

describe('formatQty', () => {
  it('trims trailing zeros, up to 6 decimals', () => {
    expect(formatQty('134.000000')).toBe('134');
    expect(formatQty('1.500000')).toBe('1.5');
    expect(formatQty('0.0005')).toBe('0.0005');
    expect(formatQty('1250')).toBe('1,250');
    expect(formatQty('-5')).toBe('-5');
  });
});

describe('formatUnitCost', () => {
  it('shows at least 3 and up to 6 decimals', () => {
    expect(formatUnitCost('2.1')).toBe('2.100');
    expect(formatUnitCost('0.123456')).toBe('0.123456');
    expect(formatUnitCost('0.1234565')).toBe('0.123457');
    expect(formatUnitCost('1500.25')).toBe('1,500.250');
  });
});

describe('formatPercent', () => {
  it('trims to the needed decimals', () => {
    expect(formatPercent('16.000')).toBe('16');
    expect(formatPercent('7.5')).toBe('7.5');
  });
});

describe('toDecimal / dec', () => {
  it('parses strings and numbers, rejects junk', () => {
    expect(toDecimal('1.5')?.toString()).toBe('1.5');
    expect(toDecimal(2)?.toString()).toBe('2');
    expect(toDecimal('x')).toBeNull();
    expect(toDecimal(Number.NaN)).toBeNull();
    expect(dec(null).toString()).toBe('0');
  });
});
