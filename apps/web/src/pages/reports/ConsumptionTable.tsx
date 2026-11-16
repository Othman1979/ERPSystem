import { Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import type { ConsumptionReportDto, ConsumptionRowDto } from '@erp/api-client';
import { DocField, DocFields, DocValue } from '../../components/DocLayout';
import { Num } from '../../components/Num';
import { amountCell, qtyCell, unitCostCell } from '../../format/cells';
import { dec, formatAmount } from '../../format/number';
import { bothNames } from '../../i18n/displayName';

/**
 * Consumption between two counts (ADR-032 §3): per item the opening and closing
 * counts, the receipts between them, the actual use, what the stock ledger
 * recorded (split into recipes, direct sales and the rest), and the variance in
 * quantity and value. A non-zero variance is the waste or the loss not recorded.
 */
export function ConsumptionTable({ report }: { report: ConsumptionReportDto }) {
  const { t } = useTranslation();
  const columns: ColumnsType<ConsumptionRowDto> = [
    { title: t('accounts.code'), dataIndex: 'code', width: 100, fixed: 'left' },
    { title: t('reports.item'), key: 'name', width: 200, render: (_: unknown, r: ConsumptionRowDto) => bothNames(r) },
    { title: t('reports.consumption.avgCost'), dataIndex: 'avgCost', align: 'right', width: 110, render: unitCostCell },
    { title: t('reports.consumption.openingCounted'), dataIndex: 'openingCounted', align: 'right', width: 110, render: qtyCell },
    { title: t('reports.consumption.receipts'), dataIndex: 'receipts', align: 'right', width: 100, render: qtyCell },
    { title: t('reports.consumption.closingCounted'), dataIndex: 'closingCounted', align: 'right', width: 110, render: qtyCell },
    { title: t('reports.consumption.actual'), dataIndex: 'actual', align: 'right', width: 100, render: qtyCell },
    {
      title: t('reports.consumption.recorded'),
      children: [
        { title: t('reports.consumption.recipes'), dataIndex: 'recipeOut', align: 'right', width: 110, render: qtyCell },
        { title: t('reports.consumption.directSales'), dataIndex: 'directSales', align: 'right', width: 110, render: qtyCell },
        { title: t('reports.consumption.otherOut'), dataIndex: 'otherOut', align: 'right', width: 100, render: qtyCell },
        { title: t('journal.total'), dataIndex: 'recorded', align: 'right', width: 100, render: qtyCell },
      ],
    },
    {
      title: t('reports.consumption.variance'),
      children: [
        { title: t('reports.qty'), dataIndex: 'variance', align: 'right', width: 100, render: varianceCell('qty') },
        { title: t('reports.value'), dataIndex: 'varianceValue', align: 'right', width: 110, render: varianceCell('amount') },
      ],
    },
  ];

  return (
    <>
      <Table<ConsumptionRowDto>
        rowKey="itemId"
        size="small"
        bordered
        pagination={false}
        scroll={{ x: 1300 }}
        dataSource={report.rows}
        columns={columns}
      />
      <DocFields>
        <DocField label={`${t('reports.consumption.actual')} · ${t('reports.value')}`}>
          <DocValue>
            <Num>{formatAmount(report.totals.actualValue)}</Num>
          </DocValue>
        </DocField>
        <DocField label={`${t('reports.consumption.recorded')} · ${t('reports.value')}`}>
          <DocValue>
            <Num>{formatAmount(report.totals.recordedValue)}</Num>
          </DocValue>
        </DocField>
        <DocField label={`${t('reports.consumption.variance')} · ${t('reports.value')}`}>
          <DocValue>
            <VarianceText value={report.totals.varianceValue} kind="amount" />
          </DocValue>
        </DocField>
      </DocFields>
    </>
  );
}

/** A variance in the warning colour when it is not zero; the column headers say what it is. */
function varianceCell(kind: 'qty' | 'amount') {
  return (value: string) => <VarianceText value={value} kind={kind} />;
}

function VarianceText({ value, kind }: { value: string; kind: 'qty' | 'amount' }) {
  const nonZero = !dec(value).isZero();
  return (
    <Typography.Text type={nonZero ? 'warning' : undefined} strong={nonZero}>
      {kind === 'qty' ? qtyCell(value) : amountCell(value)}
    </Typography.Text>
  );
}
