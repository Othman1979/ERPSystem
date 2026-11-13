/**
 * Every API error code has an Arabic and an English message in the web app
 * (LEDGER-15; CLAUDE.md «أضف ترجمة كل كود جديد في الويب»). Without one the
 * user sees the raw code, or a generic fallback that hides the cause.
 *
 * Reads apps/web/src/i18n/locales.ts as text: the api and web packages do not
 * import each other.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ErrorCode } from '../../src/common/errors/error-codes.js';

const LOCALES = path.resolve(import.meta.dirname, '..', '..', '..', 'web', 'src', 'i18n', 'locales.ts');

/** Keys of each top-level `errors: { … }` block, in file order (ar first, then en). */
function errorBlocks(source: string): Set<string>[] {
  const blocks: Set<string>[] = [];
  const re = /^ {2}errors: \{\r?\n([\s\S]*?)^ {2}\},?\r?$/gm;
  for (const m of source.matchAll(re)) {
    blocks.push(new Set([...m[1].matchAll(/^ {4}([A-Z0-9_]+):/gm)].map((k) => k[1])));
  }
  return blocks;
}

describe('Error code translations — static guard', () => {
  const blocks = errorBlocks(readFileSync(LOCALES, 'utf8'));

  it('finds the ar and en error blocks', () => {
    expect(blocks).toHaveLength(2);
  });

  it.each([
    ['ar', 0],
    ['en', 1],
  ])('every ErrorCode has a %s message', (_lang, index) => {
    const missing = Object.values(ErrorCode).filter((code) => !blocks[index].has(code));
    expect(missing).toEqual([]);
  });
});
