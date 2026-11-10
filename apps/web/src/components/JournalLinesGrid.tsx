import { DeleteOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Typography } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAmount, round3, sum } from '../format/number';
import { GridHint } from './GridHint';
import { focusCellEl, GridSelect, isSelectDropdownOpen } from './GridSelect';
import { needsParty, partyTypeFor, type LineAccount, type PartyType } from './journalLineChecks';
import { Num } from './Num';

export interface JournalLineDraft {
  key: number;
  accountId?: string;
  // Decimal strings (InputNumber stringMode), never JS floats.
  debit?: string | null;
  credit?: string | null;
  description?: string;
  /** Customer / supplier, required on control-account lines. */
  partyId?: string | null;
  partyType?: PartyType | null;
}

export interface GridParty {
  id: string;
  label: string;
  partyType: 'CUSTOMER' | 'SUPPLIER' | 'BOTH';
}

export const emptyLine = (key: number): JournalLineDraft => ({ key });

interface Props {
  lines: JournalLineDraft[];
  onChange: (lines: JournalLineDraft[]) => void;
  accountOptions: { value: string; label: string }[];
  /** Accounts by id: which lines need a party, and of which type. */
  accountById: Map<string, LineAccount>;
  /** Active customers and suppliers for the party column. */
  parties: GridParty[];
  /** Key of a line to mark as missing its party (after a failed save check). */
  missingParty?: number | null;
  /** Increment to auto-focus the first cell (e.g. when a form opens). */
  focusSignal?: number;
}

/** A BOTH party fits either control account. */
const fits = (p: GridParty, want: PartyType | null) =>
  !want || p.partyType === want || p.partyType === 'BOTH';

/**
 * Excel-like journal lines grid: Enter on the last row appends a new line,
 * Enter elsewhere moves focus to the same column on the next row.
 */
