import { palette } from './theme';

/**
 * WCAG 2.1 contrast of every colour pair the design system relies on. The
 * spec (theme.spec.ts) fails if any pair drops below its minimum, and
 * docs/design/tokens.md lists the computed ratios
 * (`pnpm --filter api exec tsx ../web/src/theme.contrast.ts` prints the table).
 */

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** Contrast ratio between two #rrggbb colours (1 – 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  use: string;
  fg: string;
  bg: string;
  /** 4.5 for text, 3 for large text and non-text (borders, focus rings, icons). */
  min: 4.5 | 3;
}

const p = palette;
const g = palette.grid;

export const CONTRAST_PAIRS: ContrastPair[] = [
  // Body text
  { use: 'text on surface', fg: p.text, bg: p.surface, min: 4.5 },
  { use: 'text on canvas', fg: p.text, bg: p.canvas, min: 4.5 },
  { use: 'text on panel', fg: p.text, bg: p.panel, min: 4.5 },
  { use: 'text on dialogs (surface-raised)', fg: p.text, bg: p.surfaceRaised, min: 4.5 },
  { use: 'text on table header', fg: g.headText, bg: g.headBg, min: 4.5 },
  { use: 'text on hovered row', fg: p.text, bg: g.rowHover, min: 4.5 },
  { use: 'text on selected row (ink-100)', fg: p.text, bg: g.rowSelected, min: 4.5 },
  { use: 'text on zebra row', fg: p.text, bg: g.zebra, min: 4.5 },
  { use: 'text-2 on surface', fg: p.text2, bg: p.surface, min: 4.5 },
  { use: 'text-2 on canvas', fg: p.text2, bg: p.canvas, min: 4.5 },
  { use: 'text-2 on panel', fg: p.text2, bg: p.panel, min: 4.5 },
  { use: 'text-2 on table header', fg: p.text2, bg: g.headBg, min: 4.5 },
  { use: 'text-3 on surface', fg: p.text3, bg: p.surface, min: 4.5 },
  { use: 'text-3 on canvas', fg: p.text3, bg: p.canvas, min: 4.5 },
  { use: 'text-3 on panel', fg: p.text3, bg: p.panel, min: 4.5 },
  { use: 'text-3 on table header', fg: p.text3, bg: g.headBg, min: 4.5 },
  { use: 'placeholder on input (surface)', fg: p.placeholder, bg: p.surface, min: 4.5 },
  // Ink
  { use: 'on-ink on top bar (ink-900)', fg: p.onInk, bg: p.ink900, min: 4.5 },
  { use: 'on-ink on primary button (ink-600)', fg: p.onInk, bg: p.ink600, min: 4.5 },
  { use: 'on-ink on primary hover (ink-500)', fg: p.onInk, bg: p.ink500, min: 4.5 },
  { use: 'on-ink-muted (breadcrumb) on top bar', fg: p.onInkMuted, bg: p.ink900, min: 4.5 },
  { use: 'ink-600 (selected tab/menu) on surface', fg: p.ink600, bg: p.surface, min: 4.5 },
  { use: 'ink-600 on canvas', fg: p.ink600, bg: p.canvas, min: 4.5 },
  { use: 'ink-600 on selected menu item (ink-100)', fg: p.ink600, bg: p.ink100, min: 4.5 },
  { use: 'ink-500 (link) on surface', fg: p.ink500, bg: p.surface, min: 4.5 },
  { use: 'ink-500 (link) on panel', fg: p.ink500, bg: p.panel, min: 4.5 },
  // Semantic
  { use: 'success on surface', fg: p.success, bg: p.surface, min: 4.5 },
  { use: 'success on success-bg (tag)', fg: p.success, bg: p.successBg, min: 4.5 },
  { use: 'warning on surface', fg: p.warning, bg: p.surface, min: 4.5 },
  { use: 'warning on warning-bg (tag)', fg: p.warning, bg: p.warningBg, min: 4.5 },
  { use: 'danger on surface', fg: p.danger, bg: p.surface, min: 4.5 },
  { use: 'danger on danger-bg (tag, alert)', fg: p.danger, bg: p.dangerBg, min: 4.5 },
  { use: 'danger on panel (field error)', fg: p.danger, bg: p.panel, min: 4.5 },
  { use: 'info on surface', fg: p.info, bg: p.surface, min: 4.5 },
  { use: 'info on info-bg (tag, alert)', fg: p.info, bg: p.infoBg, min: 4.5 },
  { use: 'on-ink on danger button', fg: p.onInk, bg: p.danger, min: 4.5 },
  { use: 'on-ink on success fill', fg: p.onInk, bg: p.success, min: 4.5 },
  { use: 'text on neutral tag (panel)', fg: p.text, bg: p.panel, min: 4.5 },
  // Module tones (home-screen icons next to their label)
  { use: 'tone finance on surface', fg: p.tone.finance, bg: p.surface, min: 4.5 },
  { use: 'tone trade on surface', fg: p.tone.trade, bg: p.surface, min: 4.5 },
  { use: 'tone inventory on surface', fg: p.tone.inventory, bg: p.surface, min: 4.5 },
  { use: 'tone admin on surface', fg: p.tone.admin, bg: p.surface, min: 4.5 },
  // Non-text: control boundaries and focus (WCAG 1.4.11)
  { use: 'input border on surface', fg: p.borderInput, bg: p.surface, min: 3 },
  { use: 'input border on canvas', fg: p.borderInput, bg: p.canvas, min: 3 },
  { use: 'panel input border on panel', fg: p.borderInputPanel, bg: p.panel, min: 3 },
  { use: 'panel input border on surface', fg: p.borderInputPanel, bg: p.surface, min: 3 },
  { use: 'selected radio / switch (ink-600) on surface', fg: p.ink600, bg: p.surface, min: 3 },
  { use: 'focus ring on surface', fg: p.focus, bg: p.surface, min: 3 },
  { use: 'focus ring on canvas', fg: p.focus, bg: p.canvas, min: 3 },
  { use: 'focus ring on panel', fg: p.focus, bg: p.panel, min: 3 },
  { use: 'focus ring on selected row', fg: p.focus, bg: g.rowSelected, min: 3 },
  { use: 'focus ring on ink (top bar)', fg: p.focusOnInk, bg: p.ink900, min: 3 },
];

// `pnpm --filter api exec tsx ../web/src/theme.contrast.ts` prints the table for docs/design/tokens.md.
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('theme.contrast.ts')) {
  console.log('| Use | Foreground | Background | Ratio | Minimum |');
  console.log('|---|---|---|---|---|');
  for (const pair of CONTRAST_PAIRS) {
    const r = contrastRatio(pair.fg, pair.bg).toFixed(2);
    console.log(`| ${pair.use} | \`${pair.fg}\` | \`${pair.bg}\` | ${r}:1 | ${pair.min}:1 |`);
  }
}
