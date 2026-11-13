# Design tokens

Source: `apps/web/src/theme.ts`. It builds both the antd theme (`antdTheme`) and the
CSS custom properties (`cssVariables`, written onto `:root` by `installCssVariables()`
in `App.tsx`). `index.css` uses only `var(--…)`; it holds no hex colour outside
`@media print`. Decision and rationale: ADR-020.

## Ink

| Token | Value | Use |
|---|---|---|
| `ink-900` | `#172c48` | Top bar, pressed primary |
| `ink-600` | `#1f3a5f` | **Base.** Primary button (one per context), active tab and ink bar, selected menu marker, selected radio, switch, checkbox |
| `ink-500` | `#284a75` | Primary hover, links (underlined inside text) |
| `ink-200` | `#c5d1e0` | Subtle border of a selected item, text selection |
| `ink-100` | `#e8edf4` | Selected row, selected menu item, the row being edited in a grid |
| `on-ink` | `#fbfaf7` | Text and icons on ink (antd `colorWhite`, `colorTextLightSolid`) |
| `on-ink-muted` | `#c9d4e3` | Breadcrumb and quiet controls on the top bar |

**Not ink:** table headers (neutral blue-gray), tags and statuses (semantic), info
messages (`info`), secondary buttons, large areas other than the top bar, numbers
in tables, and the module icons on the home screen (`tone`).

## Neutrals (no pure white)

| Token | Value | Use |
|---|---|---|
| `canvas` | `#f4f2ee` | App background |
| `surface` | `#fbfaf7` | Cards, tables, inputs, documents |
| `surface-raised` | `#fdfcfa` | Dialogs, dropdowns, popovers |
| `panel` | `#eeebe5` | Document field panel, list toolbar, table totals, dialog footer |
| `border` | `#dcd8d0` | Decorative separators, card borders |
| `border-strong` | `#b9b4aa` | Table frame, grid lines, secondary buttons |
| `border-input` | `#838a96` | Input borders (3:1) |
| `border-input-panel` | `#7a818d` | Input borders on `panel` (DocFields, FormDialog, ListToolbar) |
| `text` | `#1d232b` | Body text |
| `text-2` | `#4e5764` | Secondary text, field labels, counts |
| `text-3` | `#5f6774` | Tertiary text: menu group titles, row numbers |
| `placeholder` | `#6b7380` | Input placeholders |

Never dim text with `opacity`; use `text-2` or `text-3`.

## Semantic

| Meaning | Text / icon | Background | Border |
|---|---|---|---|
| success | `#1e7a3c` | `#e6f2e9` | `#a9d2b4` |
| warning | `#8a5a00` | `#fbf0d9` | `#e8c77d` |
| danger | `#b42318` | `#fbe9e7` | `#efb4ad` |
| info | `#1f5f99` | `#e7f0f8` | `#b3cde6` |

antd's preset tag shades 1/3/7 for green, orange, gold, red, volcano, blue and cyan
are pinned to these, so `<Tag color="green">` passes AA. New code uses
`<StatusTag tone="success|warning|danger|info|neutral">` instead.

Overlays derive from tokens with `alpha()`: `on-ink-hover` (top-bar hover), `ink-hover` (text-button hover),
`focusHalo`, and `--shadow-float` (ink-900). Danger hover/pressed: `#9a1d13` / `#821910`. Teal tint for
the cyan tag: `#e3f1f1` / `#a6d3d4`.

Segmented controls: the selected option is a solid ink fill with on-ink text (like solid radio buttons);
keyboard focus uses the standard ring via `.ant-segmented-item-focused`. Selects on the top bar get
the light ring (`#9cc2ff`) on focus.

## Tables and grids

| Token | Value |
|---|---|
| `grid-head-bg` / `grid-head-text` | `#e3e7ec` / `#1d232b` |
| `grid-head-sort-bg` / `grid-head-hover-bg` | `#d9dee5` / `#dde2e8` |
| `grid-line` | `#dcd8d0` |
| `grid-frame` | `#b9b4aa` |
| `grid-zebra` | `#f7f5f1` (long reports only) |
| `grid-row-hover` | `#eef2f7` |
| `grid-row-selected` | `#e8edf4` (`ink-100`) |
| `grid-total-bg` | `#eeebe5` (`panel`) |

## Focus, shape, type

- Focus ring: `outline: 2px solid #2f6fd0; outline-offset: 2px` on everything a
  keyboard reaches (`:focus-visible`). On the ink top bar: `#9cc2ff`. Text inputs
  keep antd's ink border plus `rgba(47,111,208,.35)` halo instead.