export function JournalLinesGrid({
  lines,
  onChange,
  accountOptions,
  accountById,
  parties,
  missingParty,
  focusSignal,
}: Props) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLTableElement>(null);
  const nextKey = useRef(lines.length);

  const update = (key: number, patch: Partial<JournalLineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const lineNeedsParty = (l?: JournalLineDraft, accountId = l?.accountId) =>
    needsParty(accountId ? accountById.get(accountId) : undefined);

  // A new account keeps the party only if it still fits; a non-control account drops it.
  const changeAccount = (l: JournalLineDraft, accountId?: string) => {
    const account = accountId ? accountById.get(accountId) : undefined;
    const want = partyTypeFor(account);
    const party = parties.find((p) => p.id === l.partyId);
    const keep = needsParty(account) && party && fits(party, want);
    update(l.key, {
      accountId,
      partyId: keep ? l.partyId : null,
      partyType: keep ? (want ?? l.partyType ?? null) : null,
    });
  };

  const changeParty = (l: JournalLineDraft, partyId?: string) => {
    const want = partyTypeFor(l.accountId ? accountById.get(l.accountId) : undefined);
    const party = parties.find((p) => p.id === partyId);
    update(l.key, {
      partyId: partyId ?? null,
      partyType: party ? (want ?? (party.partyType === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER')) : null,
    });
  };

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length >= 2 ? next : [...next, emptyLine(Date.now())]);
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

  // Ordered editable columns for row-major Enter navigation.
  const PARTY_COL = 2;
  const NAV_COLS = [1, PARTY_COL, 3, 4, 5]; // account, party, debit, credit, description
  // The party cell only takes focus on lines whose account needs a party.
  // `accountId` is the account just picked, before the new lines reach props.
  const navigable = (row: number, col: number, accountId?: string) =>
    col !== PARTY_COL || lineNeedsParty(lines[row], accountId ?? lines[row]?.accountId);

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

  const advance = (row: number, col: number, pickedAccountId?: string) => {
    const colPos = NAV_COLS.indexOf(col);
    let nextRow = row;
    let nextColPos = colPos + 1;
    if (nextColPos < NAV_COLS.length && !navigable(row, NAV_COLS[nextColPos], pickedAccountId)) {
      nextColPos += 1;
    }
    if (nextColPos >= NAV_COLS.length) {
      nextRow += 1;
      nextColPos = 0;
    }
    if (nextRow >= lines.length) {
      addRow();
      focusSoon(nextRow, NAV_COLS[0]);
    } else {
      // A just-picked account may add the party select: focus after it renders.
      if (pickedAccountId) focusSoon(nextRow, NAV_COLS[nextColPos]);
      else focusCell(nextRow, NAV_COLS[nextColPos]);
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
    // Step over a party cell the line doesn't use (left/right), or stay put (up/down).
    if (!navigable(nr, NAV_COLS[nc])) {
      if (key === 'ArrowLeft') nc -= 1;
      else if (key === 'ArrowRight') nc += 1;
      if (nc < 0 || nc >= NAV_COLS.length || !navigable(nr, NAV_COLS[nc])) return;
    }

    e.preventDefault();
    e.stopPropagation();
    focusCell(nr, NAV_COLS[nc]);
  };

  const partyOptions = (l: JournalLineDraft) => {
    const want = partyTypeFor(l.accountId ? accountById.get(l.accountId) : undefined);
    return parties.filter((p) => fits(p, want)).map((p) => ({ value: p.id, label: p.label }));
  };
  const partyPlaceholder = (l: JournalLineDraft) => {
    const want = partyTypeFor(l.accountId ? accountById.get(l.accountId) : undefined);
    return want === 'SUPPLIER' ? t('journal.pickSupplier') : want === 'CUSTOMER' ? t('journal.pickCustomer') : t('journal.party');
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
            <th style={{ width: '28%' }}>{t('journal.account')}</th>
            <th style={{ width: '20%' }}>{t('journal.party')}</th>
            <th className="num-cell" style={{ width: 130 }}>{t('journal.debit')}</th>
            <th className="num-cell" style={{ width: 130 }}>{t('journal.credit')}</th>
            <th>{t('common.description')}</th>
            <th style={{ width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, row) => (
            <tr key={l.key}>
              <td className="row-no">{row + 1}</td>
              <td {...cellProps(row, 1)}>
                <GridSelect
                  variant="borderless"
                  placeholder={t('journal.account')}
                  options={accountOptions}
                  value={l.accountId}
                  onChange={(v) => changeAccount(l, v)}
                  onEnterSelect={(v) => advance(row, 1, v as string)}
                  style={{ width: '100%' }}
                  size="small"
                />
              </td>
              <td
                className={missingParty === l.key && !l.partyId ? 'cell-missing' : undefined}
                {...cellProps(row, PARTY_COL)}
              >
                {lineNeedsParty(l) && (
                  <GridSelect
                    variant="borderless"
                    placeholder={partyPlaceholder(l)}
                    options={partyOptions(l)}
                    value={l.partyId ?? undefined}
                    onChange={(v) => changeParty(l, v)}
                    onEnterSelect={() => advance(row, PARTY_COL)}
                    style={{ width: '100%' }}
                    size="small"
                  />
                )}
              </td>
              <td className="num-cell" {...cellProps(row, 3)}>
                <InputNumber<string>
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
              <td className="num-cell" {...cellProps(row, 4)}>
                <InputNumber<string>
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
              <td {...cellProps(row, 5)}>
                <Input
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
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>
              {t('journal.total')}
            </td>
            <td className="num-cell">
              <Num>{formatAmount(totalDebit)}</Num>
            </td>
            <td className="num-cell">
              <Num>{formatAmount(totalCredit)}</Num>
            </td>
            <td colSpan={2}>
              {!diff.isZero() ? (
                <Typography.Text type="danger">
                  {t('journal.unbalanced', { amount: formatAmount(diff) })}
                </Typography.Text>
              ) : (
                totalDebit.gt(0) && (
                  <Typography.Text type="success">{t('journal.balanced')}</Typography.Text>
                )
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div className="entry-grid-footer">
      <GridHint />
    </div>
    </div>
  );
}

