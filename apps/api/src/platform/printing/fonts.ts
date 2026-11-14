import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import type { Measure } from './rtl-text.js';
import { woffToSfnt } from './woff.js';

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

interface FontBytes {
  normal: Buffer;
  bold: Buffer;
}

let bytes: FontBytes | undefined;
let parsed: { normal: fontkit.Font; bold: fontkit.Font } | undefined;

/**
 * The two fonts as plain sfnt bytes, unwrapped from WOFF once per process
 * (woff.ts): pdfmake takes Buffers as they are, so each document parses
 * them without decompressing anything again.
 */
export function fontBytes(): FontBytes {
  bytes ??= {
    normal: woffToSfnt(readFileSync(FONT_FILES.normal)),
    bold: woffToSfnt(readFileSync(FONT_FILES.bold)),
  };
  return bytes;
}

/** Widths per em, by weight and text: wrapping measures the same words again and again. */
const widthCache = new Map<string, number>();

/** Width of `text` in points at `size`, with the font pdfmake draws it in. */
export function measureAt(size: number): Measure {
  if (!parsed) {
    const b = fontBytes();
    parsed = { normal: fontkit.create(b.normal) as fontkit.Font, bold: fontkit.create(b.bold) as fontkit.Font };
  }
  const fonts = parsed;
  return (text, bold) => {
    const key = `${bold ? 1 : 0}|${text}`;
    let units = widthCache.get(key);
    if (units === undefined) {
      const f = bold ? fonts.bold : fonts.normal;
      units = f.layout(text).advanceWidth / f.unitsPerEm;
      if (widthCache.size > 50_000) widthCache.clear();
      widthCache.set(key, units);
    }
    return units * size;
  };
}
