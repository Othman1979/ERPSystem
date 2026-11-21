import { DeleteOutlined } from '@ant-design/icons';
import { Button, Input, InputNumber, Typography } from 'antd';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAmount, round3, sum } from '../format/number';
import { GridHint } from './GridHint';
import { focusCellEl, GridSelect, isSelectDropdownOpen } from './GridSelect';
import { Num } from './Num';
import { cellLabel } from './gridA11y';
import { lineParty, type PartyKind, type PartyNeed } from './journalLineChecks';

export interface JournalLineDraft {
  key: number;
  accountId?: string;
  // Decimal strings (InputNumber stringMode), never JS floats.
  debit?: string | null;
  credit?: string | null;
  description?: string;
  /** Customer / supplier of a control-account line (party column only). */
  partyId?: string;
  /** Side kept from a saved line (a posted entry being edited) while its party is unchanged. */
  partyType?: PartyKind;
  /** Cost centre of an income-statement line (cost centre column only). */
  costCenterId?: string;
}

export const emptyLine = (key: number): JournalLineDraft => ({ key });

type Option = { value: string; label: string };

/** Party column: control-account lines (customers / suppliers) need a party. */
export interface PartyColumn {
  /** The party each control account needs (decision D-2); other accounts take no party. */
  kindByAccount: ReadonlyMap<string, PartyNeed>;
  options: Record<PartyNeed, Option[]>;
  /** Server search for each picker (ADR-022 §8): every typed text goes here. */
  onSearch: Record<PartyNeed, (text: string) => void>;
  /** A picker's matches are still on their way: no stale row is offered meanwhile. */
  searching?: Partial<Record<PartyNeed, boolean>>;
  /** The side a party takes on a control account of no side ('ANY'). */
  sideOf?: (partyId: string) => PartyKind | undefined;
}

/** partyType / partyId of a line for the API (control-account lines only). */
export function partyFields(
  line: JournalLineDraft,
  column: PartyColumn | undefined,
): { partyType?: PartyKind; partyId?: string } {
  const need = line.accountId ? column?.kindByAccount.get(line.accountId) : undefined;
  if (need && line.partyId && line.partyType && (need === 'ANY' || need === line.partyType)) {
    return { partyType: line.partyType, partyId: line.partyId };
  }
  return (need && lineParty(need, line.partyId, column?.sideOf)) || {};
}

/** Cost centre column (ADR-024 §1): shown when the company has centres on. */
export interface CostCenterColumn {
  /** Postable centres, plus any already chosen on the lines. */
  options: Option[];
  /** Income-statement accounts: the only ones a centre can be picked on. */
  income: ReadonlySet<string>;
  /** Income-statement accounts that need a centre. */
  required: ReadonlySet<string>;
}

interface Props {
  lines: JournalLineDraft[];
  onChange: (lines: JournalLineDraft[]) => void;
  accountOptions: Option[];
  /** Increment to auto-focus the first cell (e.g. when a form opens). */
  focusSignal?: number;
  /** Adds the customer / supplier column. */
  partyColumn?: PartyColumn;
  /** Adds the cost centre column (after the party column). */
  costCenterColumn?: CostCenterColumn;
  /** Replaces the balanced / unbalanced note in the footer. */
  footerNote?: ReactNode;
  onCreateAccount?: (lineKey: number, row: number, typedText: string) => void;
  onCreateParty?: (lineKey: number, row: number, need: PartyNeed, typedText: string) => void;
  /** Key of a line to mark as missing its party (after the check before saving). */
  missingParty?: number | null;
  /** Key of a line to mark as missing its cost centre (after the check before saving). */
  missingCostCenter?: number | null;
}

// Column ids: account (1), debit (2), credit (3), description (4), party (5), cost centre (6).
const NAV_COLS = [1, 2, 3, 4];

