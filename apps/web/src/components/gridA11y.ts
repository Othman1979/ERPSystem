import type { TFunction } from 'i18next';

/**
 * Accessible name of a lines-grid cell editor (UI-02): its column header and
 * the 1-based line number, e.g. "Qty, line 3" / «الكمية، السطر 3». A grid's
 * inputs have no visible label of their own, so screen readers need this.
 */
export function cellLabel(t: TFunction, column: string, row: number): string {
  return t('ui.cellLabel', { column, line: row + 1 });
}
