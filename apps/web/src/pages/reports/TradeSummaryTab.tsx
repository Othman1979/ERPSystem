import { useQuery } from '@tanstack/react-query';
import { Segmented, Table, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchData } from '@erp/api-client';
import { ExportButtons, queryString } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { Num } from '../../components/Num';
import { amountCell, qtyCell } from '../../format/cells';
import { formatAmount, formatQty } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';
import { isoDay, PeriodMeta, PeriodPickers, ScreenPrintButton } from './PeriodFilters';

type Kind = 'sales' | 'purchases';
export type TradeGroupBy = 'day' | 'month' | 'customer' | 'supplier' | 'item';

/** Invoices − returns; counts are documents (null when grouped by item, which has `qty`). */
interface TradeAmounts {
  invoiceCount: number | null;
  returnCount: number | null;
  qty?: string;
  net: string;
  tax: string;
  grand: string;
  /** Sales only. */
  cost?: string;
  margin?: string;
}

interface TradeRow extends TradeAmounts {
  /** yyyy-mm-dd, yyyy-mm, or the party / item id. */
  key: string;
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
}

interface TradeSummary {
  from: string;
  to: string;
  groupBy: TradeGroupBy;
  rows: TradeRow[];
  totals: TradeAmounts;
}

const GROUPS: Record<Kind, TradeGroupBy[]> = {
  sales: ['day', 'month', 'customer', 'item'],
  purchases: ['day', 'month', 'supplier', 'item'],
};

/** Opening filters, e.g. from a dashboard link (`?from&to&groupBy`). */
export interface TradeSummaryInitial {
  from?: string | null;
  to?: string | null;
  groupBy?: string | null;
}

const parseDay = (v: string | null | undefined): Dayjs | null => {
  const d = v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dayjs(v) : null;
  return d && d.isValid() ? d : null;
};

/** Phase 8: posted invoices less returns by day, month, party or item; sales add cost and margin. */
export function TradeSummaryTab({ kind, initial }: { kind: Kind; initial?: TradeSummaryInitial }) {
  const { t } = useTranslation();
  const groups = GROUPS[kind];
  const [groupBy, setGroupBy] = useState<TradeGroupBy>(() =>
    groups.find((g) => g === initial?.groupBy) ?? 'month',
  );
  // Empty = the fiscal year (the API's default).
  const [from, setFrom] = useState<Dayjs | null>(() => parseDay(initial?.from));
  const [to, setTo] = useState<Dayjs | null>(() => parseDay(initial?.to));
  const path = kind === 'sales' ? '/reports/sales-summary' : '/reports/purchases-summary';
  const params = { from: isoDay(from), to: isoDay(to), groupBy };
  const { data, isLoading } = useQuery({
    queryKey: ['report-trade-summary', kind, params.from, params.to, groupBy],
    queryFn: () => apiFetchData<TradeSummary>(`/api/v1${path}${queryString(params)}`),
  });

  const sales = kind === 'sales';
  // The table follows the answer's grouping, so switching never mislabels the old rows.
  const shown = data?.groupBy ?? groupBy;
  const byItem = shown === 'item';
  // Toggle labels ("By day") and the first column's title ("Day").
  const groupLabels: Record<TradeGroupBy, string> = {
    day: t('reports.byDay'),
    month: t('reports.byMonth'),
    customer: t('reports.byCustomer'),
    supplier: t('reports.bySupplier'),
    item: t('reports.byItem'),
  };
  const groupTitles: Record<TradeGroupBy, string> = {
    day: t('reports.day'),
    month: t('reports.month'),
    customer: t('reports.customer'),
    supplier: t('reports.supplier'),
    item: t('reports.item'),
  };
  const groupCell = (r: TradeRow) => {
    if (shown === 'day' || shown === 'month') return <Num>{r.key}</Num>;
    return r.code && r.nameAr ? codeAndName({ code: r.code, nameAr: r.nameAr, nameEn: r.nameEn }) : r.key;
  };

  const amount = (field: 'net' | 'tax' | 'grand' | 'cost' | 'margin', title: string) => ({
    title,
    dataIndex: field,
    width: 130,
    align: 'right' as const,
    render: amountCell,
  });
  const columns = [
    { title: groupTitles[shown], key: 'group', render: (_: unknown, r: TradeRow) => groupCell(r) },
    ...(byItem
      ? [{ title: t('reports.qty'), dataIndex: 'qty', width: 110, align: 'right' as const, render: qtyCell }]
      : [
          { title: t('reports.invoiceCount'), dataIndex: 'invoiceCount', width: 80, align: 'right' as const },
          { title: t('reports.returnCount'), dataIndex: 'returnCount', width: 80, align: 'right' as const },
        ]),
    amount('net', t('reports.net')),
    amount('tax', t('reports.tax')),
    amount('grand', t('reports.grand')),
    ...(sales ? [amount('cost', t('reports.cost')), amount('margin', t('reports.margin'))] : []),
  ];

  const totals = data?.totals;
  const totalCells: ReactNode[] = totals
    ? [
        ...(byItem
          ? [<Num key="qty">{formatQty(totals.qty)}</Num>]
          : [<Num key="ic">{totals.invoiceCount ?? 0}</Num>, <Num key="rc">{totals.returnCount ?? 0}</Num>]),
        ...(['net', 'tax', 'grand'] as const).map((f) => <Num key={f}>{formatAmount(totals[f])}</Num>),
        ...(sales ? (['cost', 'margin'] as const).map((f) => <Num key={f}>{formatAmount(totals[f])}</Num>) : []),
      ]
    : [];

  return (
    <>
      <ListToolbar
        filters={
          <>
            <Segmented
              value={groupBy}
              onChange={(v) => setGroupBy(v as TradeGroupBy)}
              options={groups.map((g) => ({ value: g, label: groupLabels[g] }))}
              aria-label={t('reports.groupBy')}
            />
            <PeriodPickers from={from} to={to} onFrom={setFrom} onTo={setTo} resolved={data} />
          </>
        }
        count={data?.rows.length}
        actions={
          <>
            <ScreenPrintButton />
            <ExportButtons path={path} params={params} />
          </>
        }
      />
      {data && (
        <div className="report-meta">
          <PeriodMeta from={data.from} to={data.to} />
          <span>{t('reports.invoicesLessReturns')}</span>
        </div>
      )}
      <Table<TradeRow>
        rowKey="key"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        columns={columns}
        summary={() =>
          data && data.rows.length > 0 ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>{t('reports.total')}</Typography.Text>
              </Table.Summary.Cell>
              {totalCells.map((c, i) => (
                <Table.Summary.Cell key={i} index={i + 1} align="right">
                  <Typography.Text strong>{c}</Typography.Text>
                </Table.Summary.Cell>
              ))}
            </Table.Summary.Row>
          ) : null
        }
      />
    </>
  );
}