- Radius: `4px` controls, `2px` kbd, `--radius-pill` for StatusBar chips only.
- Shadow: one, `--shadow-float`, for floating layers (dialogs, menus, pickers).
  Cards are flat.
- Font: IBM Plex Sans Arabic (`--font`) on `body` as well as antd. Sizes 12 / 13 /
  14 / 16 / 20 / 24; nothing under 11 px (`kbd` hints are 11 px Latin).

## Shared components

| Component | Rule |
|---|---|
| `DocField` | `<label for>` bound to the control's input; radio groups named by `aria-labelledby`; `aria-required`, `aria-invalid`, `aria-describedby` for errors |
| Lines grids | Each cell editor is named "column, line N" (`cellLabel`) |
| `Balance` | Credit balance: amount + «دائن» / "Cr"; red only on the wrong side of the account's normal balance |
| `drCrColumns` | Trial balance and statements: Dr and Cr columns |
| `ActiveTag` | Shows nothing for active; «غير نشط» / "Inactive" for inactive |
| `StatusTag` | Semantic tones only; types and categories are `neutral` |
| `openableRow` | `onRow` for rows that open a record: focusable, Enter/Space open, `aria-description` hint (`ui.openRowHint`) |
| Dates | Arabic month names are Levantine (`i18n/dayjsLocale.ts`) |

## Contrast

Computed with the WCAG 2.1 formula by `apps/web/src/theme.contrast.ts`
(`pnpm --filter api exec tsx ../web/src/theme.contrast.ts` prints this table). `theme.spec.ts`
fails if a pair drops below its minimum. Rows with minimum 1:1 are recorded for information: links
in text are underlined, so colour alone need not separate them from body text (WCAG 1.4.1).

