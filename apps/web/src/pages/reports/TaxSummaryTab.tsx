import { useQuery } from '@tanstack/react-query';
import { Select, Table, Tag, Tooltip, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchData } from '@erp/api-client';
import { ExportButtons, queryString } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { tableLocale } from '../../components/QueryState';
import { Num } from '../../components/Num';
import { amountCell } from '../../format/cells';
import { dec, formatAmount, formatPercent } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';
import { palette } from '../../theme';
import { isoDay, PeriodMeta, PeriodPickers, ScreenPrintButton } from './PeriodFilters';
import { bimonthEnd, bimonthPresets, bimonthStart } from './taxPeriods';

const AMOUNT_FIELDS = ['outputBase', 'outputTax', 'inputBase', 'inputTax', 'payable'] as const;
type AmountField = (typeof AMOUNT_FIELDS)[number];
type TaxAmounts = Record<
  | AmountField
  | 'salesBase'
  | 'salesTax'
  | 'salesReturnsBase'
  | 'salesReturnsTax'
  | 'purchasesBase'
  | 'purchasesTax'
  | 'purchaseReturnsBase'
  | 'purchaseReturnsTax',
  string
>;

interface TaxRow extends TaxAmounts {
  key: string;
  taxCategoryId: string | null;
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
  rate: string;
  einvoiceCode: string | null;
}

interface TaxSummary {
  from: string;
  to: string;
  rows: TaxRow[];
  totals: TaxAmounts;
  ledger: { output: string; input: string };
  /** Ledger movement on the OUTPUT_TAX / INPUT_TAX accounts minus the document figures. */
  ledgerDifference: { output: string; input: string };
}

const PATH = '/reports/tax-summary';

/** Phase 8: output and input tax per category and rate for a return period, and the payable. */
export function TaxSummaryTab() {
  const { t, i18n } = useTranslation();
  // Default: the two-month return period containing today.
  const [from, setFrom] = useState<Dayjs | null>(() => bimonthStart(dayjs()));
  const [to, setTo] = useState<Dayjs | null>(() => bimonthEnd(bimonthStart(dayjs())));
  const params = { from: isoDay(from), to: isoDay(to) };
  const listQuery = useQuery({
    queryKey: ['report-tax-summary', params.from, params.to],
    queryFn: () => apiFetchData<TaxSummary>(`/api/v1${PATH}${queryString(params)}`),
  });
  const { data, isLoading } = listQuery;

  const presets = bimonthPresets(dayjs(), i18n.language);
  const preset = presets.find((p) => isoDay(p.from) === params.from && isoDay(p.to) === params.to)?.value;

  const payable = dec(data?.totals.payable);
  const ledgerOk = data ? dec(data.ledgerDifference.output).isZero() && dec(data.ledgerDifference.input).isZero() : true;

  const amountCol = (field: AmountField, title: string) => ({
    title,
    dataIndex: field,
    width: 130,
    align: 'right' as const,
    render: amountCell,
  });

  return (
    <>
      <ListToolbar
        filters={
          <>
            <Select
              placeholder={t('reports.taxPeriod')}
              aria-label={t('reports.taxPeriod')}
              style={{ minWidth: 200 }}
              value={preset}
              onChange={(v: string) => {
                const p = presets.find((x) => x.value === v);
                if (p) {
                  setFrom(p.from);
                  setTo(p.to);
                }
              }}
              options={presets.map((p) => ({ value: p.value, label: p.label }))}
            />
            <PeriodPickers from={from} to={to} onFrom={setFrom} onTo={setTo} resolved={data} />
          </>
        }
        actions={
          <>
            <ScreenPrintButton />
            <ExportButtons path={PATH} params={params} />
          </>
        }
      />
      {data && (
        <div className="report-meta">
          <PeriodMeta from={data.from} to={data.to} />
          <span>
            {t('reports.outputTax')}: <strong><Num>{formatAmount(data.totals.outputTax)}</Num></strong>
          </span>
          <span>
            {t('reports.inputTax')}: <strong><Num>{formatAmount(data.totals.inputTax)}</Num></strong>
          </span>
          <span>
            {payable.lt(0) ? t('reports.taxRefundable') : t('reports.taxPayable')}:{' '}
            <strong><Num>{formatAmount(payable.abs())}</Num></strong>
          </span>
          <span>
            <Tooltip title={t('reports.ledgerDifferenceHint')}>
              <Tag color={ledgerOk ? 'green' : 'red'} style={{ marginInlineEnd: 6 }}>
                {ledgerOk ? t('reports.ledgerMatches') : t('reports.ledgerDiffers')}
              </Tag>
            </Tooltip>
            {!ledgerOk && (
              <span style={{ color: palette.danger }}>
                {t('reports.outputTax')} <Num>{formatAmount(data.ledgerDifference.output)}</Num>
                {' · '}
                {t('reports.inputTax')} <Num>{formatAmount(data.ledgerDifference.input)}</Num>
              </span>
            )}
          </span>
        </div>
      )}
      <Table<TaxRow>
        rowKey="key"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        locale={tableLocale(listQuery)}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('reports.taxCategory'),
            key: 'category',
            render: (_: unknown, r) =>
              r.code && r.nameAr ? codeAndName({ code: r.code, nameAr: r.nameAr, nameEn: r.nameEn }) : t('reports.noTaxCategory'),
          },
          {
            title: t('reports.rate'),
            dataIndex: 'rate',
            width: 80,
            align: 'right',
            render: (v: string) => <Num>{`${formatPercent(v)}%`}</Num>,
          },
          {
            title: t('reports.einvoiceCode'),
            dataIndex: 'einvoiceCode',
            width: 70,
            render: (v: string | null) => (v ? <Tag>{v}</Tag> : '—'),
          },
          {
            title: t('reports.output'),
            children: [amountCol('outputBase', t('reports.taxableBase')), amountCol('outputTax', t('reports.taxAmount'))],
          },
          {
            title: t('reports.input'),
            children: [amountCol('inputBase', t('reports.taxableBase')), amountCol('inputTax', t('reports.taxAmount'))],
          },
          {
            ...amountCol('payable', t('reports.payable')),
            render: (v: string) => <strong>{amountCell(v)}</strong>,
          },
        ]}
        summary={() =>
          data && data.rows.length > 0 ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={3}>
                <Typography.Text strong>{t('reports.total')}</Typography.Text>
              </Table.Summary.Cell>
              {AMOUNT_FIELDS.map((f, i) => (
                <Table.Summary.Cell key={f} index={i + 3} align="right">
                  <Typography.Text strong>
                    <Num>{formatAmount(data.totals[f])}</Num>
                  </Typography.Text>
                </Table.Summary.Cell>
              ))}
            </Table.Summary.Row>
          ) : null
        }
      />
    </>
  );
}
