import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, InputNumber, Modal, Select, Table, Tabs, Tag, Typography, message } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import type { Key } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  consignmentControllerAging,
  consignmentControllerOpenSales,
  consignmentControllerStatement,
  partiesControllerList,
  purchasesControllerCreateInvoice,
  warehousesControllerList,
  type ConsignmentAgingResponseDto,
  type ConsignmentOpenSaleResponseDto,
  type ConsignmentStatementResponseDto,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { DatePicker } from '../components/DatePicker';
import { EmptyCta } from '../components/EmptyCta';
import { PageHeader } from '../components/PageHeader';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { ReportCriteria, WinField, WinGroup } from '../components/WinForm';
import { useCompany } from '../components/CompanyProfileForm';
import { formatDate } from '../format/date';
import { dec, formatAmount, formatQty, formatUnitCost, sum } from '../format/number';
import { codeAndName } from '../i18n/displayName';
import { consignmentSettlementBody } from './consignmentPayload';

type Supplier = { id: string; code: string; nameAr: string; nameEn: string | null };

const sourceLabel = (row: ConsignmentOpenSaleResponseDto, t: (key: string) => string) =>
  `${t(row.sourceType === 'SALES_INVOICE' ? 'consignment.salesInvoice' : 'consignment.stockCount')} ${row.sourceNo ?? `#${row.sourceId}`}`;

function openSaleUnitCost(row: ConsignmentOpenSaleResponseDto): string {
  return row.unitCost;
}

export function ConsignmentPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const company = useCompany();
  const purchaseManage = can(PERMISSIONS.PURCHASE_MANAGE);
  const reportsView = can(PERMISSIONS.REPORTS_VIEW);
  const [tab, setTab] = useState(purchaseManage ? 'open' : 'statement');

  if (company.isLoading) return <Typography.Text role="status">{t('common.loading')}</Typography.Text>;
  if (!company.data?.consignmentEnabled || (!purchaseManage && !reportsView)) return null;

  const items = [
    ...(purchaseManage ? [{ key: 'open', label: t('consignment.tabs.open') }] : []),
    ...(reportsView
      ? [
          { key: 'statement', label: t('consignment.tabs.statement') },
          { key: 'aging', label: t('consignment.tabs.aging') },
        ]
      : []),
  ];
  const activeTab = items.some((item) => item.key === tab) ? tab : items[0]?.key;

  return (
    <div>
      <PageHeader title={t('nav.consignment')} />
      <Tabs
        activeKey={activeTab}
        onChange={setTab}
        items={items.map((item) => ({
          ...item,
          children:
            item.key === 'open' ? (
              <OpenSalesTab />
            ) : item.key === 'statement' ? (
              <StatementTab />
            ) : (
              <AgingTab />
            ),
        }))}
      />
    </div>
  );
}

function useConsignmentLookups() {
  const suppliers = useQuery({
    queryKey: ['consignment', 'suppliers'],
    queryFn: async ({ signal }) => {
      const params = { pageSize: 100 };
      const [supplierRows, bothRows] = await Promise.all([
        partiesControllerList({ ...params, partyType: 'SUPPLIER' }, { signal }),
        partiesControllerList({ ...params, partyType: 'BOTH' }, { signal }),
      ]);
      return [...supplierRows.data.items, ...bothRows.data.items] as Supplier[];
    },
  });
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  return {
    supplierOptions: (suppliers.data ?? []).map((row) => ({ value: row.id, label: codeAndName(row) })),
    suppliers: suppliers.data ?? [],
    warehouseOptions: (warehouses.data ?? [])
      .filter((row) => row.consignmentSupplierId !== null)
      .map((row) => ({ value: row.id, label: codeAndName(row) })),
    warehouses: warehouses.data ?? [],
  };
}

function OpenSalesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = useConsignmentLookups();
  const [supplierId, setSupplierId] = useState<string>();
  const [warehouseId, setWarehouseId] = useState<string>();
  const [selected, setSelected] = useState<Record<string, { qty: string; unitPrice: string }>>({});
  const [headerOpen, setHeaderOpen] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState<Dayjs>(dayjs());
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('');
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState<Dayjs | null>(null);
  const [description, setDescription] = useState('');
  const [apiError, contextHolderError] = message.useMessage();
  const queryClient = useQueryClient();
  const openSales = useQuery({
    queryKey: ['consignment', 'open-sales', supplierId, warehouseId],
    queryFn: ({ signal }) =>
      consignmentControllerOpenSales(
        { ...(supplierId ? { supplierId } : {}), ...(warehouseId ? { warehouseId } : {}) },
        { signal },
      ).then((r) => r.data),
  });
  const rows = openSales.data ?? [];
  const selectedRows = rows.flatMap((sale) => {
    const value = selected[sale.id];
    return value ? [{ sale, ...value }] : [];
  });
  const create = useMutation({
    mutationFn: () =>
      purchasesControllerCreateInvoice(
        consignmentSettlementBody({
          invoiceDate: invoiceDate.format('YYYY-MM-DD'),
          supplierInvoiceNo,
          supplierInvoiceDate: supplierInvoiceDate?.format('YYYY-MM-DD'),
          description,
          lines: selectedRows,
        }),
      ),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-invoices'] });
      navigate(`/purchases?invoiceId=${res.data.id}`);
    },
    onError: (err) =>
      apiError.error(
        err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
      ),
  });
  const columns: TableColumnsType<ConsignmentOpenSaleResponseDto> = [
    { title: t('goods.date'), dataIndex: 'saleDate', width: 110, render: (value: string) => formatDate(value) },
    { title: t('consignment.source'), render: (_: unknown, row) => sourceLabel(row, t) },
    { title: t('consignment.item'), render: (_: unknown, row) => codeAndName(row.item) },
    { title: t('consignment.openQty'), dataIndex: 'openQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.openValue'), dataIndex: 'openValue', align: 'right', className: 'num', render: (value: string) => formatAmount(value) },
    {
      title: t('consignment.unitCost'),
      align: 'right',
      className: 'num',
      render: (_: unknown, row) => formatUnitCost(openSaleUnitCost(row)),
    },
    {
      title: t('stock.qty'),
      width: 116,
      align: 'right',
      render: (_: unknown, row) => selected[row.id] && (
        <InputNumber<string>
          stringMode
          min="0.000001"
          max={row.openQty}
          value={selected[row.id].qty}
          aria-label={t('consignment.settlementQty')}
          onChange={(qty) => setSelected((current) => ({ ...current, [row.id]: { ...current[row.id], qty: qty ?? '' } }))}
          onClick={(event) => event.stopPropagation()}
          controls={false}
        />
      ),
    },
    {
      title: t('consignment.supplierPrice'),
      width: 130,
      align: 'right',
      render: (_: unknown, row) => selected[row.id] && (
        <InputNumber<string>
          stringMode
          min="0"
          value={selected[row.id].unitPrice}
          aria-label={t('consignment.unitPrice')}
          onChange={(unitPrice) =>
            setSelected((current) => ({ ...current, [row.id]: { ...current[row.id], unitPrice: unitPrice ?? '' } }))
          }
          onClick={(event) => event.stopPropagation()}
          controls={false}
        />
      ),
    },
  ];
  const rowSelection = {
    selectedRowKeys: Object.keys(selected),
    onChange: (keys: Key[], selectedRowsNow: ConsignmentOpenSaleResponseDto[]) => {
      setSelected((current) => {
        const next: typeof current = {};
        for (const row of selectedRowsNow) {
          next[row.id] = current[row.id] ?? { qty: row.openQty, unitPrice: openSaleUnitCost(row) };
        }
        return next;
      });
      if (keys.length === 0) setSelected({});
    },
  };
  const startCreate = () => {
    if (!selectedRows.length) {
      apiMessage.warning(t('consignment.selectRows'));
      return;
    }
    const first = selectedRows[0].sale;
    if (selectedRows.some(({ sale }) => sale.supplierId !== first.supplierId || sale.warehouseId !== first.warehouseId)) {
      apiMessage.warning(t('consignment.oneSupplierWarehouse'));
      return;
    }
    setInvoiceDate(dayjs());
    setSupplierInvoiceNo('');
    setSupplierInvoiceDate(null);
    setDescription('');
    setHeaderOpen(true);
  };
  const submit = () => {
    if (selectedRows.some(({ qty, unitPrice, sale }) =>
      !dec(qty).gt(0) || dec(qty).gt(sale.openQty) || unitPrice === '',
    )) {
      apiMessage.error(t('consignment.invalidSettlementQty'));
      return;
    }
    create.mutate();
  };
  const supplier = lookups.suppliers.find((row) => row.id === selectedRows[0]?.sale.supplierId);
  const warehouse = lookups.warehouses.find((row) => row.id === selectedRows[0]?.sale.warehouseId);
  const empty = (
    <EmptyCta
      description={t('consignment.emptyOpen')}
      actionLabel={t('consignment.openGoodsNotes')}
      onClick={() => navigate('/goods-notes')}
    />
  );
  return (
    <div>
      {contextHolder}
      {contextHolderError}
      <ReportCriteria
        actions={
          <Button type="primary" disabled={!selectedRows.length} onClick={startCreate}>
            {t('consignment.createSupplierInvoice')}
          </Button>
        }
      >
        <WinField label={t('purchases.supplier')}>
          <Select allowClear showSearch optionFilterProp="label" value={supplierId} options={lookups.supplierOptions}
            onChange={(value) => { setSupplierId(value); setSelected({}); setWarehouseId(undefined); }} />
        </WinField>
        <WinField label={t('stock.warehouse')}>
          <Select allowClear showSearch optionFilterProp="label" value={warehouseId} options={lookups.warehouseOptions}
            onChange={(value) => { setWarehouseId(value); setSelected({}); }} />
        </WinField>
      </ReportCriteria>
      <ResponsiveTable<ConsignmentOpenSaleResponseDto>
        rowKey="id"
        loading={openSales.isLoading}
        dataSource={rows}
        columns={columns}
        rowSelection={rowSelection}
        locale={{ emptyText: openSales.isSuccess ? empty : t('common.noResults') }}
        size="small"
        pagination={{ pageSize: 10 }}
        scroll={{ x: 'max-content' }}
        mobileCard={{
          title: (row) => codeAndName(row.item),
          subtitle: (row) => `${formatDate(row.saleDate)} · ${sourceLabel(row, t)}`,
          amount: (row) => formatAmount(row.openValue),
          meta: (row) => [<span>{t('consignment.openQty')}: {formatQty(row.openQty)}</span>],
        }}
      />
      {supplier && warehouse && (
        <Modal
          title={t('consignment.createSupplierInvoice')}
          open={headerOpen}
          onCancel={() => setHeaderOpen(false)}
          onOk={submit}
          confirmLoading={create.isPending}
          okText={t('common.saveDraft')}
        >
          <WinGroup title={t('consignment.invoiceHeader')} cols={1}>
            <WinField label={t('purchases.invoiceDate')}>
              <DatePicker value={invoiceDate} onChange={(value) => value && setInvoiceDate(value)} />
            </WinField>
            <WinField label={t('purchases.supplier')}>
              <Typography.Text>{codeAndName(supplier)}</Typography.Text>
            </WinField>
            <WinField label={t('stock.warehouse')}>
              <Typography.Text>{codeAndName(warehouse)}</Typography.Text>
            </WinField>
            <WinField label={t('purchases.supplierInvoiceNo')}>
              <Input value={supplierInvoiceNo} maxLength={100} onChange={(event) => setSupplierInvoiceNo(event.target.value)} />
            </WinField>
            <WinField label={t('purchases.supplierInvoiceDate')}>
              <DatePicker value={supplierInvoiceDate} onChange={setSupplierInvoiceDate} allowClear />
            </WinField>
            <WinField label={t('common.description')}>
              <Input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
            </WinField>
          </WinGroup>
        </Modal>
      )}
    </div>
  );
}

function StatementTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lookups = useConsignmentLookups();
  const [supplierId, setSupplierId] = useState<string>();
  const [from, setFrom] = useState<Dayjs>(dayjs().startOf('year'));
  const [to, setTo] = useState<Dayjs>(dayjs());
  const report = useQuery({
    queryKey: ['consignment', 'statement', supplierId, from.format('YYYY-MM-DD'), to.format('YYYY-MM-DD')],
    queryFn: ({ signal }) =>
      consignmentControllerStatement(
        { supplierId: supplierId!, from: from.format('YYYY-MM-DD'), to: to.format('YYYY-MM-DD') },
        { signal },
      ).then((r) => r.data),
    enabled: !!supplierId,
  });
  const columns: TableColumnsType<ConsignmentStatementResponseDto> = [
    { title: t('consignment.item'), render: (_: unknown, row) => row.item ? codeAndName(row.item) : '—' },
    { title: t('consignment.received'), dataIndex: 'receivedQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.returnedToSupplier'), dataIndex: 'returnedToSupplierQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.soldNet'), dataIndex: 'soldNetOfReturnsQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.countShortage'), dataIndex: 'countShortageQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.invoiced'), dataIndex: 'invoicedQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.onHand'), dataIndex: 'onHandQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.openQty'), dataIndex: 'openQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.openValue'), dataIndex: 'openValue', align: 'right', className: 'num', render: (value: string) => formatAmount(value) },
  ];
  return (
    <div>
      <ReportCriteria>
        <WinField label={t('purchases.supplier')}>
          <Select allowClear showSearch optionFilterProp="label" value={supplierId} options={lookups.supplierOptions} onChange={setSupplierId} />
        </WinField>
        <WinField label={t('reports.from')}>
          <DatePicker value={from} onChange={(value) => value && setFrom(value)} />
        </WinField>
        <WinField label={t('reports.to')}>
          <DatePicker value={to} onChange={(value) => value && setTo(value)} />
        </WinField>
      </ReportCriteria>
      <Typography.Text type="secondary">{t('consignment.onHandCurrent')}</Typography.Text>
      <ResponsiveTable<ConsignmentStatementResponseDto>
        rowKey={(row) => row.item?.id ?? ''}
        loading={report.isLoading}
        dataSource={report.data ?? []}
        columns={columns}
        size="small"
        pagination={{ pageSize: 10 }}
        locale={{ emptyText: report.isSuccess
          ? <EmptyCta description={t('consignment.emptyStatement')} actionLabel={t('consignment.openGoodsNotes')} onClick={() => navigate('/goods-notes')} />
          : supplierId ? t('common.noResults') : t('consignment.selectSupplier') }}
        scroll={{ x: 'max-content' }}
        mobileCard={{
          title: (row) => (row.item ? codeAndName(row.item) : '—'),
          subtitle: (row) => `${t('consignment.openQty')}: ${formatQty(row.openQty)}`,
          amount: (row) => formatAmount(row.openValue),
          meta: (row) => [<span>{t('consignment.onHand')}: {formatQty(row.onHandQty)}</span>],
        }}
      />
    </div>
  );
}

function AgingTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lookups = useConsignmentLookups();
  const [supplierId, setSupplierId] = useState<string>();
  const [asOf, setAsOf] = useState<Dayjs>(dayjs());
  const report = useQuery({
    queryKey: ['consignment', 'aging', supplierId, asOf.format('YYYY-MM-DD')],
    queryFn: ({ signal }) =>
      consignmentControllerAging(
        { ...(supplierId ? { supplierId } : {}), asOf: asOf.format('YYYY-MM-DD') },
        { signal },
      ).then((r) => r.data),
  });
  const rows = report.data ?? [];
  const totals = useMemo(() => {
    const buckets = new Map<string, { qty: string; value: string }>();
    for (const bucket of ['0-30', '31-60', '61-90', '90+']) {
      const group = rows.filter((row) => row.ageBucket === bucket);
      buckets.set(bucket, {
        qty: sum(group.map((row) => row.openQty)).toString(),
        value: sum(group.map((row) => row.openValue)).toString(),
      });
    }
    return buckets;
  }, [rows]);
  const columns: TableColumnsType<ConsignmentAgingResponseDto> = [
    { title: t('consignment.ageBucket'), dataIndex: 'ageBucket', width: 100, render: (value: string) => <Tag>{t(`consignment.buckets.${value}`)}</Tag> },
    { title: t('goods.date'), dataIndex: 'saleDate', width: 110, render: (value: string) => formatDate(value) },
    { title: t('consignment.source'), render: (_: unknown, row) => sourceLabel(row, t) },
    { title: t('consignment.item'), render: (_: unknown, row) => codeAndName(row.item) },
    { title: t('consignment.openQty'), dataIndex: 'openQty', align: 'right', className: 'num', render: (value: string) => formatQty(value) },
    { title: t('consignment.openValue'), dataIndex: 'openValue', align: 'right', className: 'num', render: (value: string) => formatAmount(value) },
  ];
  return (
    <div>
      <ReportCriteria>
        <WinField label={t('purchases.supplier')}>
          <Select allowClear showSearch optionFilterProp="label" value={supplierId} options={lookups.supplierOptions} onChange={setSupplierId} />
        </WinField>
        <WinField label={t('consignment.asOf')}>
          <DatePicker value={asOf} onChange={(value) => value && setAsOf(value)} />
        </WinField>
      </ReportCriteria>
      <ResponsiveTable<ConsignmentAgingResponseDto>
        rowKey="id"
        loading={report.isLoading}
        dataSource={rows}
        columns={columns}
        size="small"
        pagination={{ pageSize: 10 }}
        locale={{ emptyText: report.isSuccess
          ? <EmptyCta description={t('consignment.emptyAging')} actionLabel={t('consignment.openGoodsNotes')} onClick={() => navigate('/goods-notes')} />
          : t('common.noResults') }}
        scroll={{ x: 'max-content' }}
        summary={() => (
          <Table.Summary>
            {(['0-30', '31-60', '61-90', '90+'] as const).map((bucket) => {
              const total = totals.get(bucket) ?? { qty: '0', value: '0' };
              return (
                <Table.Summary.Row key={bucket}>
                  <Table.Summary.Cell index={0} colSpan={4}>
                    {t('consignment.bucketTotal', { bucket: t(`consignment.buckets.${bucket}`) })}
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">{formatQty(total.qty)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">{formatAmount(total.value)}</Table.Summary.Cell>
                </Table.Summary.Row>
              );
            })}
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={4}>{t('common.totals')}</Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">
                {formatQty(sum([...totals.values()].map((value) => value.qty)))}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">
                {formatAmount(sum([...totals.values()].map((value) => value.value)))}
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
        mobileCard={{
          title: (row) => `${t(`consignment.buckets.${row.ageBucket}`)} · ${codeAndName(row.item)}`,
          subtitle: (row) => `${formatDate(row.saleDate)} · ${sourceLabel(row, t)}`,
          amount: (row) => formatAmount(row.openValue),
          meta: (row) => [<span>{t('consignment.openQty')}: {formatQty(row.openQty)}</span>],
        }}
      />
    </div>
  );
}
