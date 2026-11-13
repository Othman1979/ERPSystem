import { DeleteOutlined } from '@ant-design/icons';
import { Button, InputNumber } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { lineAmounts, type LineAmounts } from '../format/invoiceMath';
import { formatAmount, sum } from '../format/number';
import { GridHint } from './GridHint';
import { focusCellEl, GridSelect, isSelectDropdownOpen } from './GridSelect';
import { Num } from './Num';
import { cellLabel } from './gridA11y';

export interface InvoiceItemOption {
  id: string;
  label: string;
  /** Default sale (or purchase) price per base unit, as a decimal string. */
  price?: string | null;
  /** Tax rate percent (0–100), as a decimal string. */
  taxRate: string;
  itemKind: 'STOCK' | 'SERVICE';
}

/** Editable line; numeric fields are decimal strings (InputNumber stringMode). */
export interface InvoiceLineDraft {
  key: number;
  itemId?: string;
  qty?: string | null;
  price?: string | null;
  discountPct?: string | null;
}

export const emptyInvoiceLine = (key: number): InvoiceLineDraft => ({ key });

interface Props {
  lines: InvoiceLineDraft[];
  onChange: (lines: InvoiceLineDraft[]) => void;
  itemOptions: InvoiceItemOption[];
  /** Column header for the price field (unit price vs unit cost). */
  priceLabel?: string;
  /** Increment to auto-focus the first cell (e.g. when a form opens). */
  focusSignal?: number;
}

function amountsFor(l: InvoiceLineDraft, items: InvoiceItemOption[]): LineAmounts {
  const item = items.find((i) => i.id === l.itemId);
  return lineAmounts({
    qty: l.qty,
    price: l.price ?? item?.price,
    discountPct: l.discountPct,
    taxRate: item?.taxRate,
  });
}

/**
 * Excel-like invoice lines grid: item, qty, price, discount% editable;
 * net/tax/total computed live (estimate — server computes authoritative
 * totals). Enter moves row-major; last cell of last row appends a line.
 */
