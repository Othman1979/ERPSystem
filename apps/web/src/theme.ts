import type { ThemeConfig } from 'antd';

/**
 * The design tokens: one source for antd (antdTheme) and for plain CSS
 * (cssVariables → `--c-*` custom properties, installed by installCssVariables).
 * Components use these tokens, never hex codes. See docs/design/tokens.md
 * for the contrast table and the rules for where each colour may be used.
 *
 * Direction (owner, 2026-11-13): "ink" is the signature colour; warm surfaces;
 * no pure white anywhere on screen (print stays white: paper is white).
 */

/** Ink scale. `ink600` is the base (primary buttons, active tab, selection marker). */
const ink = {
  ink900: '#172c48', // top bar, pressed primary
  ink600: '#1f3a5f', // base
  ink500: '#284a75', // hover, links
  ink200: '#c5d1e0', // subtle border of a selected item
  ink100: '#e8edf4', // selected row / menu item / radio option
  onInk: '#fbfaf7', // text and icons on ink
  onInkMuted: '#c9d4e3', // breadcrumb and inactive items on the top bar
} as const;

/** Warm neutrals. */
const neutral = {
  canvas: '#f4f2ee', // app background
  surface: '#fbfaf7', // cards, tables, inputs, documents
  surfaceRaised: '#fdfcfa', // dialogs, dropdowns, popovers
  panel: '#eeebe5', // document field panel, list toolbar, table footer
  border: '#dcd8d0', // decorative separators and card borders
  borderStrong: '#b9b4aa', // table frame, grid lines, secondary buttons
  borderInput: '#838a96', // input borders: 3:1 against surface (WCAG 1.4.11)
  borderInputPanel: '#7a818d', // input borders on the panel
  text: '#1d232b',
  text2: '#4e5764', // secondary text
  text3: '#5f6774', // tertiary text: group titles, hints, counts
  placeholder: '#6b7380',
} as const;

/** Semantic colours; every text colour passes 4.5:1 on its own background and on surface. */
const semantic = {
  success: '#1e7a3c',
  successBg: '#e6f2e9',
  successBorder: '#a9d2b4',
  warning: '#8a5a00',
  warningBg: '#fbf0d9',
  warningBorder: '#e8c77d',
  danger: '#b42318',
  dangerBg: '#fbe9e7',
  dangerBorder: '#efb4ad',
  info: '#1f5f99',
  infoBg: '#e7f0f8',
  infoBorder: '#b3cde6',
} as const;

const focus = {
  focus: '#2f6fd0', // focus ring on surface / canvas
  focusOnInk: '#9cc2ff', // focus ring on the top bar and primary buttons
  focusHalo: 'rgba(47, 111, 208, 0.35)', // antd input halo
} as const;

export const palette = {
  ...ink,
  ...neutral,
  ...semantic,
  ...focus,
  /** Tables and data-entry grids. */
  grid: {
    headBg: '#e3e7ec',
    headText: neutral.text,
    line: neutral.border,
    frame: neutral.borderStrong,
    zebra: '#f7f5f1',
    rowHover: '#eef2f7',
    rowSelected: ink.ink100,
    rowSelectedHover: '#dde5ef',
    totalBg: neutral.panel,
  },
  /** Home-screen colour per module group (icons and dots only). */
  tone: {
    finance: ink.ink600,
    trade: '#0b6e70',
    inventory: '#a8461a',
    admin: '#5b6b7a',
  },
} as const;

export const TOPBAR_HEIGHT = 44;

export const FONT_FAMILY = "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";

const MONO_FAMILY = "Consolas, 'Cascadia Mono', 'Courier New', monospace";

/**
 * CSS custom properties for index.css, generated from the palette so the two
 * can never drift apart (UI-20). Keys are `--c-<kebab-name>`.
 */
export const cssVariables: Record<string, string> = (() => {
  const kebab = (s: string) => s.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`);
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(palette)) {
    if (typeof value === 'string') vars[`--c-${kebab(key)}`] = value;
  }
  for (const [key, value] of Object.entries(palette.grid)) vars[`--c-grid-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(palette.tone)) vars[`--c-tone-${kebab(key)}`] = value;
  vars['--topbar-height'] = `${TOPBAR_HEIGHT}px`;
  vars['--font'] = FONT_FAMILY;
  vars['--font-mono'] = MONO_FAMILY;
  vars['--radius'] = '4px';
  vars['--radius-sm'] = '2px';
  vars['--radius-pill'] = '999px';
  // The only shadow: floating layers (dialogs, menus). Cards sit flat (UI-09).
  vars['--shadow-float'] = '0 6px 16px rgba(23, 44, 72, 0.12), 0 1px 3px rgba(23, 44, 72, 0.08)';
  return vars;
})();