| Use | Foreground | Background | Ratio | Minimum |
|---|---|---|---|---|
| text on surface | `#1d232b` | `#fbfaf7` | 15.16:1 | 4.5:1 |
| text on canvas | `#1d232b` | `#f4f2ee` | 14.15:1 | 4.5:1 |
| text on panel | `#1d232b` | `#eeebe5` | 13.30:1 | 4.5:1 |
| text on dialogs (surface-raised) | `#1d232b` | `#fdfcfa` | 15.43:1 | 4.5:1 |
| text on table header | `#1d232b` | `#e3e7ec` | 12.74:1 | 4.5:1 |
| text on hovered row | `#1d232b` | `#eef2f7` | 14.07:1 | 4.5:1 |
| text on selected row (ink-100) | `#1d232b` | `#e8edf4` | 13.45:1 | 4.5:1 |
| text on zebra row | `#1d232b` | `#f7f5f1` | 14.53:1 | 4.5:1 |
| text on sorted column header | `#1d232b` | `#d9dee5` | 11.70:1 | 4.5:1 |
| text on hovered column header | `#1d232b` | `#dde2e8` | 12.14:1 | 4.5:1 |
| on-ink on selected segment (ink-600) | `#fbfaf7` | `#1f3a5f` | 11.00:1 | 4.5:1 |
| selected segment vs track (panel) | `#1f3a5f` | `#eeebe5` | 9.65:1 | 3:1 |
| unselected segment text on track | `#1d232b` | `#eeebe5` | 13.30:1 | 4.5:1 |
| text-2 on surface | `#4e5764` | `#fbfaf7` | 7.01:1 | 4.5:1 |
| text-2 on canvas | `#4e5764` | `#f4f2ee` | 6.54:1 | 4.5:1 |
| text-2 on panel | `#4e5764` | `#eeebe5` | 6.15:1 | 4.5:1 |
| text-2 on table header | `#4e5764` | `#e3e7ec` | 5.89:1 | 4.5:1 |
| text-3 on surface | `#5f6774` | `#fbfaf7` | 5.47:1 | 4.5:1 |
| text-3 on canvas | `#5f6774` | `#f4f2ee` | 5.11:1 | 4.5:1 |
| text-3 on panel | `#5f6774` | `#eeebe5` | 4.80:1 | 4.5:1 |
| text-3 on table header | `#5f6774` | `#e3e7ec` | 4.60:1 | 4.5:1 |
| placeholder on input (surface) | `#6b7380` | `#fbfaf7` | 4.58:1 | 4.5:1 |
| on-ink on top bar (ink-900) | `#fbfaf7` | `#172c48` | 13.50:1 | 4.5:1 |
| on-ink on primary button (ink-600) | `#fbfaf7` | `#1f3a5f` | 11.00:1 | 4.5:1 |
| on-ink on primary hover (ink-500) | `#fbfaf7` | `#284a75` | 8.65:1 | 4.5:1 |
| on-ink-muted (breadcrumb) on top bar | `#c9d4e3` | `#172c48` | 9.40:1 | 4.5:1 |
| ink-600 (selected tab/menu) on surface | `#1f3a5f` | `#fbfaf7` | 11.00:1 | 4.5:1 |
| ink-600 on canvas | `#1f3a5f` | `#f4f2ee` | 10.27:1 | 4.5:1 |
| ink-600 on selected menu item (ink-100) | `#1f3a5f` | `#e8edf4` | 9.76:1 | 4.5:1 |
| ink-500 (link) on surface | `#284a75` | `#fbfaf7` | 8.65:1 | 4.5:1 |
| ink-500 (link) on panel | `#284a75` | `#eeebe5` | 7.59:1 | 4.5:1 |
| link vs body text (underlined; info only) | `#284a75` | `#1d232b` | 1.75:1 | 1:1 |
| link vs secondary text (underlined; info only) | `#284a75` | `#4e5764` | 1.23:1 | 1:1 |
| success on surface | `#1e7a3c` | `#fbfaf7` | 5.15:1 | 4.5:1 |
| success on success-bg (tag) | `#1e7a3c` | `#e6f2e9` | 4.67:1 | 4.5:1 |
| warning on surface | `#8a5a00` | `#fbfaf7` | 5.68:1 | 4.5:1 |
| warning on warning-bg (tag) | `#8a5a00` | `#fbf0d9` | 5.24:1 | 4.5:1 |
| danger on surface | `#b42318` | `#fbfaf7` | 6.30:1 | 4.5:1 |
| danger on danger-bg (tag, alert) | `#b42318` | `#fbe9e7` | 5.61:1 | 4.5:1 |
| danger on panel (field error) | `#b42318` | `#eeebe5` | 5.53:1 | 4.5:1 |
| info on surface | `#1f5f99` | `#fbfaf7` | 6.38:1 | 4.5:1 |
| info on info-bg (tag, alert) | `#1f5f99` | `#e7f0f8` | 5.77:1 | 4.5:1 |
| on-ink on danger button | `#fbfaf7` | `#b42318` | 6.30:1 | 4.5:1 |
| on-ink on danger button hover | `#fbfaf7` | `#9a1d13` | 7.86:1 | 4.5:1 |
| on-ink on danger button pressed | `#fbfaf7` | `#821910` | 9.60:1 | 4.5:1 |
| teal (cyan tag) on teal-bg | `#0b6e70` | `#e3f1f1` | 5.21:1 | 4.5:1 |
| on-ink on success fill | `#fbfaf7` | `#1e7a3c` | 5.15:1 | 4.5:1 |
| text on neutral tag (panel) | `#1d232b` | `#eeebe5` | 13.30:1 | 4.5:1 |
| tone finance on surface | `#1f3a5f` | `#fbfaf7` | 11.00:1 | 4.5:1 |
| tone trade on surface | `#0b6e70` | `#fbfaf7` | 5.78:1 | 4.5:1 |
| tone inventory on surface | `#a8461a` | `#fbfaf7` | 5.66:1 | 4.5:1 |
| tone admin on surface | `#5b6b7a` | `#fbfaf7` | 5.25:1 | 4.5:1 |
| input border on surface | `#838a96` | `#fbfaf7` | 3.33:1 | 3:1 |
| input border on canvas | `#838a96` | `#f4f2ee` | 3.11:1 | 3:1 |
| panel input border on panel | `#7a818d` | `#eeebe5` | 3.30:1 | 3:1 |
| panel input border on surface | `#7a818d` | `#fbfaf7` | 3.76:1 | 3:1 |
| selected radio / switch (ink-600) on surface | `#1f3a5f` | `#fbfaf7` | 11.00:1 | 3:1 |
| focus ring on surface | `#2f6fd0` | `#fbfaf7` | 4.67:1 | 3:1 |
| focus ring on canvas | `#2f6fd0` | `#f4f2ee` | 4.36:1 | 3:1 |
| focus ring on panel | `#2f6fd0` | `#eeebe5` | 4.10:1 | 3:1 |
| focus ring on selected row | `#2f6fd0` | `#e8edf4` | 4.15:1 | 3:1 |
| focus ring on ink (top bar) | `#9cc2ff` | `#172c48` | 7.77:1 | 3:1 |
