import path from 'node:path';
import * as fontkit from 'fontkit';
import type { Measure } from './rtl-text.js';

/**
 * IBM Plex Sans Arabic (OFL-1.1, same family as the web, ADR-002): one
 * file per weight with both Arabic and Latin glyphs. `assets/` sits next
 * to `src/` and `dist/`, so the path is the same from both.
 */
export const FONT_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'assets', 'fonts');
export const FONT_FILES = {
  normal: path.join(FONT_DIR, 'IBMPlexSansArabic-Regular.woff'),
  bold: path.join(FONT_DIR, 'IBMPlexSansArabic-Bold.woff'),
};
export const FONT_NAME = 'Plex';

let fonts: { normal: fontkit.Font; bold: fontkit.Font } | undefined;
/** Widths per em, by weight and text: wrapping measures the same words again and again. */
const widthCache = new Map<string, number>();

/** Width of `text` in points at `size`, with the font pdfmake draws it in. */
export function measureAt(size: number): Measure {
  fonts ??= { normal: fontkit.openSync(FONT_FILES.normal), bold: fontkit.openSync(FONT_FILES.bold) };
  return (text, bold) => {
    const key = `${bold ? 1 : 0}|${text}`;
    let units = widthCache.get(key);
    if (units === undefined) {
      const f = bold ? fonts!.bold : fonts!.normal;
      units = f.layout(text).advanceWidth / f.unitsPerEm;
      if (widthCache.size > 50_000) widthCache.clear();
      widthCache.set(key, units);
    }
    return units * size;
  };
}
