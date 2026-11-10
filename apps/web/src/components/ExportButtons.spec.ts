import { describe, expect, it } from 'vitest';
import { filenameFromDisposition } from '@erp/api-client';
import { apiLang, queryString } from './ExportButtons';

describe('report export helpers', () => {
  it('builds the query string from the set filters only', () => {
    expect(queryString({ from: '2026-01-01', to: undefined, accountId: '', format: 'pdf' })).toBe(
      '?from=2026-01-01&format=pdf',
    );
    expect(queryString({ from: undefined })).toBe('');
  });

  it('sends Arabic unless the UI is English', () => {
    expect(apiLang('en')).toBe('en');
    expect(apiLang('ar')).toBe('ar');
    expect(apiLang('fr')).toBe('ar');
  });

  it.each([
    ['attachment; filename="income-statement-2026-01-01-2026-12-31.pdf"', 'income-statement-2026-01-01-2026-12-31.pdf'],
    ['attachment; filename=trial-balance.xlsx', 'trial-balance.xlsx'],
    ["attachment; filename=\"x.pdf\"; filename*=UTF-8''%D9%81%D8%A7%D8%AA%D9%88%D8%B1%D8%A9.pdf", 'فاتورة.pdf'],
  ])('reads the file name from %s', (header, name) => {
    expect(filenameFromDisposition(header)).toBe(name);
  });

  it('has no file name without the header', () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('attachment')).toBeNull();
  });
});
