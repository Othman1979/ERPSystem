import { describe, expect, it } from 'vitest';
import { bothNames, codeAndName, displayName } from './displayName';

describe('displayName', () => {
  const both = { nameAr: 'المستودع الرئيسي', nameEn: 'Main Warehouse' };

  it('uses the Arabic name in Arabic', () => {
    expect(displayName(both, 'ar')).toBe('المستودع الرئيسي');
  });

  it('uses the English name in English', () => {
    expect(displayName(both, 'en')).toBe('Main Warehouse');
  });

  it('falls back to Arabic when the English name is missing or blank', () => {
    expect(displayName({ nameAr: 'صنف' }, 'en')).toBe('صنف');
    expect(displayName({ nameAr: 'صنف', nameEn: null }, 'en')).toBe('صنف');
    expect(displayName({ nameAr: 'صنف', nameEn: '   ' }, 'en')).toBe('صنف');
  });

  it('falls back to English when the Arabic name is blank', () => {
    expect(displayName({ nameAr: '  ', nameEn: 'Cash' }, 'ar')).toBe('Cash');
  });

  it('returns undefined for a missing record', () => {
    expect(displayName(null)).toBeUndefined();
    expect(displayName(undefined)).toBeUndefined();
  });
});

describe('bothNames', () => {
  const both = { nameAr: 'الصندوق', nameEn: 'Cash' };

  it('shows only the UI language', () => {
    expect(bothNames(both, 'ar')).toBe('الصندوق');
    expect(bothNames(both, 'en')).toBe('Cash');
  });

  it('shows one name when there is no English name', () => {
    expect(bothNames({ nameAr: 'الصندوق', nameEn: null }, 'ar')).toBe('الصندوق');
    expect(bothNames({ nameAr: 'الصندوق', nameEn: '' }, 'en')).toBe('الصندوق');
  });
});

describe('codeAndName', () => {
  it('joins code and the localized name', () => {
    expect(codeAndName({ code: 'WH1', nameAr: 'رئيسي', nameEn: 'Main' }, 'en')).toBe('WH1 — Main');
    expect(codeAndName({ code: 'WH1', nameAr: 'رئيسي', nameEn: 'Main' }, 'ar')).toBe('WH1 — رئيسي');
  });

  it('returns undefined for a missing record', () => {
    expect(codeAndName(null)).toBeUndefined();
  });
});
