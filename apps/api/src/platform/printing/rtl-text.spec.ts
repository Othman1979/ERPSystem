import * as fontkit from 'fontkit';
import { FONT_FILES } from './fonts.js';
import { ltr, visualPieces, wrapLines } from './rtl-text.js';

describe('RTL text for pdfmake', () => {
  it('puts the words of an Arabic sentence right to left', () => {
    // logical: قائمة الدخل → visual, left to right: الدخل ␣ قائمة
    expect(visualPieces('قائمة الدخل', 'rtl')).toEqual(['الدخل', ' ', 'قائمة']);
  });

  it('keeps numbers and Latin codes left to right inside Arabic, with their spaces', () => {
    expect(visualPieces('فاتورة رقم SI-2025-000123 بمبلغ 1,234.500 دينار', 'rtl')).toEqual([
      'دينار',
      ' ',
      '1,234.500',
      ' ',
      'بمبلغ',
      ' ',
      'SI-2025-000123',
      ' ',
      'رقم',
      ' ',
      'فاتورة',
    ]);
  });

  it('keeps dates and signed amounts whole after Arabic (no 31-12-2025)', () => {
    expect(visualPieces('من 2025-01-01 إلى 2025-12-31', 'rtl')).toEqual([
      '2025-12-31',
      ' ',
      'إلى',
      ' ',
      '2025-01-01',
      ' ',
      'من',
    ]);
    expect(visualPieces('الرصيد -1,234.500', 'rtl')).toEqual(['-1,234.500', ' ', 'الرصيد']);
  });

  it('leaves Latin text in an LTR paragraph alone', () => {
    expect(visualPieces('Total 12.500', 'ltr')).toEqual(['Total', ' ', '12.500']);
  });

  it('mirrors brackets inside RTL runs', () => {
    // Logical "(الدخل)": the bracket at the right edge must look like "(".
    const pieces = visualPieces('(الدخل)', 'rtl');
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toBe(')الدخل(');
  });

  it('wraps on spaces by measured width', () => {
    const measure = (t: string) => t.length; // 1 pt per character
    expect(wrapLines('aa bb cc dd', 5, measure)).toEqual(['aa bb', 'cc dd']);
    expect(wrapLines('verylongword x', 4, measure)).toEqual(['verylongword', 'x']);
    expect(wrapLines('a\nb', 10, measure)).toEqual(['a', 'b']);
  });
});

describe('RTL text as fontkit draws it', () => {
  // What ends up on the page, left to right: each piece laid out by fontkit
  // (which itself reverses runs in RTL scripts), pieces in the order given.
  const font = fontkit.openSync(FONT_FILES.normal);
  const drawn = (pieces: string[]) =>
    pieces
      .flatMap((p) => font.layout(p).glyphs.flatMap((g) => g.codePoints))
      .map((cp) => String.fromCodePoint(cp))
      .join('');
  const rev = (s: string) => s.split('').reverse().join('');

  it('Arabic-Indic digits read in their order after an Arabic word', () => {
    expect(drawn(visualPieces('شارع ١٢٣', 'rtl'))).toBe(`١٢٣ ${rev('شارع')}`);
    expect(drawn(visualPieces('المبلغ ١٢٣٫٥٠', 'rtl'))).toBe(`١٢٣٫٥٠ ${rev('المبلغ')}`);
  });

  it('Latin digits and dates stay as written', () => {
    expect(drawn(visualPieces('شارع 123', 'rtl'))).toBe(`123 ${rev('شارع')}`);
    // (a word without lam: a ligature such as لى keeps its letters in logical order)
    expect(drawn(visualPieces('تاريخ 2025-12-31', 'rtl'))).toBe(`2025-12-31 ${rev('تاريخ')}`);
  });

  it('a phone number kept with ltr() is not split up', () => {
    expect(drawn(visualPieces(`الهاتف ${ltr('+962 6 555 1234')}`, 'rtl'))).toBe(`+962 6 555 1234 ${rev('الهاتف')}`);
  });
});

describe('Excel sheet names', () => {
  it('drops the characters Excel refuses and keeps 31 at most', async () => {
    const { sheetName } = await import('./report-table.js');
    expect(sheetName('item-ledger-A/100')).toBe('item-ledger-A-100');
    expect(sheetName('statement-C:01[x]*?\\')).toBe('statement-C-01-x-');
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
    expect(sheetName('///')).toBe('-');
    expect(sheetName("''")).toBe('report');
  });
});
