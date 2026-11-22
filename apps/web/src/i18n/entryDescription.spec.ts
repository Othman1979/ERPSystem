import { describe, expect, it } from 'vitest';
import i18n from './index';
import { entryDescription } from './entryDescription';

describe('entryDescription', () => {
  const row = {
    description: 'Payroll 2027-02',
    descriptionKey: 'journal.auto.payroll',
    descriptionParams: { period: '2027-02' },
  };

  it('translates keyed descriptions in Arabic and English', () => {
    expect(entryDescription(i18n.getFixedT('ar'), row)).toBe('رواتب 2027-02');
    expect(entryDescription(i18n.getFixedT('en'), row)).toBe('Payroll 2027-02');
  });

  it('returns the stored description when no key exists', () => {
    expect(entryDescription(i18n.getFixedT('ar'), { description: 'Manual note' })).toBe(
      'Manual note',
    );
  });
});