/** Writes cssVariables onto :root. Called once, before the first render. */
export function installCssVariables(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(cssVariables)) root.style.setProperty(name, value);
}

/**
 * antd's preset tag colours (Tag color="green" …) fail AA with their defaults
 * (green 3.37:1, orange 3.34:1, gold 2.76:1). Pin the shades a Tag uses
 * (1 = background, 3 = border, 7 = text) to the semantic tokens.
 */
const presetTagShades = {
  green1: semantic.successBg,
  green3: semantic.successBorder,
  green7: semantic.success,
  orange1: semantic.warningBg,
  orange3: semantic.warningBorder,
  orange7: semantic.warning,
  gold1: semantic.warningBg,
  gold3: semantic.warningBorder,
  gold7: semantic.warning,
  red1: semantic.dangerBg,
  red3: semantic.dangerBorder,
  red7: semantic.danger,
  volcano1: semantic.dangerBg,
  volcano3: semantic.dangerBorder,
  volcano7: semantic.danger,
  blue1: semantic.infoBg,
  blue3: semantic.infoBorder,
  blue7: semantic.info,
  cyan1: '#e3f1f1',
  cyan3: '#a6d3d4',
  cyan7: palette.tone.trade,
} as const;

export const antdTheme: ThemeConfig = {
  token: {
    // Ink
    colorPrimary: ink.ink600,
    colorPrimaryHover: ink.ink500,
    colorPrimaryActive: ink.ink900,
    colorPrimaryBg: ink.ink100,
    colorPrimaryBgHover: palette.grid.rowSelectedHover,
    colorPrimaryBorder: ink.ink200,
    colorPrimaryBorderHover: ink.ink500,
    colorPrimaryText: ink.ink600,
    colorPrimaryTextHover: ink.ink500,
    colorPrimaryTextActive: ink.ink900,
    colorLink: ink.ink500,
    colorLinkHover: ink.ink600,
    colorLinkActive: ink.ink900,
    // "White" in antd (button text, switch knob, check marks) is the warm on-ink tone.
    colorTextLightSolid: ink.onInk,
    colorWhite: ink.onInk,
    // Semantic
    colorSuccess: semantic.success,
    colorSuccessBg: semantic.successBg,
    colorSuccessBorder: semantic.successBorder,
    colorSuccessText: semantic.success,
    colorWarning: semantic.warning,
    colorWarningBg: semantic.warningBg,
    colorWarningBorder: semantic.warningBorder,
    colorWarningText: semantic.warning,
    colorError: semantic.danger,
    colorErrorBg: semantic.dangerBg,
    colorErrorBorder: semantic.dangerBorder,
    colorErrorText: semantic.danger,
    colorErrorHover: '#9a1d13',
    colorErrorActive: '#821910',
    colorInfo: semantic.info,
    colorInfoBg: semantic.infoBg,
    colorInfoBorder: semantic.infoBorder,
    colorInfoText: semantic.info,
    // Surfaces: nothing renders pure white.
    colorBgLayout: neutral.canvas,
    colorBgContainer: neutral.surface,
    colorBgElevated: neutral.surfaceRaised,
    colorBgSpotlight: ink.ink900, // tooltips
    colorFillAlter: neutral.panel,
    colorBorder: neutral.borderInput,
    colorBorderSecondary: neutral.border,
    colorSplit: neutral.border,
    // Text
    colorText: neutral.text,
    colorTextHeading: neutral.text,
    colorTextSecondary: neutral.text2,
    colorTextTertiary: neutral.text3,
    colorTextDescription: neutral.text2,
    colorTextLabel: neutral.text2,
    colorTextPlaceholder: neutral.placeholder,
    colorIcon: neutral.text2,
    colorIconHover: neutral.text,
    // Focus
    controlOutline: focus.focusHalo,
    controlOutlineWidth: 2,
    // Shape and type
    borderRadius: 4,
    borderRadiusSM: 2,
    fontFamily: FONT_FAMILY,
    fontFamilyCode: MONO_FAMILY,
    boxShadow: cssVariables['--shadow-float'],
    boxShadowSecondary: cssVariables['--shadow-float'],
    ...presetTagShades,
  },
  components: {
    Layout: {
      headerBg: ink.ink900,
      siderBg: neutral.surface,
      lightSiderBg: neutral.surface,
      bodyBg: neutral.canvas,
    },
    Menu: {
      itemBg: neutral.surface,
      subMenuItemBg: neutral.surface,
      itemColor: neutral.text,
      itemHoverBg: palette.grid.rowHover,
      itemHoverColor: neutral.text,
      itemActiveBg: ink.ink100,
      itemSelectedBg: ink.ink100,
      itemSelectedColor: ink.ink600,
      groupTitleColor: neutral.text3,
      groupTitleFontSize: 12,
      itemBorderRadius: 4,
    },
    Button: {
      defaultBg: neutral.surface,
      defaultBorderColor: neutral.borderStrong,
      defaultColor: neutral.text,
      defaultHoverBg: palette.grid.rowHover,
      defaultHoverBorderColor: ink.ink500,
      defaultHoverColor: ink.ink600,
      defaultActiveBg: ink.ink100,
      defaultActiveBorderColor: ink.ink600,
      defaultActiveColor: ink.ink900,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      textHoverBg: 'rgba(31, 58, 95, 0.08)',
    },
    Card: { headerBg: 'transparent', colorBorderSecondary: neutral.border },
    Table: {
      headerBg: palette.grid.headBg,
      headerColor: palette.grid.headText,
      headerSplitColor: palette.grid.frame,
      headerBorderRadius: 0,
      headerSortActiveBg: '#d9dee5',
      headerSortHoverBg: '#dde2e8',
      bodySortBg: palette.grid.zebra,
      borderColor: palette.grid.line,
      rowHoverBg: palette.grid.rowHover,
      rowSelectedBg: palette.grid.rowSelected,
      rowSelectedHoverBg: palette.grid.rowSelectedHover,
      rowExpandedBg: palette.grid.zebra,
      footerBg: palette.grid.totalBg,
      // Compact rows (~32px) for dense lists.
      cellPaddingBlock: 6,
      cellPaddingInline: 10,
      cellPaddingBlockMD: 5,
      cellPaddingBlockSM: 4,
    },
    Tabs: {
      itemColor: neutral.text2,
      itemHoverColor: ink.ink500,
      itemSelectedColor: ink.ink600,
      itemActiveColor: ink.ink900,
      inkBarColor: ink.ink600,
    },
    Radio: {
      buttonSolidCheckedBg: ink.ink600,
      buttonSolidCheckedHoverBg: ink.ink500,
      buttonSolidCheckedActiveBg: ink.ink900,
      buttonSolidCheckedColor: ink.onInk,
      buttonBg: neutral.surface,
    },
    Select: {
      optionSelectedBg: ink.ink100,
      optionSelectedColor: neutral.text,
      optionActiveBg: palette.grid.rowHover,
    },
    Segmented: {
      trackBg: neutral.panel,
      itemSelectedBg: neutral.surfaceRaised,
      itemSelectedColor: ink.ink600,
      itemColor: neutral.text2,
    },
    Modal: {
      contentBg: neutral.surfaceRaised,
      headerBg: neutral.surfaceRaised,
      footerBg: neutral.panel,
    },
    Drawer: { colorBgElevated: neutral.surfaceRaised },
    Tag: { defaultBg: neutral.panel, defaultColor: neutral.text },
    // The off track is translucent gray by default (~1.6:1); give it the input border.
    Switch: { colorTextQuaternary: neutral.borderInput, colorTextTertiary: neutral.text3 },
    Steps: { navArrowColor: neutral.text3 },
    Alert: { withDescriptionPadding: '12px 16px' },
  },
};

/**
 * Field panels (document header fields, dialog forms) sit on `panel`, so their
 * inputs take the panel input border to keep 3:1 there.
 */
export const fieldPanelTheme: ThemeConfig = {
  token: { colorBorder: neutral.borderInputPanel },
};
