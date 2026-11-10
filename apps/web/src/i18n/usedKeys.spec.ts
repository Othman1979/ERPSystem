import { describe, expect, it } from 'vitest';
import { ar, en } from './locales';

// Every source file in the web app, as raw text (resolved by Vite at test time).
const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.spec.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

function lookup(dict: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      dict,
    );
}

/** Static keys passed as a string literal to t(), e.g. t('sales.totals'). */
function usedKeys(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'/g)) {
      found.push({ key: m[1], file });
    }
  }
  return found;
}

describe('i18n keys used in code', () => {
  it('finds the source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it.each([
    ['ar', ar],
    ['en', en],
  ] as const)('every static t() key exists in %s', (_lang, dict) => {
    const missing = usedKeys()
      .filter(({ key }) => typeof lookup(dict, key) !== 'string')
      .map(({ key, file }) => `${key} (${file})`);
    expect([...new Set(missing)]).toEqual([]);
  });
});
