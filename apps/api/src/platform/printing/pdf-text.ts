import { measureAt } from './fonts.js';
import { hasRtl, visualPieces, wrapLines } from './rtl-text.js';

export type Align = 'left' | 'right' | 'center';

/**
 * A paragraph for pdfmake that reads correctly in Arabic, English or both:
 * wrapped to `width` points by us, each line in visual order (rtl-text.ts).
 * Every line is `noWrap`, so pdfmake never re-wraps it in logical order.
 */
export function paragraph(
  text: string | null | undefined,
  opts: { width: number; size?: number; bold?: boolean; align?: Align; base?: 'rtl' | 'ltr'; color?: string },
): object {
  const size = opts.size ?? 9;
  const value = text ?? '';
  const base = opts.base ?? (hasRtl(value) ? 'rtl' : 'ltr');
  const align = opts.align ?? (base === 'rtl' ? 'right' : 'left');
  const style = { fontSize: size, bold: opts.bold ?? false, ...(opts.color ? { color: opts.color } : {}) };
  if (!hasRtl(value)) {
    return { text: value, alignment: align, ...style };
  }
  const lines = wrapLines(value, Math.max(opts.width, 10), measureAt(size), style.bold);
  return {
    stack: lines.map((line) => ({
      text: visualPieces(line, base).map((p) => ({ text: p })),
      alignment: align,
      noWrap: true,
    })),
    ...style,
  };
}
