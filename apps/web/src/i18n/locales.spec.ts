import { describe, expect, it } from 'vitest';
import { ar, en } from './locales';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('i18n locales', () => {
  it('ar and en have identical key sets', () => {
    expect(flattenKeys(ar).sort()).toEqual(flattenKeys(en).sort());
  });
});
