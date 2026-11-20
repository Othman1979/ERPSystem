import { useQuery } from '@tanstack/react-query';
import { Card, Table, Typography } from 'antd';
import { DatePicker } from '../../components/DatePicker';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { consumptionControllerRecipeSalesWithoutBom, type RecipeSalesWithoutBomRowDto } from '@erp/api-client';
import { ListToolbar } from '../../components/ListToolbar';
import { PageHeader } from '../../components/PageHeader';
import { tableLocale } from '../../components/QueryState';
import { amountCell, qtyCell } from '../../format/cells';
import { codeAndName } from '../../i18n/displayName';

/**
 * Posted recipe lines sold without an ACTIVE formula in a date range (ADR-032 §1): they
 * sold at zero cost, so the list is what to fix in the formulas.
 */
export function RecipeSalesWithoutBomPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const ready = !!from && !!to;
  const rows = useQuery({
    queryKey: ['report-recipe-sales-without-bom', from?.format('YYYY-MM-DD'), to?.format('YYYY-MM-DD')],
    queryFn: ({ signal }) =>
      consumptionControllerRecipeSalesWithoutBom({ from: from!.format('YYYY-MM-DD'), to: to!.format('YYYY-MM-DD') }, { signal }).then(
        (r) => r.data,
      ),
    enabled: ready,
  });

  const columns: ColumnsType<RecipeSalesWithoutBomRowDto> = [
    { title: t('reports.recipeSales.invoice'), dataIndex: 'invoiceNo', width: 140, render: (v: string | null) => v ?? '—' },
    {
      title: t('reports.recipeSales.date'),
      dataIndex: 'invoiceDate',
      width: 120,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('reports.recipeSales.recipe'),
      render: (_: unknown, r: RecipeSalesWithoutBomRowDto) =>
        codeAndName({ code: r.itemCode, nameAr: r.itemNameAr, nameEn: r.itemNameEn ?? null }),
    },
    { title: t('reports.qty'), dataIndex: 'qtyBase', align: 'right', width: 110, render: qtyCell },
    {
      title: t('sales.net'),
      dataIndex: 'netAmount',
      align: 'right',
      width: 120,
      render: (v: string) => amountCell(v),
    },
  ];

  return (
    <div>
      <PageHeader title={t('reports.recipeSales.title')} />
      <Card>
        <ListToolbar
          filters={
            <>
              <DatePicker placeholder={t('reports.from')} value={from} onChange={setFrom} />
              <DatePicker placeholder={t('reports.to')} value={to} onChange={setTo} />
            </>
          }
        />
        <div className="report-meta">
          <Typography.Text type="secondary">{t('reports.recipeSales.hint')}</Typography.Text>
        </div>
        {!ready ? (
          <div className="report-empty">{t('reports.recipeSales.selectRange')}</div>
        ) : (
          <Table<RecipeSalesWithoutBomRowDto>
            rowKey="lineId"
            size="small"
            bordered
            loading={rows.isFetching}
            locale={tableLocale(rows, t('reports.recipeSales.noRows'))}
            dataSource={rows.data ?? []}
            columns={columns}
            scroll={{ x: 680 }}
            pagination={{ pageSize: 50, hideOnSinglePage: true }}
          />
        )}
      </Card>
    </div>
  );
}
