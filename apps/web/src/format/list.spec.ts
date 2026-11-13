import { describe, expect, it } from 'vitest';
import { formatList } from './list';

describe('formatList (WEB-21)', () => {
  it('uses the English separators in the English UI', () => {
    expect(formatList(['Main', 'North', 'South'], 'en')).toBe('Main, North, and South');
    expect(formatList(['Main', 'North'], 'en')).toBe('Main and North');
  });

  it('joins with the Arabic conjunction, never the Latin comma, in the Arabic UI', () => {
    // CLDR's Arabic list pattern: «أ وب وج».
    expect(formatList(['الرئيسي', 'الشمال', 'الجنوب'], 'ar')).toBe('الرئيسي والشمال والجنوب');
  });

  it('returns a single name or nothing as is', () => {
    expect(formatList(['Main'], 'en')).toBe('Main');
    expect(formatList([], 'ar')).toBe('');
  });
});
