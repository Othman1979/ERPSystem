import { DeleteOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Typography } from 'antd';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAmount, round3, sum } from '../format/number';
import { GridHint } from './GridHint';
import { focusCellEl, GridSelect, isSelectDropdownOpen } from './GridSelect';
import { Num } from './Num';
import { cellLabel } from './gridA11y';

export interface JournalLineDraft {
  key: number;
  accountId?: string;
  // Decimal strings (InputNumber stringMode), never JS floats.
  debit?: string | null;
  credit?: string | null;
  description?: string;
  /** Customer / supplier of a control-account line (party column only). */
  partyId?: string;
}

export const emptyLine = (key: number): JournalLineDraft => ({ key });

export type PartyKind = 'CUSTOMER' | 'SUPPLIER';

type Option = { value: string; label: string };

/** Party column: control-account lines (customers / suppliers) need a party. */
export interface PartyColumn {
  /** Party kind each control account requires; other accounts take no party. */
  kindByAccount: Map<string, PartyKind>;
  options: Record<PartyKind, Option[]>;
  /** Server search for each kind's picker (ADR-022 §8): every typed text goes here. */
  onSearch: Record<PartyKind, (text: string) => void>;
}

/** The party kind an account's control type requires, if any. */
export function partyKindOf(controlType: string | null | undefined): PartyKind | undefined {
  if (controlType === 'CUSTOMERS') return 'CUSTOMER';
  if (controlType === 'SUPPLIERS') return 'SUPPLIER';
  return undefined;
}

/** partyType / partyId of a line for the API (control-account lines only). */
export function partyFields(
  line: JournalLineDraft,
  column: PartyColumn | undefined,
): { partyType?: PartyKind; partyId?: string } {
  const kind = line.accountId ? column?.kindByAccount.get(line.accountId) : undefined;
  return kind && line.partyId ? { partyType: kind, partyId: line.partyId } : {};
}

interface Props {
  lines: JournalLineDraft[];
  onChange: (lines: JournalLineDraft[]) => void;
  accountOptions: Option[];
  /** Increment to auto-focus the first cell (e.g. when a form opens). */
  focusSignal?: number;
  /** Adds the customer / supplier column. */
  partyColumn?: PartyColumn;
  /** Replaces the balanced / unbalanced note in the footer. */
  footerNote?: ReactNode;
}

// Column ids: account (1), debit (2), credit (3), description (4), party (5).
const NAV_COLS = [1, 2, 3, 4];
const NAV_COLS_WITH_PARTY = [1, 5, 2, 3, 4];

/**
 * Excel-like journal lines grid: Enter on the last row appends a new line,
 * Enter elsewhere moves focus to the same column on the next row.
 */
