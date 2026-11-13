import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { antdTheme, cssVariables, fieldPanelTheme, installCssVariables, palette } from './theme';
import { CONTRAST_PAIRS, contrastRatio } from './theme.contrast';

// The stylesheet as text. (Vitest stubs CSS imports, ?raw included, so read the file;
// tests run from apps/web.)
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
/** The rules outside comments and outside @media print (paper stays white). */
const screenCss = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@media print\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

const PURE_WHITE = /^(#fff|#ffffff|white|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)])/i;

/** Every string leaf of a nested object, with its dotted path. */
function leaves(obj: object, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string' ? [[`${prefix}${k}`, v]] : v && typeof v === 'object' ? leaves(v, `${prefix}${k}.`) : [],
  );
}

describe('design tokens: contrast (UI-03, UI-04, UI-06)', () => {
  it('computes WCAG ratios correctly', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    // Values from the review (§6): ink on surface 11.00, text on surface 15.16.
    expect(contrastRatio(palette.ink600, palette.surface)).toBeCloseTo(11.0, 1);
    expect(contrastRatio(palette.text, palette.surface)).toBeCloseTo(15.16, 1);
  });

  it.each(CONTRAST_PAIRS.map((p) => [p.use, p] as const))('%s meets its minimum', (_use, pair) => {
    expect(contrastRatio(pair.fg, pair.bg)).toBeGreaterThanOrEqual(pair.min);
  });
});

describe('design tokens: no pure white on screen (owner direction)', () => {
  it('the palette has no white', () => {
    const white = leaves(palette).filter(([, v]) => PURE_WHITE.test(v));
    expect(white).toEqual([]);
  });

  it("antd's resolved surfaces and 'white' tokens are warm, not #fff", () => {
    const t = theme.getDesignToken(antdTheme);
    for (const key of [
      'colorBgContainer',
      'colorBgElevated',
      'colorBgLayout',
      'colorWhite',
      'colorTextLightSolid',
    ] as const) {
      expect(t[key], key).not.toMatch(PURE_WHITE);
    }
    expect(t.colorBgContainer).toBe(palette.surface);
    expect(t.colorBgElevated).toBe(palette.surfaceRaised);
    expect(t.colorPrimary).toBe(palette.ink600);
  });

  it('index.css uses white only inside @media print', () => {
    // `white` as a colour value, not the white-space property.
    expect(screenCss).not.toMatch(/#fff\b|#ffffff\b|:\s*white\b|\swhite\s*[;!)]|255,\s*255,\s*255/i);
  });
});

describe('antd semantic and preset colours pass AA', () => {
  const t = theme.getDesignToken(antdTheme);

  it.each(['Success', 'Warning', 'Error', 'Info'] as const)('color%s text on its background', (kind) => {
    const fg = t[`color${kind}Text`];
    const bg = t[`color${kind}Bg`];
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  // Tag color="green" etc. draws shade 7 on shade 1 (antd genPresetColor).
  it.each(['green', 'orange', 'gold', 'red', 'volcano', 'blue', 'cyan'] as const)(
    'Tag color="%s" text on its background',
    (c) => {
      expect(contrastRatio(t[`${c}7`], t[`${c}1`])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('panel inputs keep 3:1 against the panel', () => {
    const border = fieldPanelTheme.token?.colorBorder as string;
    expect(contrastRatio(border, palette.panel)).toBeGreaterThanOrEqual(3);
  });
});

describe('CSS variables are generated from the palette (UI-20)', () => {
  it('every var(--…) in index.css is defined by cssVariables', () => {
    const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((name) => !(name in cssVariables))).toEqual([]);
  });

  it('index.css repeats no hex colour outside print', () => {
    expect(screenCss.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });

  it('maps palette keys to kebab-case names', () => {
    expect(cssVariables['--c-ink-600']).toBe(palette.ink600);
    expect(cssVariables['--c-on-ink-muted']).toBe(palette.onInkMuted);
    expect(cssVariables['--c-text-2']).toBe(palette.text2);
    expect(cssVariables['--c-grid-head-bg']).toBe(palette.grid.headBg);
    expect(cssVariables['--c-tone-trade']).toBe(palette.tone.trade);
  });

  it('installCssVariables writes them onto :root', () => {
    const root = document.createElement('div');
    installCssVariables(root);
    expect(root.style.getPropertyValue('--c-surface')).toBe(palette.surface);
    expect(root.style.getPropertyValue('--topbar-height')).toBe('44px');
  });
});
