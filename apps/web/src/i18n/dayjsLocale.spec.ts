import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
// The app's i18n entry installs the Levantine month names.
import '../i18n';
import { LEVANTINE_MONTHS } from './dayjsLocale';

describe('Arabic month names are Levantine', () => {
  it('formats November as تشرين الثاني, not نوفمبر', () => {
    expect(dayjs('2026-11-13').locale('ar').format('D MMMM YYYY')).toBe('13 تشرين الثاني 2026');
    expect(dayjs('2026-01-05').locale('ar').format('MMM')).toBe('كانون الثاني');
  });

  it('covers all twelve months in order and keeps the rest of the locale', () => {
    expect(LEVANTINE_MONTHS).toHaveLength(12);
    expect(dayjs('2026-08-01').locale('ar').format('MMMM')).toBe('آب');
    expect(dayjs('2026-11-13').locale('ar').format('dddd')).toBe('الجمعة');
  });

  it('leaves English untouched', () => {
    expect(dayjs('2026-11-13').locale('en').format('MMMM')).toBe('November');
  });
});
