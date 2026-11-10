import * as bidiModule from 'bidi-js';

// bidi-js ships CommonJS with an ES-style `export default` in its types; under
// NodeNext the factory is the namespace's `default` at runtime.
type BidiFactory = typeof import('bidi-js').default;
const bidiFactory: BidiFactory =
  (bidiModule as unknown as { default?: BidiFactory }).default ?? (bidiModule as unknown as BidiFactory);

/**
 * Arabic / mixed text for pdfmake (BUILD_PLAN §17 phase 8: "Arabic PDF shows
 * text, numbers and direction correctly").
 *
 * pdfmake has no bidi support: it splits text into words and lays them out
 * left to right in logical order, while fontkit shapes each word and
 * reverses the glyphs of a word written in an RTL script. So a sentence
 * comes out with its words in the wrong order and the spaces next to
 * numbers misplaced. This module does what pdfmake does not:
 *  1. break a paragraph into lines (we measure with the same font);
 *  2. run the Unicode Bidirectional Algorithm (UAX #9, via bidi-js) on
 *     each line, mirror brackets in RTL runs;
 *  3. hand pdfmake the pieces of each line in VISUAL order, left to right:
 *     words, numbers and spaces as separate inlines. An Arabic word is
 *     passed in logical order, because fontkit reverses it when it draws.
 */
const bidi = bidiFactory();

/** Letters of right-to-left scripts (Hebrew, Arabic and their presentation forms). */
const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

export const hasRtl = (text: string) => STRONG_RTL.test(text);

const LRI = '⁦';
const PDI = '⁩';
/** Invisible bidi controls: never drawn (the font has no glyph for them). */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;
/** A number or Latin code with inner separators, optionally signed: 2025-12-31, SI-1/A, -1,234.500, 12:30. */
const LTR_TOKEN = /-?[A-Za-z0-9]+(?:[-/.:,][A-Za-z0-9]+)+|-\d+(?:\.\d+)?/g;

type Kind = 'space' | 'rtl' | 'ltr';

/**
 * One line, already short enough to fit, as pieces in visual order (left →
 * right). `base` is the paragraph direction: Arabic documents are 'rtl'.
 */
export function visualPieces(input: string, base: 'rtl' | 'ltr'): string[] {
  if (input === '') return [];
  // Dates, document numbers and amounts ("2025-12-31", "SI-2025-000123",
  // "-1,234.500") read left to right as one unit. Without this, digits right
  // after Arabic letters count as Arabic numbers (UAX #9 W2) and a date
  // would show as "31-12-2025". Isolates (LRI … PDI) keep them whole.
  const line = input.replace(LTR_TOKEN, (t) => `${LRI}${t}${PDI}`);
  const levels = bidi.getEmbeddingLevels(line, base);
  // Brackets in RTL runs show mirrored (UAX #9 L4). bidi-js 1.1's map helper
  // returns nothing here, so mirror character by character.
  const chars = line
    .split('')
    .map((c, i) => (levels.levels[i] & 1 ? (bidi.getMirroredCharacter(c) ?? c) : c));

  const order = chars.map((_, i) => i);
  for (const [start, end] of bidi.getReorderSegments(line, levels)) {
    const flipped = order.slice(start, end + 1).reverse();
    order.splice(start, flipped.length, ...flipped);
  }

  const kindOf = (i: number): Kind => (/\s/.test(line[i]) ? 'space' : levels.levels[i] & 1 ? 'rtl' : 'ltr');
  const pieces: string[] = [];
  let run: number[] = [];
  let runKind: Kind | null = null;
  const flush = () => {
    if (run.length === 0) return;
    let text = run
      .map((i) => chars[i])
      .join('')
      .replace(BIDI_CONTROLS, '');
    if (text === '') {
      run = [];
      return;
    }
    // The run is in visual order. fontkit reverses words of RTL scripts on its
    // own, so give it those in logical order; neutrals (".", "-") it leaves as is.
    if (runKind === 'rtl' && hasRtl(text)) text = text.split('').reverse().join('');
    pieces.push(text);
    run = [];
  };
  for (const i of order) {
    const k = kindOf(i);
    if (k !== runKind || k === 'space') {
      flush();
      runKind = k;
    }
    run.push(i);
  }
  flush();
  return pieces;
}

/** Measures text in points (font size included). */
export type Measure = (text: string, bold: boolean) => number;

/**
 * Greedy line breaking on spaces, in logical order; a word longer than the
 * width stays on its own line. Explicit newlines start a new line.
 */
export function wrapLines(text: string, width: number, measure: Measure, bold = false): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (line && measure(candidate, bold) > width) {
        out.push(line);
        line = w;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}
