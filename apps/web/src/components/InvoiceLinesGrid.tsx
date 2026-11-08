import { DeleteOutlined } from '@ant-design/icons';
import { Button, InputNumber, Select } from 'antd';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface InvoiceItemOption {
  id: string;
  label: string;
  /** Default sale (or purchase) price per base unit. */
  price?: number | null;
  /** Tax rate percent (0–100). */
  taxRate: number;
  itemKind: 'STOCK' | 'SERVICE';
}

export interface InvoiceLineDraft {
  key: number;
  itemId?: string;
  qty?: number | null;
  price?: number | null;
  discountPct?: number | null;
}

export const emptyInvoiceLine = (key: number): InvoiceLineDraft => ({ key });

interface Props {
  lines: InvoiceLineDraft[];
  onChange: (lines: InvoiceLineDraft[]) => void;
  itemOptions: InvoiceItemOption[];
  /** Column header for the price field (unit price vs unit cost). */
  priceLabel?: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

interface Amounts {
  net: number;
  tax: number;
  total: number;
}

function lineAmounts(l: InvoiceLineDraft, items: InvoiceItemOption[]): Amounts {
  const item = items.find((i) => i.id === l.itemId);
  const qty = l.qty ?? 0;
  const price = l.price ?? item?.price ?? 0;
  const gross = qty * price;
  const discount = r2((gross * (l.discountPct ?? 0)) / 100);
  const net = r2(gross - discount);
  const tax = r2((net * (item?.taxRate ?? 0)) / 100);
  return { net, tax, total: r2(net + tax) };
}

/**
 * Excel-like invoice lines grid: item, qty, price, discount% editable;
 * net/tax/total computed live (estimate — server computes authoritative
 * totals). Enter moves row-major; last cell of last row appends a line.
 */
export function InvoiceLinesGrid({ lines, onChange, itemOptions, priceLabel }: Props) {
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
    const cell = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`);
    if (!cell) return;
    const select = cell.querySelector<HTMLElement>('.ant-select-selector');
    if (select) {
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return;
    }
    cell.querySelector<HTMLElement>('input')?.focus();
  };

  // 0=# 1=item 2=qty 3=price 4=discount 5=net 6=tax 7=total 8=del
  const NAV_COLS = [1, 2, 3, 4];

  const onCellKeyDown = (e: React.KeyboardEvent, row: number, col: number) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    if (target.closest('.ant-select-open')) return;
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
      requestAnimationFrame(() => focusCell(nextRow, NAV_COLS[0]));
    } else {
      focusCell(nextRow, NAV_COLS[nextColPos]);
    }
  };

  const cellProps = (row: number, col: number) => ({
    'data-cell': `${row}-${col}`,
    onKeyDown: (e: React.KeyboardEvent) => onCellKeyDown(e, row, col),
  });

  const totals = lines.reduce(
    (acc, l) => {
      const a = lineAmounts(l, itemOptions);
      return { net: acc.net + a.net, tax: acc.tax + a.tax, total: acc.total + a.total };
    },
    { net: 0, tax: 0, total: 0 },
  );

  const fmt = (v: number) => v.toFixed(2);

  return (
    <table ref={gridRef} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ background: '#fafafa' }}>
          <th style={thStyle}>#</th>
          <th style={thStyle}>{t('items.title')}</th>
          <th style={{ ...thStyle, width: 90 }}>{t('stock.qty')}</th>
          <th style={{ ...thStyle, width: 110 }}>{priceLabel ?? t('sales.unitPrice')}</th>
          <th style={{ ...thStyle, width: 90 }}>{t('sales.discountPct')}</th>
          <th style={{ ...thStyle, width: 100 }}>{t('sales.net')}</th>
          <th style={{ ...thStyle, width: 90 }}>{t('sales.tax')}</th>
          <th style={{ ...thStyle, width: 110 }}>{t('sales.total')}</th>
          <th style={{ ...thStyle, width: 40 }} />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, row) => {
          const a = lineAmounts(l, itemOptions);
          return (
            <tr key={l.key}>
              <td style={tdStyle}>{row + 1}</td>
              <td style={tdStyle} {...cellProps(row, 1)}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder={t('items.title')}
                  options={itemOptions.map((o) => ({
                    value: o.id,
                    label: `${o.label}${o.price != null ? ` — ${o.price}` : ''}`,
                  }))}
                  value={l.itemId}
                  onChange={(v) => {
                    const item = itemOptions.find((o) => o.id === v);
                    update(l.key, {
                      itemId: v,
                      ...(l.price == null && item?.price != null ? { price: item.price } : {}),
                    });
                  }}
                  style={{ width: '100%' }}
                  size="small"
                />
              </td>
              <td style={tdStyle} {...cellProps(row, 2)}>
                <InputNumber
                  min={0.000001}
                  value={l.qty}
                  onChange={(v) => update(l.key, { qty: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td style={tdStyle} {...cellProps(row, 3)}>
                <InputNumber
                  min={0}
                  value={l.price}
                  onChange={(v) => update(l.key, { price: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td style={tdStyle} {...cellProps(row, 4)}>
                <InputNumber
                  min={0}
                  max={100}
                  value={l.discountPct}
                  onChange={(v) => update(l.key, { discountPct: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td style={{ ...tdStyle, textAlign: 'end' }}>{fmt(a.net)}</td>
              <td style={{ ...tdStyle, textAlign: 'end' }}>{fmt(a.tax)}</td>
              <td style={{ ...tdStyle, textAlign: 'end', fontWeight: 600 }}>{fmt(a.total)}</td>
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
          );
        })}
      </tbody>
      <tfoot>
        <tr style={{ background: '#fafafa' }}>
          <td colSpan={5} style={{ ...tdStyle, textAlign: 'end', fontWeight: 600 }}>
            {t('sales.totals')}
          </td>
          <td style={{ ...tdStyle, textAlign: 'end', fontWeight: 600 }}>{fmt(totals.net)}</td>
          <td style={{ ...tdStyle, textAlign: 'end', fontWeight: 600 }}>{fmt(totals.tax)}</td>
          <td style={{ ...tdStyle, textAlign: 'end', fontWeight: 700 }}>{fmt(totals.total)}</td>
          <td />
        </tr>
      </tfoot>
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
