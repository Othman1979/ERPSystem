import { L } from './report-table.js';

type Lang = 'ar' | 'en';

/** A date as yyyy-mm-dd (dates are calendar dates kept at UTC midnight). */
export function isoDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** "Period: from … to …" under a report title; open ends are left out. */
export function periodMeta(lang: Lang, from?: string | null, to?: string | null): string {
  const ctx = { lang };
  if (from && to) return `${L(ctx, 'الفترة', 'Period')}: ${L(ctx, 'من', 'from')} ${from} ${L(ctx, 'إلى', 'to')} ${to}`;
  if (from) return `${L(ctx, 'الفترة', 'Period')}: ${L(ctx, 'من', 'from')} ${from}`;
  if (to) return `${L(ctx, 'الفترة', 'Period')}: ${L(ctx, 'حتى', 'up to')} ${to}`;
  return `${L(ctx, 'الفترة', 'Period')}: ${L(ctx, 'كل الفترات', 'all dates')}`;
}

/** "As of …" under a report title. */
export function asOfMeta(lang: Lang, asOf: string): string {
  return `${L({ lang }, 'كما في', 'As of')} ${asOf}`;
}

/** The English name when asked for and present, else the Arabic one. */
export function localName(lang: Lang, nameAr: string, nameEn?: string | null): string {
  return lang === 'en' && nameEn ? nameEn : nameAr;
}

/** Debit / credit cells: an empty cell instead of 0. */
export function blankZero(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return /^-?0*(\.0*)?$/.test(value) ? '' : value;
}