export function JournalLinesGrid({
  lines,
  onChange,
  accountOptions,
  focusSignal,
  partyColumn,
  footerNote,
}: Props) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLTableElement>(null);
  const nextKey = useRef(lines.length);
  // Latest lines for deferred handlers: Enter on a picked account advances
  // from a closure of the render before the pick.
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const kindOf = (accountId: string | undefined) =>
    accountId ? partyColumn?.kindByAccount.get(accountId) : undefined;

  const update = (key: number, patch: Partial<JournalLineDraft>) =>
    onChange(linesRef.current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length >= 2 ? next : [...next, emptyLine(Date.now())]);
  };

  const addRow = () => {
    nextKey.current += 1;
    onChange([...linesRef.current, { key: nextKey.current }]);
  };

  const focusCell = (row: number, col: number) => {
    focusCellEl(
      gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`),
    );
  };

  // Ordered editable columns of a row; the party cell exists on control-account rows only.
  const navCols = (row: number) =>
    kindOf(linesRef.current[row]?.accountId) ? NAV_COLS_WITH_PARTY : NAV_COLS;

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
    const cols = navCols(row);
    const nextColPos = cols.indexOf(col) + 1;
    if (nextColPos < cols.length) {
      focusCell(row, cols[nextColPos]);
    } else if (row + 1 >= linesRef.current.length) {
      addRow();
      focusSoon(row + 1, NAV_COLS[0]);
    } else {
      focusCell(row + 1, NAV_COLS[0]);
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

  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  const diff = round3(totalDebit.minus(totalCredit).abs());

  // Arrow-key navigation (capture phase so InputNumber's step-on-arrow and
  // the select's dropdown-open don't swallow the keys). Select cells keep
  // vertical arrows for their dropdown; horizontal arrows move columns.
  const onCellKeyDownCapture = (e: React.KeyboardEvent, row: number, col: number) => {
    if (e.nativeEvent.isComposing || isSelectDropdownOpen(e.currentTarget)) return;
    const key = e.key;
    if (!key.startsWith('Arrow')) return;
    const cols = navCols(row);
    const colPos = cols.indexOf(col);
    if (colPos === -1) return;
    const isSelectCell = !!e.currentTarget.querySelector('.ant-select');
    if (isSelectCell && (key === 'ArrowUp' || key === 'ArrowDown')) return;

    let targetRow = row;
    let targetCol: number;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const nc = colPos + (key === 'ArrowLeft' ? -1 : 1);
      if (nc < 0 || nc >= cols.length) return;
      targetCol = cols[nc];
    } else {
      targetRow = row + (key === 'ArrowUp' ? -1 : 1);
      if (targetRow < 0 || targetRow >= lines.length) return;
      targetCol = navCols(targetRow).includes(col) ? col : NAV_COLS[0];
    }

    e.preventDefault();
    e.stopPropagation();
    focusCell(targetRow, targetCol);
  };

  const cellProps = (row: number, col: number) => ({
    'data-cell': `${row}-${col}`,
    onKeyDownCapture: (e: React.KeyboardEvent) => onCellKeyDownCapture(e, row, col),
    onKeyDown: (e: React.KeyboardEvent) => onCellKeyDown(e, row, col),
  });

  return (
    <div className="entry-grid-frame">
    <div className="entry-grid-scroll">
      <table ref={gridRef} className="entry-grid">
        <thead>
          <tr>
            <th className="row-no">#</th>
            <th style={{ width: partyColumn ? '28%' : '34%' }}>{t('journal.account')}</th>
            {partyColumn && <th style={{ width: '22%' }}>{t('journal.party')}</th>}
            <th className="num-cell" style={{ width: 130 }}>{t('journal.debit')}</th>
            <th className="num-cell" style={{ width: 130 }}>{t('journal.credit')}</th>
            <th>{t('common.description')}</th>
            <th style={{ width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, row) => {
            const kind = kindOf(l.accountId);
            return (
              <tr key={l.key}>
                <td className="row-no">{row + 1}</td>
                <td {...cellProps(row, 1)}>
                  <GridSelect
                    aria-label={cellLabel(t, t('journal.account'), row)}
                    variant="borderless"
                    placeholder={t('journal.account')}
                    options={accountOptions}
                    value={l.accountId}
                    onChange={(v: string) =>
                      // A party belongs to its kind of control account: drop it when that changes.
                      update(
                        l.key,
                        kindOf(v) === kind ? { accountId: v } : { accountId: v, partyId: undefined },
                      )
                    }
                    onEnterSelect={() => advance(row, 1)}
                    style={{ width: '100%' }}
                    size="small"
                  />
                </td>
                {partyColumn && (
                  <td {...cellProps(row, 5)}>
                    {kind ? (
                      <GridSelect
                        aria-label={cellLabel(t, t('journal.party'), row)}
                        variant="borderless"
                        placeholder={t(kind === 'CUSTOMER' ? 'journal.pickCustomer' : 'journal.pickSupplier')}
                        options={partyColumn.options[kind]}
                        onRemoteSearch={partyColumn.onSearch[kind]}
                        value={l.partyId}
                        onChange={(v: string) => update(l.key, { partyId: v })}
                        onEnterSelect={() => advance(row, 5)}
                        style={{ width: '100%' }}
                        size="small"
                      />
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    )}
                  </td>
                )}
                <td className="num-cell" {...cellProps(row, 2)}>
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('journal.debit'), row)}
                    variant="borderless"
                    stringMode
                    placeholder={t('journal.debit')}
                    min="0"
                    value={l.debit}
                    onChange={(v) => update(l.key, { debit: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td className="num-cell" {...cellProps(row, 3)}>
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('journal.credit'), row)}
                    variant="borderless"
                    stringMode
                    placeholder={t('journal.credit')}
                    min="0"
                    value={l.credit}
                    onChange={(v) => update(l.key, { credit: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td {...cellProps(row, 4)}>
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
                <td style={{ textAlign: 'center' }}>
                  {lines.length > 2 && (
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
            <td colSpan={partyColumn ? 3 : 2}>
              {t('journal.total')}
            </td>
            <td className="num-cell">
              <Num>{formatAmount(totalDebit)}</Num>
            </td>
            <td className="num-cell">
              <Num>{formatAmount(totalCredit)}</Num>
            </td>
            <td colSpan={2}>
              {footerNote === undefined &&
                (!diff.isZero() ? (
                  <Typography.Text type="danger">
                    {t('journal.unbalanced', { amount: formatAmount(diff) })}
                  </Typography.Text>
                ) : (
                  totalDebit.gt(0) && (
                    <Typography.Text type="success">{t('journal.balanced')}</Typography.Text>
                  )
                ))}
            </td>
          </tr>
          {footerNote !== undefined && footerNote !== null && (
            // A longer note gets a row of its own across the grid.
            <tr>
              <td colSpan={partyColumn ? 7 : 6}>{footerNote}</td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
    <div className="entry-grid-footer">
      <GridHint />
    </div>
    </div>
  );
}
