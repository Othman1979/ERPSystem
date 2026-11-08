import { DeleteOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Select, Typography } from 'antd';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

export interface JournalLineDraft {
  key: number;
  accountId?: string;
  debit?: number | null;
  credit?: number | null;
  description?: string;
}

export const emptyLine = (key: number): JournalLineDraft => ({ key });

interface Props {
  lines: JournalLineDraft[];
  onChange: (lines: JournalLineDraft[]) => void;
  accountOptions: { value: string; label: string }[];
}

/**
 * Excel-like journal lines grid: Enter on the last row appends a new line,
 * Enter elsewhere moves focus to the same column on the next row.
 */
export function JournalLinesGrid({ lines, onChange, accountOptions }: Props) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLTableElement>(null);
  const nextKey = useRef(lines.length);

  const update = (key: number, patch: Partial<JournalLineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length >= 2 ? next : [...next, emptyLine(Date.now())]);
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

  const onCellKeyDown = (e: React.KeyboardEvent, row: number, col: number) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if ((e.target as HTMLElement).closest('.ant-select')) return;
    e.preventDefault();
    if (row + 1 >= lines.length) {
      addRow();
      // Focus lands after React re-renders the new row.
      requestAnimationFrame(() => focusCell(row + 1, col));
    } else {
      focusCell(row + 1, col);
    }
  };

  const totalDebit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  const diff = Math.abs(totalDebit - totalCredit);

  const cellProps = (row: number, col: number) => ({
    'data-cell': `${row}-${col}`,
    onKeyDown: (e: React.KeyboardEvent) => onCellKeyDown(e, row, col),
  });

  return (
    <div>
      <table
        ref={gridRef}
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ background: '#fafafa' }}>
            <th style={thStyle}>#</th>
            <th style={thStyle}>{t('journal.account')}</th>
            <th style={{ ...thStyle, width: 120 }}>{t('journal.debit')}</th>
            <th style={{ ...thStyle, width: 120 }}>{t('journal.credit')}</th>
            <th style={thStyle}>{t('common.description')}</th>
            <th style={{ ...thStyle, width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, row) => (
            <tr key={l.key}>
              <td style={tdStyle}>{row + 1}</td>
              <td style={tdStyle} {...cellProps(row, 1)}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder={t('journal.account')}
                  options={accountOptions}
                  value={l.accountId}
                  onChange={(v) => update(l.key, { accountId: v })}
                  style={{ width: '100%' }}
                  size="small"
                />
              </td>
              <td style={tdStyle} {...cellProps(row, 2)}>
                <InputNumber
                  placeholder={t('journal.debit')}
                  min={0}
                  value={l.debit}
                  onChange={(v) => update(l.key, { debit: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td style={tdStyle} {...cellProps(row, 3)}>
                <InputNumber
                  placeholder={t('journal.credit')}
                  min={0}
                  value={l.credit}
                  onChange={(v) => update(l.key, { credit: v })}
                  style={{ width: '100%' }}
                  size="small"
                  controls={false}
                />
              </td>
              <td style={tdStyle} {...cellProps(row, 4)}>
                <Input
                  placeholder={t('common.description')}
                  maxLength={500}
                  value={l.description}
                  onChange={(e) => update(l.key, { description: e.target.value })}
                  size="small"
                />
              </td>
              <td style={{ ...tdStyle, textAlign: 'center' }}>
                {lines.length > 2 && (
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
        <tfoot>
          <tr style={{ background: '#f6f6f6', fontWeight: 600 }}>
            <td style={tdStyle} colSpan={2}>
              {t('journal.total')}
            </td>
            <td style={{ ...tdStyle, textAlign: 'right' }}>
              {totalDebit.toFixed(3)}
            </td>
            <td style={{ ...tdStyle, textAlign: 'right' }}>
              {totalCredit.toFixed(3)}
            </td>
            <td style={tdStyle} colSpan={2}>
              {diff > 0.0005 && (
                <Typography.Text type="danger">
                  {t('journal.unbalanced', { amount: diff.toFixed(3) })}
                </Typography.Text>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
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