const PARTY_PLACEHOLDER: Record<PartyNeed, string> = {
  CUSTOMER: 'journal.pickCustomer',
  SUPPLIER: 'journal.pickSupplier',
  ANY: 'journal.pickParty',
};

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
  costCenterColumn,
  footerNote,
  onCreateAccount,
  onCreateParty,
  missingParty,
  missingCostCenter,
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
  // A centre is picked only on an income-statement account.
  const centreOn = (accountId: string | undefined) =>
    !!accountId && !!costCenterColumn?.income.has(accountId);
  // Cells are rendered with the column count of the header, so the footer spans count the same columns.
  const leadingCols = 2 + (partyColumn ? 1 : 0) + (costCenterColumn ? 1 : 0);
  const extraCols = (partyColumn ? 1 : 0) + (costCenterColumn ? 1 : 0);

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

  // Ordered editable columns of a row, in screen order: the party cell exists on
  // control-account rows only, the cost centre cell on income-statement rows only.
  const navCols = (row: number) => {
    const accountId = linesRef.current[row]?.accountId;
    return [
      1,
      ...(kindOf(accountId) ? [5] : []),
      ...(centreOn(accountId) ? [6] : []),
      2,
      3,
      4,
    ];
  };

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
            {costCenterColumn && <th style={{ width: '22%' }}>{t('costCenters.column')}</th>}
            <th className="num-cell" style={{ width: 130 }}>{t('journal.debit')}</th>
            <th className="num-cell" style={{ width: 130 }}>{t('journal.credit')}</th>
            <th>{t('common.description')}</th>
            <th style={{ width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, row) => {
            const kind = kindOf(l.accountId);
            const missing = !!kind && !l.partyId && missingParty === l.key;
            const centre = centreOn(l.accountId);
            // The account needs a centre (ADR-024 §1.3): marked before the line is even filled in.
            const needsCentre = centre && !!costCenterColumn?.required.has(l.accountId!);
            const missingCentre = centre && !l.costCenterId && missingCostCenter === l.key;
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
                    onChange={(v: string) => {
                      // A party belongs to its kind of control account: drop it when that changes.
                      const patch: Partial<JournalLineDraft> =
                        kindOf(v) === kind ? { accountId: v } : { accountId: v, partyId: undefined };
                      // A centre belongs to an income-statement account: drop it when that changes.
                      if (costCenterColumn && !costCenterColumn.income.has(v)) patch.costCenterId = undefined;
                      update(l.key, patch);
                    }}
                    onEnterSelect={() => advance(row, 1)}
                    onCreateNew={onCreateAccount ? (text) => onCreateAccount(l.key, row, text) : undefined}
                    createNewLabel={t('accounts.add')}
                    style={{ width: '100%' }}
                    size="small"
                  />
                </td>
                {partyColumn && (
                  <td
                    className={missing ? 'cell-missing' : undefined}
                    {...cellProps(row, 5)}
                  >
                    {kind ? (
                      <GridSelect
                        aria-label={cellLabel(t, t('journal.party'), row)}
                        aria-invalid={missing || undefined}
                        variant="borderless"
                        placeholder={t(PARTY_PLACEHOLDER[kind])}
                        options={partyColumn.options[kind]}
                        onRemoteSearch={partyColumn.onSearch[kind]}
                        searching={partyColumn.searching?.[kind]}
                        value={l.partyId}
                        onChange={(v: string) => update(l.key, { partyId: v, partyType: undefined })}
                        onEnterSelect={() => advance(row, 5)}
                        onCreateNew={
                          onCreateParty ? (text) => onCreateParty(l.key, row, kind, text) : undefined
                        }
                        createNewLabel={t('parties.add')}
                        style={{ width: '100%' }}
                        size="small"
                      />
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    )}
                  </td>
                )}
                {costCenterColumn && (
                  <td
                    className={
                      [missingCentre && 'cell-missing', needsCentre && 'cell-required'].filter(Boolean).join(' ') ||
                      undefined
                    }
                    {...cellProps(row, 6)}
                  >
                    {centre ? (
                      <GridSelect
                        aria-label={cellLabel(t, t('costCenters.column'), row)}
                        aria-invalid={missingCentre || undefined}
                        aria-required={needsCentre || undefined}
                        variant="borderless"
                        allowClear
                        placeholder={t('costCenters.pick')}
                        options={costCenterColumn.options}
                        value={l.costCenterId}
                        onChange={(v?: string) => update(l.key, { costCenterId: v ?? undefined })}
                        onEnterSelect={() => advance(row, 6)}
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
            <td colSpan={leadingCols}>
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
              <td colSpan={6 + extraCols}>{footerNote}</td>
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
