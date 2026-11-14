import { DeleteOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GridHint } from './GridHint';
import { focusCellEl, GridSelect, isSelectDropdownOpen } from './GridSelect';
import { cellLabel } from './gridA11y';

export interface ItemLineDraft {
  key: number;
  itemId?: string;
  // Decimal strings (InputNumber stringMode), never JS floats.
  qty?: string | null;
  unitCost?: string | null;
  description?: string;
}

export const emptyItemLine = (key: number): ItemLineDraft => ({ key });

interface Props {
  lines: ItemLineDraft[];
  onChange: (lines: ItemLineDraft[]) => void;
  itemOptions: { value: string; label: string }[];
  /** Server search of the item picker (ADR-022 §8); without it the options are filtered locally. */
  onItemSearch?: (text: string) => void;
  /** Show the unit-cost column (adjustments IN/OPENING). */
  showCost?: boolean;
  /** Show the per-line description column. */
  showDescription?: boolean;
  /** Increment to auto-focus the first cell (e.g. when a form opens). */
  focusSignal?: number;
}

/**
 * Excel-like item lines grid: Enter on the last row appends a line, Enter
 * elsewhere moves focus to the same column on the next row.
 */
export function ItemLinesGrid({
  lines,
  onChange,
  itemOptions,
  onItemSearch,
  showCost = false,
  showDescription = false,
  focusSignal,
}: Props) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLTableElement>(null);
  const nextKey = useRef(lines.length);

  const update = (key: number, patch: Partial<ItemLineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length >= 1 ? next : [emptyItemLine(Date.now())]);
  };

  const addRow = () => {
    nextKey.current += 1;
    onChange([...lines, { key: nextKey.current }]);
  };

  const focusCell = (row: number, col: number) => {
    focusCellEl(
      gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`),
    );
  };

  // Column indexes for focus navigation (0 = row number, skipped).
  const COL_ITEM = 1;
  const COL_QTY = 2;
  const COL_COST = showCost ? 3 : -1;
  const COL_DESC = showDescription ? (showCost ? 4 : 3) : -1;

  // Ordered editable columns for row-major Enter navigation.
  const NAV_COLS = [
    COL_ITEM,
    COL_QTY,
    ...(COL_COST !== -1 ? [COL_COST] : []),
    ...(COL_DESC !== -1 ? [COL_DESC] : []),
  ];

  // Focus once the cell exists; retry a single time if a new row hasn't rendered yet.
  // (Focusing twice re-opened a select's list after the user had moved on.)
  const focusSoon = (row: number, col: number) => {
    requestAnimationFrame(() => {
      if (gridRef.current?.querySelector(`[data-cell="${row}-${col}"]`)) focusCell(row, col);
      else setTimeout(() => focusCell(row, col), 60);
    });
  };

  useEffect(() => {
    if (focusSignal) focusSoon(0, NAV_COLS[0]);
  }, [focusSignal]);

  const advance = (row: number, col: number) => {
    const colPos = NAV_COLS.indexOf(col);
    let nextRow = row;
    let nextColPos = colPos + 1;
    if (nextColPos >= NAV_COLS.length) {
      nextRow += 1;
      nextColPos = 0;
    }
    if (nextRow >= lines.length) {
      addRow();
      focusSoon(nextRow, NAV_COLS[0]);
    } else {
      focusCell(nextRow, NAV_COLS[nextColPos]);
    }
  };

  const onCellKeyDown = (e: React.KeyboardEvent, row: number, col: number) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // An open dropdown handles Enter itself: it selects the highlighted
    // option and GridSelect's onEnterSelect advances to the next cell.
    if (isSelectDropdownOpen(e.currentTarget)) return;
    e.preventDefault();
    advance(row, col);
  };

  // Arrow-key navigation (capture phase so InputNumber's step-on-arrow and
  // the select's dropdown-open don't swallow the keys). Select cells keep
  // vertical arrows for their dropdown; horizontal arrows move columns.
  const onCellKeyDownCapture = (e: React.KeyboardEvent, row: number, col: number) => {
    if (e.nativeEvent.isComposing || isSelectDropdownOpen(e.currentTarget)) return;
    const key = e.key;
    if (!key.startsWith('Arrow')) return;
    const colPos = NAV_COLS.indexOf(col);
    if (colPos === -1) return;
    const isSelectCell = !!e.currentTarget.querySelector('.ant-select');
    if (isSelectCell && (key === 'ArrowUp' || key === 'ArrowDown')) return;

    let nr = row;
    let nc = colPos;
    if (key === 'ArrowLeft') nc -= 1;
    else if (key === 'ArrowRight') nc += 1;
    else if (key === 'ArrowUp') nr -= 1;
    else nr += 1;
    if (nr < 0 || nr >= lines.length || nc < 0 || nc >= NAV_COLS.length) return;

    e.preventDefault();
    e.stopPropagation();
    focusCell(nr, NAV_COLS[nc]);
  };

  const cellProps = (row: number, col: number) => ({
    'data-cell': `${row}-${col}`,
    onKeyDownCapture: (e: React.KeyboardEvent) => onCellKeyDownCapture(e, row, col),
    onKeyDown: (e: React.KeyboardEvent) => onCellKeyDown(e, row, col),
  });

  return (
    <div className="entry-grid-frame">
    <div className="entry-grid-scroll">
    <table
      ref={gridRef} className="entry-grid"
    >
      <thead>
        <tr>
          <th className="row-no">#</th>
          <th>{t('items.title')}</th>
          <th className="num-cell" style={{ width: 110 }}>{t('stock.qty')}</th>
          {showCost && <th className="num-cell" style={{ width: 120 }}>{t('stock.unitCost')}</th>}
          {showDescription && <th>{t('common.description')}</th>}
          <th style={{ width: 36 }} />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, row) => (
          <tr key={l.key}>
            <td className="row-no">{row + 1}</td>
            <td {...cellProps(row, COL_ITEM)}>
              <GridSelect
                aria-label={cellLabel(t, t('items.title'), row)}
                variant="borderless"
                placeholder={t('items.title')}
                options={itemOptions}
                onRemoteSearch={onItemSearch}
                value={l.itemId}
                onChange={(v) => update(l.key, { itemId: v })}
                onEnterSelect={() => advance(row, COL_ITEM)}
                style={{ width: '100%' }}
                size="small"
              />
            </td>
            <td className="num-cell" {...cellProps(row, COL_QTY)}>
              <InputNumber<string>
                aria-label={cellLabel(t, t('stock.qty'), row)}
                variant="borderless"
                stringMode
                min="0.000001"
                placeholder={t('stock.qty')}
                value={l.qty}
                onChange={(v) => update(l.key, { qty: v })}
                style={{ width: '100%' }}
                size="small"
                controls={false}
              />
            </td>
            {showCost && (
              <td className="num-cell" {...cellProps(row, COL_COST)}>
                <InputNumber<string>
                  aria-label={cellLabel(t, t('stock.unitCost'), row)}
                  variant="borderless"
                  stringMode
                  min="0"
                  placeholder={t('stock.unitCost')}
                  value={l.unitCost}
                  onChange={(v) => update(l.key, { unitCost: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
            )}
            {showDescription && (
              <td {...cellProps(row, COL_DESC)}>
                <Input
                  aria-label={cellLabel(t, t('common.description'), row)}
                  variant="borderless"
                  placeholder={t('common.description')}
                  maxLength={500}
                  value={l.description}
                  onChange={(e) => update(l.key, { description: e.target.value })}
                  size="small"
                />
              </td>
            )}
            <td style={{ textAlign: 'center' }}>
              {lines.length > 1 && (
                <Button
                  className="row-del"
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={t('common.delete')}
                  onClick={() => remove(l.key)}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
    <div className="entry-grid-footer">
      <GridHint lineCount={lines.filter((l) => l.itemId).length} />
    </div>
    </div>
  );
}

