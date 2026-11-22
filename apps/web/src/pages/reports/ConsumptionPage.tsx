import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Select, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  consumptionControllerConsumptionReport,
  stockDocumentsControllerListCounts,
  warehousesControllerList,
} from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { PageHeader } from '../../components/PageHeader';
import { ReportCriteria, WinField } from '../../components/WinForm';
import { codeAndName } from '../../i18n/displayName';
import { ConsumptionTable } from './ConsumptionTable';
import { countLabel, countsInOrder } from './consumptionRules';

/** The posted counts a consumption report can compare: at most this many, oldest first (ADR-032 §3). */
const COUNT_LIMIT = 100;

/**
 * Consumption between two counts (ADR-032 §3): a warehouse and two POSTED counts of it.
 * Shows what the warehouse used between them, what the ledger recorded, and the variance.
 */
export function ConsumptionPage() {
  const { t } = useTranslation();
  const [warehouseId, setWarehouseId] = useState<string | undefined>(undefined);
  const [fromCountId, setFromCountId] = useState<string | undefined>(undefined);
  const [toCountId, setToCountId] = useState<string | undefined>(undefined);

  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const counts = useQuery({
    queryKey: ['stock-counts', 'posted', warehouseId],
    queryFn: ({ signal }) =>
      stockDocumentsControllerListCounts({ warehouseId, status: 'POSTED', pageSize: COUNT_LIMIT }, { signal }).then((r) =>
        [...r.data.items].sort((a, b) => a.countDate.localeCompare(b.countDate)),
      ),
    enabled: !!warehouseId,
  });
  const postedCounts = counts.data ?? [];
  const fromCount = postedCounts.find((c) => c.id === fromCountId);
  const toCount = postedCounts.find((c) => c.id === toCountId);
  const ordered = countsInOrder(fromCount, toCount);
  const ready = !!warehouseId && !!fromCountId && !!toCountId && ordered;
  const params = { warehouseId, fromCountId, toCountId };

  const report = useQuery({
    queryKey: ['report-consumption', warehouseId, fromCountId, toCountId],
    queryFn: ({ signal }) =>
      consumptionControllerConsumptionReport(
        { warehouseId: warehouseId!, fromCountId: fromCountId!, toCountId: toCountId! },
        { signal },
      ).then((r) => r.data),
    enabled: ready,
  });

  const countOptions = postedCounts.map((c) => ({ value: c.id, label: countLabel(c) }));
  const changeWarehouse = (id?: string) => {
    setWarehouseId(id);
    setFromCountId(undefined);
    setToCountId(undefined);
  };

  return (
    <div>
      <PageHeader title={t('reports.consumption.title')} />
      <Card>
        <ReportCriteria
          actions={ready && <ExportButtons path="/stock-reports/consumption" params={params} />}
        >
              <WinField label={t('reports.consumption.warehouse')}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                aria-label={t('reports.consumption.warehouse')}
                value={warehouseId}
                onChange={changeWarehouse}
                options={(warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }))}
              />
              </WinField>
              <WinField label={t('reports.consumption.fromCount')}>
              <Select
                allowClear
                aria-label={t('reports.consumption.fromCount')}
                disabled={!warehouseId}
                loading={counts.isFetching}
                value={fromCountId}
                onChange={setFromCountId}
                options={countOptions}
              />
              </WinField>
              <WinField label={t('reports.consumption.toCount')}>
              <Select
                allowClear
                aria-label={t('reports.consumption.toCount')}
                disabled={!warehouseId}
                loading={counts.isFetching}
                value={toCountId}
                onChange={setToCountId}
                options={countOptions}
              />
              </WinField>
        </ReportCriteria>
        <div className="report-meta">
          <Typography.Text type="secondary">{t('reports.consumption.note')}</Typography.Text>
        </div>
        {!warehouseId ? (
          <div className="report-empty">{t('reports.consumption.selectHint')}</div>
        ) : counts.isError ? (
          <Alert type="error" showIcon message={t('common.loadFailed')} />
        ) : !counts.isFetching && postedCounts.length === 0 ? (
          <div className="report-empty">{t('reports.consumption.noPostedCounts')}</div>
        ) : fromCountId && toCountId && !ordered ? (
          <Alert type="warning" showIcon message={t('reports.consumption.order')} />
        ) : !ready ? (
          <div className="report-empty">{t('reports.consumption.selectHint')}</div>
        ) : report.isError ? (
          <Alert type="error" showIcon message={t('common.loadFailed')} />
        ) : report.data ? (
          <ConsumptionTable report={report.data} />
        ) : (
          <Typography.Text type="secondary">{t('common.loading')}</Typography.Text>
        )}
      </Card>
    </div>
  );
}