export function InvoiceLinesGrid({ lines, onChange, itemOptions, priceLabel, focusSignal }: Props) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLTableElement>(null);
  const nextKey = useRef(lines.length);

  const update = (key: number, patch: Partial<InvoiceLineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length >= 1 ? next : [emptyInvoiceLine(Date.now())]);
  };

  const addRow = () => {
    nextKey.current += 1;
    onChange([...lines, { key: nextKey.current }]);
  };

  const focusCell = (row: number, col: number) => {
    focusCellEl(gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`));
  };

  // 0=# 1=item 2=qty 3=price 4=discount 5=net 6=tax 7=total 8=del
  const NAV_COLS = [1, 2, 3, 4];

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

  const lineTotals = lines.map((l) => amountsFor(l, itemOptions));
  const discountTotal = sum(lineTotals.map((a) => a.discount));
  const totals = {
    net: sum(lineTotals.map((a) => a.net)),
    tax: sum(lineTotals.map((a) => a.tax)),
    total: sum(lineTotals.map((a) => a.total)),
  };

  return (
    <div className="entry-grid-frame">
    <div className="entry-grid-scroll">
    <table ref={gridRef} className="entry-grid">
      <thead>
        <tr>
          <th className="row-no">#</th>
          <th>{t('items.title')}</th>
          <th className="num-cell" style={{ width: 90 }}>{t('stock.qty')}</th>
          <th className="num-cell" style={{ width: 110 }}>{priceLabel ?? t('sales.unitPrice')}</th>
          <th className="num-cell" style={{ width: 90 }}>{t('sales.discountPct')}</th>
          <th className="num-cell" style={{ width: 100 }}>{t('sales.net')}</th>
          <th className="num-cell" style={{ width: 90 }}>{t('sales.tax')}</th>
          <th className="num-cell" style={{ width: 110 }}>{t('sales.total')}</th>
          <th style={{ width: 36 }} />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, row) => {
          const a = lineTotals[row];
          return (
            <tr key={l.key}>
              <td className="row-no">{row + 1}</td>
              <td {...cellProps(row, 1)}>
                <GridSelect
                  aria-label={cellLabel(t, t('items.title'), row)}
                  variant="borderless"
                  placeholder={t('items.title')}
                  options={itemOptions.map((o) => ({
                    value: o.id,
                    label: `${o.label}${o.price != null ? ` — ${formatAmount(o.price)}` : ''}`,
                  }))}
                  value={l.itemId}
                  onChange={(v) => {
                    const item = itemOptions.find((o) => o.id === v);
                    update(l.key, {
                      itemId: v,
                      ...(l.price == null && item?.price != null ? { price: item.price } : {}),
                    });
                  }}
                  onEnterSelect={() => advance(row, 1)}
                  style={{ width: '100%' }}
                  size="small"
                />
              </td>
              <td className="num-cell" {...cellProps(row, 2)}>
                <InputNumber<string>
                  aria-label={cellLabel(t, t('stock.qty'), row)}
                  variant="borderless"
                  stringMode
                  min="0.000001"
                  value={l.qty}
                  onChange={(v) => update(l.key, { qty: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td className="num-cell" {...cellProps(row, 3)}>
                <InputNumber<string>
                  aria-label={cellLabel(t, priceLabel ?? t('sales.unitPrice'), row)}
                  variant="borderless"
                  stringMode
                  min="0"
                  value={l.price}
                  onChange={(v) => update(l.key, { price: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td className="num-cell" {...cellProps(row, 4)}>
                <InputNumber<string>
                  aria-label={cellLabel(t, t('sales.discountPct'), row)}
                  variant="borderless"
                  stringMode
                  min="0"
                  max="100"
                  value={l.discountPct}
                  onChange={(v) => update(l.key, { discountPct: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td className="num-cell">
                <Num>{formatAmount(a.net)}</Num>
              </td>
              <td className="num-cell">
                <Num>{formatAmount(a.tax)}</Num>
              </td>
              <td className="num-cell" style={{ fontWeight: 600 }}>
                <Num>{formatAmount(a.total)}</Num>
              </td>
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
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={5} style={{ textAlign: 'end', fontWeight: 600 }}>
            {t('sales.totals')}
          </td>
          <td className="num-cell" style={{ fontWeight: 600 }}>
            <Num>{formatAmount(totals.net)}</Num>
          </td>
          <td className="num-cell" style={{ fontWeight: 600 }}>
            <Num>{formatAmount(totals.tax)}</Num>
          </td>
          <td className="num-cell" style={{ fontWeight: 700 }}>
            <Num>{formatAmount(totals.total)}</Num>
          </td>
          <td />
        </tr>
      </tfoot>
    </table>
    </div>
    <div className="entry-grid-footer">
    <GridHint lineCount={lines.filter((l) => l.itemId).length} />
    {/* Document totals, read at a glance (preview — the server recomputes on save) */}
    <dl className="invoice-summary">
      <div>
        <dt>{t('sales.subtotal')}</dt>
        <dd><Num>{formatAmount(totals.net.plus(discountTotal))}</Num></dd>
      </div>
      {!discountTotal.isZero() && (
        <div>
          <dt>{t('sales.discount')}</dt>
          <dd><Num>-{formatAmount(discountTotal)}</Num></dd>
        </div>
      )}
      <div>
        <dt>{t('sales.net')}</dt>
        <dd><Num>{formatAmount(totals.net)}</Num></dd>
      </div>
      <div>
        <dt>{t('sales.tax')}</dt>
        <dd><Num>{formatAmount(totals.tax)}</Num></dd>
      </div>
      <div className="invoice-summary-grand">
        <dt>{t('sales.grandTotal')}</dt>
        <dd><Num>{formatAmount(totals.total)}</Num></dd>
      </div>
    </dl>
    </div>
    </div>
  );
}


