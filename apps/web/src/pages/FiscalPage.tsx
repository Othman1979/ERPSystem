import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  ApiError,
  type FiscalPeriodDto,
  type FiscalYearListItemDto,
  fiscalControllerClosePeriod,
  fiscalControllerCloseYear,
  fiscalControllerClosingPreview,
  fiscalControllerCreateYear,
  fiscalControllerGetYear,
  fiscalControllerListSequences,
  fiscalControllerListYears,
  fiscalControllerOpenPeriod,
  fiscalControllerOpenYear,
} from '@erp/api-client';
import { CalendarOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { FormDialog, FormSection } from '../components/FormDialog';
import { Num } from '../components/Num';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { formatAmount } from '../format/number';

type FiscalPeriod = FiscalPeriodDto;

type FiscalYear = FiscalYearListItemDto;

function fmtDate(v: string): string {
  return v ? v.slice(0, 10) : '';
}

function draftHref(type: string, id: string): string | undefined {
  const encodedId = encodeURIComponent(id);
  switch (type) {
    case 'SALES_INVOICE':
      return `/sales?invoiceId=${encodedId}`;
    case 'SALES_QUOTE':
      return `/sales-quotes?quoteId=${encodedId}`;
    case 'SALES_ORDER':
      return `/sales-orders?orderId=${encodedId}`;
    case 'PRODUCTION_VOUCHER':
      return `/production?voucherId=${encodedId}`;
    default:
      return undefined;
  }
}

export function FiscalPage() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [previewYear, setPreviewYear] = useState<FiscalYear | null>(null);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const yearsQuery = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: ({ signal }) => fiscalControllerListYears({ signal }).then((r) => r.data),
  });
  const { data: years, isLoading } = yearsQuery;

  const createYear = useMutation({
    mutationFn: (values: { code: string; range: [Dayjs, Dayjs] }) =>
      fiscalControllerCreateYear({
        code: values.code,
        startDate: values.range[0].format('YYYY-MM-DD'),
        endDate: values.range[1].format('YYYY-MM-DD'),
      }),
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  const togglePeriod = useMutation({
    mutationFn: ({ id, close }: { id: string; close: boolean }) =>
      close ? fiscalControllerClosePeriod(id) : fiscalControllerOpenPeriod(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      void queryClient.invalidateQueries({ queryKey: ['fiscal-year'] });
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  const closingPreview = useQuery({
    queryKey: ['fiscal-year-closing-preview', previewYear?.id],
    queryFn: ({ signal }) => fiscalControllerClosingPreview(previewYear!.id, { signal }).then((r) => r.data),
    enabled: previewYear !== null,
  });

  const closeYear = useMutation({
    mutationFn: (id: string) =>
      fiscalControllerCloseYear(id, { headers: { 'Idempotency-Key': crypto.randomUUID() } }),
    onSuccess: () => {
      apiMessage.success(t('fiscal.yearClosed'));
      setPreviewYear(null);
      void queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      void queryClient.invalidateQueries({ queryKey: ['fiscal-year'] });
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  const reopenYear = useMutation({
    mutationFn: (id: string) =>
      fiscalControllerOpenYear(id, { headers: { 'Idempotency-Key': crypto.randomUUID() } }),
    onSuccess: () => {
      apiMessage.success(t('fiscal.yearOpened'));
      void queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      void queryClient.invalidateQueries({ queryKey: ['fiscal-year'] });
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  const expandedRowRender = (year: FiscalYear) => (
    <YearDetailPanel yearId={year.id} onToggle={togglePeriod.mutate} />
  );

  return (
    <div>
      <PageHeader
        title={t('fiscal.title')}
        actions={
          <Button type="primary" onClick={() => setModalOpen(true)}>
            {t('fiscal.add')}
          </Button>
        }
      />
      <Card>
      {contextHolder}
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={years ?? []}
        locale={tableLocale(yearsQuery)}
        pagination={false}
        expandable={{ expandedRowRender }}
        columns={[
          { title: t('fiscal.code'), dataIndex: 'code', width: 100 },
          {
            title: t('fiscal.startDate'),
            dataIndex: 'startDate',
            render: fmtDate,
            width: 130,
          },
          {
            title: t('fiscal.endDate'),
            dataIndex: 'endDate',
            render: fmtDate,
            width: 130,
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 100,
            render: (status: string, year: FiscalYear) => {
              const periodsClosed = status === 'CLOSED' && !year.activeClosing;
              const displayStatus = year.activeClosing ? 'CLOSED' : status;
              return (
                <Tag color={periodsClosed ? 'blue' : displayStatus === 'OPEN' ? 'green' : 'default'}>
                  {periodsClosed
                    ? t('fiscal.periodsClosed')
                    : t(`fiscal.status.${displayStatus}`, { defaultValue: displayStatus })}
                </Tag>
              );
            },
          },
          {
            title: t('fiscal.periods'),
            width: 100,
            render: (_: unknown, y: FiscalYear) => y._count.periods,
          },
          {
            title: '',
            width: 150,
            render: (_: unknown, y: FiscalYear) => {
              const closedByYear = Boolean(y.activeClosing);
              if (closedByYear) {
                if (me?.currentMembership?.roleCode !== 'OWNER') return null;
                return (
                  <Popconfirm
                    title={t('fiscal.openYearConfirm', { code: y.code })}
                    onConfirm={() => reopenYear.mutate(y.id)}
                  >
                    <Button
                      size="small"
                      loading={reopenYear.isPending && reopenYear.variables === y.id}
                    >
                      {t('fiscal.openYear')}
                    </Button>
                  </Popconfirm>
                );
              }
              return (
                <Button size="small" danger onClick={() => setPreviewYear(y)}>
                  {t('fiscal.closeYear')}
                </Button>
              );
            },
          },
        ]}
      />
      <FormDialog
        title={t('fiscal.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => form.submit()}
        saving={createYear.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => createYear.mutate(v)}>
          <FormSection title={t('fiscal.details')} icon={<CalendarOutlined />}>
            <Form.Item name="code" label={t('fiscal.code')} rules={[{ required: true }]}>
              <Input maxLength={20} placeholder="2025" />
            </Form.Item>
            <Form.Item
              name="range"
              label={`${t('fiscal.startDate')} — ${t('fiscal.endDate')}`}
              rules={[{ required: true }]}
              className="span-2"
            >
              <DatePicker.RangePicker />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
      <Modal
        title={t('fiscal.previewTitle', { code: previewYear?.code ?? '' })}
        open={previewYear !== null}
        onCancel={() => setPreviewYear(null)}
        width={900}
        footer={[
          <Button key="cancel" onClick={() => setPreviewYear(null)}>
            {t('common.close')}
          </Button>,
          <Button
            key="close"
            type="primary"
            danger
            loading={closeYear.isPending}
            disabled={!closingPreview.data?.canClose}
            onClick={() => previewYear && closeYear.mutate(previewYear.id)}
          >
            {t('fiscal.confirmClose')}
          </Button>,
        ]}
      >
        {closingPreview.isLoading && <p>{t('common.loading')}</p>}
        {closingPreview.isError && (
          <p>
            {closingPreview.error instanceof ApiError
              ? t(`errors.${closingPreview.error.code}`, { defaultValue: closingPreview.error.message })
              : t('errors.INTERNAL')}
          </p>
        )}
        {closingPreview.data && (
          <>
            <p>
              {t('fiscal.netResult')}: <Num>{formatAmount(closingPreview.data.netResult)}</Num>
            </p>
            {closingPreview.data.warnings.length > 0 && (
              <>
                <h3>{t('fiscal.warnings')}</h3>
                {closingPreview.data.warnings.map((warning) => (
                  <p key={warning.code} role="alert">
                    {t(`errors.${warning.code}`, { defaultValue: warning.code })}
                  </p>
                ))}
              </>
            )}
            <h3>{t('fiscal.closingEntryLines')}</h3>
            {closingPreview.data.lines.length > 0 ? (
              <Table
                size="small"
                pagination={false}
                rowKey={(line) => `${line.accountId}-${line.costCenterId ?? ''}-${line.branchId ?? ''}`}
                dataSource={closingPreview.data.lines}
                columns={[
                  {
                    title: t('fiscal.account'),
                    render: (_: unknown, line) => {
                      const name =
                        i18n.language.startsWith('ar')
                          ? line.accountNameAr
                          : line.accountNameEn ?? line.accountNameAr;
                      return `${line.accountCode} · ${name}`;
                    },
                  },
                  { title: t('fiscal.branch'), dataIndex: 'branchId' },
                  { title: t('fiscal.costCenter'), dataIndex: 'costCenterId' },
                  {
                    title: t('journal.debit'),
                    dataIndex: 'debit',
                    align: 'right',
                    render: (value: string) => <Num>{formatAmount(value)}</Num>,
                  },
                  {
                    title: t('journal.credit'),
                    dataIndex: 'credit',
                    align: 'right',
                    render: (value: string) => <Num>{formatAmount(value)}</Num>,
                  },
                ]}
              />
            ) : (
              <p>{t('fiscal.noClosingLines')}</p>
            )}
            <h3>{t('fiscal.draftDocuments')}</h3>
            {closingPreview.data.drafts.length > 0 ? (
              <Table
                size="small"
                pagination={false}
                rowKey={(draft) => `${draft.type}-${draft.id}`}
                dataSource={closingPreview.data.drafts}
                columns={[
                  {
                    title: t('fiscal.draftType'),
                    dataIndex: 'type',
                    render: (type: string) =>
                      t(`fiscal.draftTypes.${type}`, { defaultValue: type }),
                  },
                  {
                    title: t('fiscal.draftDescription'),
                    dataIndex: 'description',
                    render: (description: string | null, draft) => {
                      const href = draftHref(draft.type, draft.id);
                      const text = description || '—';
                      return href ? <Link to={href}>{text}</Link> : text;
                    },
                  },
                  { title: t('fiscal.draftDate'), dataIndex: 'date', render: fmtDate },
                ]}
              />
            ) : (
              <p>{t('fiscal.noDraftDocuments')}</p>
            )}
          </>
        )}
      </Modal>
      </Card>
    </div>
  );
}

function YearDetailPanel({
  yearId,
  onToggle,
}: {
  yearId: string;
  onToggle: (v: { id: string; close: boolean }) => void;
}) {
  const { t } = useTranslation();
  const { data: year, isLoading } = useQuery({
    queryKey: ['fiscal-year', yearId],
    queryFn: ({ signal }) => fiscalControllerGetYear(yearId, { signal }).then((r) => r.data),
  });
  const sequencesQuery = useQuery({
    queryKey: ['doc-sequences', yearId],
    queryFn: ({ signal }) =>
      fiscalControllerListSequences({ fiscalYearId: yearId }, { signal }).then((r) => r.data),
  });
  const { data: sequences } = sequencesQuery;

  return (
    <Tabs
      size="small"
      items={[
        {
          key: 'periods',
          label: t('fiscal.periods'),
          children: (
            <Table
              rowKey="id"
              size="small"
              loading={isLoading}
              dataSource={year?.periods ?? []}
              pagination={false}
              columns={[
                { title: t('fiscal.periodNo'), dataIndex: 'periodNo', width: 80 },
                {
                  title: t('fiscal.periodStart'),
                  dataIndex: 'startDate',
                  render: fmtDate,
                  width: 120,
                },
                {
                  title: t('fiscal.periodEnd'),
                  dataIndex: 'endDate',
                  render: fmtDate,
                  width: 120,
                },
                {
                  title: t('common.status'),
                  dataIndex: 'status',
                  width: 100,
                  render: (v: string) => (
                    <Tag color={v === 'OPEN' ? 'green' : 'default'}>
                      {t(`fiscal.status.${v}`, { defaultValue: v })}
                    </Tag>
                  ),
                },
                {
                  title: t('fiscal.closedAt'),
                  dataIndex: 'closedAt',
                  render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—'),
                  width: 150,
                },
                {
                  title: t('common.actions'),
                  width: 110,
                  render: (_: unknown, p: FiscalPeriod) =>
                    p.status === 'OPEN' ? (
                      <Button size="small" danger onClick={() => onToggle({ id: p.id, close: true })}>
                        {t('fiscal.close')}
                      </Button>
                    ) : (
                      <Button size="small" onClick={() => onToggle({ id: p.id, close: false })}>
                        {t('fiscal.open')}
                      </Button>
                    ),
                },
              ]}
            />
          ),
        },
        {
          key: 'sequences',
          label: t('fiscal.sequences'),
          children: (
            <Table
              rowKey="id"
              size="small"
              dataSource={sequences ?? []}
              locale={tableLocale(sequencesQuery)}
              pagination={false}
              columns={[
                {
                  title: t('fiscal.documentType'),
                  dataIndex: 'documentType',
                  render: (value: string) =>
                    t(`fiscal.documentTypes.${value}`, { defaultValue: value }),
                },
                { title: t('fiscal.prefix'), dataIndex: 'prefix' },
                { title: t('fiscal.nextNumber'), dataIndex: 'nextNumber', width: 110 },
              ]}
            />
          ),
        },
      ]}
    />
  );
}
