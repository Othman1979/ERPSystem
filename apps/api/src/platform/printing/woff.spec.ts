import { readFileSync } from 'node:fs';
import * as fontkit from 'fontkit';
import { FONT_FILES, fontBytes } from './fonts.js';
import { woffToSfnt } from './woff.js';

describe('woffToSfnt', () => {
  const SAMPLES = ['فاتورة مبيعات رقم 123', 'Sales invoice SI-2025-000123', 'الكمية: 1,234.500 — Qty', 'ﻣﺮﺣﺒﺎ ١٢٣'];

  it.each(['normal', 'bold'] as const)('%s: unwrapped bytes lay out exactly like the WOFF file', (weight) => {
    const viaWoff = fontkit.openSync(FONT_FILES[weight]);
    const viaSfnt = fontkit.create(woffToSfnt(readFileSync(FONT_FILES[weight])));
    expect(viaSfnt.unitsPerEm).toBe(viaWoff.unitsPerEm);
    for (const text of SAMPLES) {
      const a = viaWoff.layout(text);
      const b = viaSfnt.layout(text);
      expect(b.advanceWidth).toBe(a.advanceWidth);
      expect(b.glyphs.map((g) => g.id)).toEqual(a.glyphs.map((g) => g.id));
    }
  });

  it('is plain TrueType: no WOFF signature, 4-byte aligned tables', () => {
    const sfnt = woffToSfnt(readFileSync(FONT_FILES.normal));
    expect(sfnt.toString('latin1', 0, 4)).not.toBe('wOFF');
    expect(sfnt.readUInt32BE(0)).toBe(0x00010000);
    expect(sfnt.length % 4).toBe(0);
  });

  it('refuses bytes that are not WOFF', () => {
    expect(() => woffToSfnt(Buffer.from('not a font at all, just some text that is long enough to pass'))).toThrow(/WOFF/);
  });

  it('unwraps once per process', () => {
    expect(fontBytes()).toBe(fontBytes());
  });
});
