import { Table } from 'antd';
import { useTranslation } from 'react-i18next';
import { Num } from '../../components/Num';
import { dec, formatAmount } from '../../format/number';
import { displayName } from '../../i18n/displayName';
import { palette } from '../../theme';

/** One account of a statement section, as the API sends it (account tree, pre-order). */
export interface StatementAccount {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  /** 0 for a root of the section, +1 per level. */
  depth: number;
  /** A group: `amount` is the subtotal of the accounts under it. */
  isGroup: boolean;
  amount: string;
}

export interface StatementSection {
  rows: StatementAccount[];
  total: string;
}

/**
 * A printed-statement line: a section heading, an account (or a plain
 * labelled amount), a section subtotal, or a result line (gross / net profit).
 */
export type StatementLine =
  | { kind: 'heading'; key: string; label: string }
  | {
      kind: 'account';
      key: string;
      code?: string;
      label: string;
      depth: number;
      isGroup?: boolean;
      amount: string;
    }
  | { kind: 'subtotal' | 'result'; key: string; label: string; amount: string };

/** A section's heading, its account tree (indented under the heading) and its total line. */
export function sectionLines(
  key: string,
  heading: string,
  section: StatementSection,
  totalLabel: string,
  lang: string,
): StatementLine[] {
  return [
    { kind: 'heading', key: `${key}:h`, label: heading },
    ...section.rows.map(
      (r): StatementLine => ({
        kind: 'account',
        key: `${key}:${r.accountId}`,
        code: r.code,
        label: displayName(r, lang),
        depth: r.depth + 1,
        isGroup: r.isGroup,
        amount: r.amount,
      }),
    ),
    { kind: 'subtotal', key: `${key}:t`, label: totalLabel, amount: section.total },
  ];
}

const INDENT_PX = 18;

/** Code / account / amount table laid out like a printed financial statement. */
export function StatementTable({ lines, loading }: { lines: StatementLine[]; loading?: boolean }) {
  const { t } = useTranslation();
  // Headings, subtotals and results span the code and name columns.
  const spanLabel = (l: StatementLine) => ({ colSpan: l.kind === 'account' && l.code ? 1 : 2 });
  const hideIfSpanned = (l: StatementLine) => ({ colSpan: l.kind === 'account' && l.code ? 1 : 0 });
  const indent = (l: StatementLine) => (l.kind === 'account' ? l.depth * INDENT_PX : 0);

  return (
    <Table<StatementLine>
      className="stmt-table"
      rowKey="key"
      size="small"
      loading={loading}
      dataSource={lines}
      pagination={false}
      rowClassName={(l) =>
        l.kind === 'account' ? (l.isGroup ? 'stmt-group' : 'stmt-account') : `stmt-${l.kind}`
      }
      columns={[
        {
          title: t('accounts.code'),
          key: 'code',
          width: 110,
          onCell: spanLabel,
          render: (_: unknown, l) =>
            l.kind === 'account' && l.code ? (
              l.code
            ) : (
              <span style={{ paddingInlineStart: indent(l) }}>{l.label}</span>
            ),
        },
        {
          title: t('reports.account'),
          key: 'name',
          onCell: hideIfSpanned,
          render: (_: unknown, l) =>
            l.kind === 'account' ? <span style={{ paddingInlineStart: indent(l) }}>{l.label}</span> : null,
        },
        {
          title: t('reports.amount'),
          key: 'amount',
          width: 150,
          align: 'right',
          render: (_: unknown, l) =>
            l.kind === 'heading' ? null : (
              <Num style={l.kind === 'result' && dec(l.amount).lt(0) ? { color: palette.danger } : undefined}>
                {formatAmount(l.amount)}
              </Num>
            ),
        },
      ]}
    />
  );
}
