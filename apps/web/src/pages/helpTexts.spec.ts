import { describe, expect, it } from 'vitest';
import { ar, en } from '../i18n/locales';
import { HELP_SECTIONS } from './HelpPage';
import { LEGAL_SECTIONS } from './LegalPage';

// The help and legal pages build their keys from these lists, which the
// static key check (usedKeys.spec) cannot see: every section needs its texts.
const text = (dict: unknown, key: string) =>
  key.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), dict);

describe('help and legal texts', () => {
  const keys = [
    ...HELP_SECTIONS.flatMap((s) => [`help.${s.id}.title`, `help.${s.id}.body`]),
    ...(['privacy', 'terms'] as const).flatMap((kind) => [
      `legal.${kind}.title`,
      `legal.${kind}.intro`,
      ...LEGAL_SECTIONS[kind].flatMap((id) => [`legal.${kind}.${id}.title`, `legal.${kind}.${id}.body`]),
    ]),
  ];

  it.each([
    ['ar', ar],
    ['en', en],
  ] as const)('every section has a title and a body in %s', (_lang, dict) => {
    const missing = keys.filter((k) => typeof text(dict, k) !== 'string' || (text(dict, k) as string).trim() === '');
    expect(missing).toEqual([]);
  });

  it('the legal pages say they are drafts awaiting legal review', () => {
    expect(String(text(ar, 'legal.draftNotice'))).toContain('مسودة');
    expect(String(text(en, 'legal.draftNotice'))).toContain('Draft');
  });
});
