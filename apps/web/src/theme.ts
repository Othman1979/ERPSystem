import type { ThemeConfig } from 'antd';

/**
 * One place for the app's colours (Windows-style palette, primary #0078d4 —
 * see docs/decisions/ADR-002). Components use these tokens instead of hex codes.
 */
export const palette = {
  primary: '#0078d4',
  primaryHover: '#106ebe',
  primaryDark: '#005a9e',
  canvas: '#f3f3f3',
  surface: '#ffffff',
  border: '#e1e1e1',
  borderStrong: '#d1d1d1',
  rowLine: '#edebe9',
  headerBg: '#f5f5f5',
  zebra: '#fafafa',
  hover: '#e5f1fb',
  text: '#323130',
  textMuted: '#605e5c',
  textOnPrimary: '#ffffff',
  textOnPrimaryMuted: 'rgba(255, 255, 255, 0.72)',
  danger: '#c42b1c',
  success: '#107c10',
  successBg: '#dff6dd',
  successBorder: '#8fd18f',
  /** Grids and tables (owner-chosen palette): gray panels, blue-gray header bars. */
  grid: {
    panel: '#eeeeee',
    panelHi: '#fafafa',
    bar: '#d3dce3',
    barHi: '#f2f4f6',
    barText: '#1b2a36',
    line: '#c0c0c0',
    border: '#aaaaaa',
  },
  /** Home-screen tile colour per module group. */
  tone: {
    finance: '#0078d4',
    trade: '#038387',
    inventory: '#ca5010',
    admin: '#5b6b7a',
  },
} as const;

export const TOPBAR_HEIGHT = 44;

export const FONT_FAMILY =
  "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif";

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.primary,
    colorInfo: palette.primary,
    colorBorder: palette.border,
    colorBgLayout: palette.canvas,
    borderRadius: 4,
    fontFamily: FONT_FAMILY,
  },
  components: {
    Layout: { headerBg: palette.primary, siderBg: palette.surface, bodyBg: palette.canvas },
    Menu: { itemBg: palette.surface, itemSelectedBg: palette.hover, itemSelectedColor: palette.primaryDark },
    Card: { headerBg: 'transparent' },
    Table: {
      headerBg: palette.grid.bar,
      headerColor: palette.grid.barText,
      headerSplitColor: palette.grid.border,
      headerBorderRadius: 0,
      borderColor: palette.grid.line,
      rowHoverBg: palette.hover,
      footerBg: palette.grid.panel,
      // Compact rows (~32px) for dense lists.
      cellPaddingBlock: 6,
      cellPaddingInline: 10,
      cellPaddingBlockMD: 5,
      cellPaddingBlockSM: 4,
    },
  },
};
