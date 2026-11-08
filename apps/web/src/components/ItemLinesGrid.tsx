import { DeleteOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GridSelect, isSelectDropdownOpen } from './GridSelect';

export interface ItemLineDraft {
  key: number;
  itemId?: string;
  qty?: number | null;
  unitCost?: number | null;
  description?: string;
}

export const emptyItemLine = (key: number): ItemLineDraft => ({ key });

interface Props {
  lines: ItemLineDraft[];
  onChange: (lines: ItemLineDraft[]) => void;
  itemOptions: { value: string; label: string }[];
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
    const cell = gridRef.current?.querySelector<HTMLElement>(
      `[data-cell="${row}-${col}"]`,
    );
    if (!cell) return;
    const select = cell.querySelector<HTMLElement>('.ant-select-selector');
    if (select) {
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return;
    }
    cell.querySelector<HTMLElement>('input')?.focus();
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

  const focusSoon = (row: number, col: number) => {
    requestAnimationFrame(() => {
      focusCell(row, col);
      setTimeout(() => focusCell(row, col), 60); // retry if row not yet rendered
    });
  };

  useEffect(() => {
    if (focusSignal) focusSoon(0, NAV_COLS[0]);
  }, [focusSignal]);

  const onCellKeyDown = (e: React.KeyboardEvent, row: number, col: number) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // Let an open item dropdown handle Enter (selects the option);
    // a closed select navigates like any other cell.
    if (isSelectDropdownOpen()) return;
    e.preventDefault();

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

  const cellProps = (row: number, col: number) => ({
    'data-cell': `${row}-${col}`,
    onKeyDown: (e: React.KeyboardEvent) => onCellKeyDown(e, row, col),
  });

  return (
    <table
      ref={gridRef}
      style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
    >
      <thead>
        <tr style={{ background: '#fafafa' }}>
          <th style={thStyle}>#</th>
          <th style={thStyle}>{t('items.title')}</th>
          <th style={{ ...thStyle, width: 110 }}>{t('stock.qty')}</th>
          {showCost && <th style={{ ...thStyle, width: 120 }}>{t('stock.unitCost')}</th>}
          {showDescription && <th style={thStyle}>{t('common.description')}</th>}
          <th style={{ ...thStyle, width: 40 }} />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, row) => (
          <tr key={l.key}>
            <td style={tdStyle}>{row + 1}</td>
            <td style={tdStyle} {...cellProps(row, COL_ITEM)}>
              <GridSelect
                placeholder={t('items.title')}
                options={itemOptions}
                value={l.itemId}
                onChange={(v) => update(l.key, { itemId: v })}
                style={{ width: '100%' }}
                size="small"
              />
            </td>
            <td style={tdStyle} {...cellProps(row, COL_QTY)}>
              <InputNumber
                min={0.000001}
                placeholder={t('stock.qty')}
                value={l.qty}
                onChange={(v) => update(l.key, { qty: v })}
                style={{ width: '100%' }}
                size="small"
                controls={false}
              />
            </td>
            {showCost && (
              <td style={tdStyle} {...cellProps(row, COL_COST)}>
                <InputNumber
                  min={0}
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
              <td style={tdStyle} {...cellProps(row, COL_DESC)}>
                <Input
                  placeholder={t('common.description')}
                  maxLength={500}
                  value={l.description}
                  onChange={(e) => update(l.key, { description: e.target.value })}
                  size="small"
                />
              </td>
            )}
            <td style={{ ...tdStyle, textAlign: 'center' }}>
              {lines.length > 1 && (
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => remove(l.key)}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'start',
  padding: '6px 8px',
  borderBottom: '1px solid #f0f0f0',
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #f5f5f5',
  verticalAlign: 'middle',
};
