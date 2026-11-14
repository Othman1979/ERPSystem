import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Popconfirm,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  fiscalControllerClosePeriod,
  fiscalControllerCloseYear,
  fiscalControllerCreateYear,
  fiscalControllerGetYear,
  fiscalControllerListSequences,
  fiscalControllerListYears,
  fiscalControllerOpenPeriod,
  fiscalControllerOpenYear,
} from '@erp/api-client';
import { CalendarOutlined } from '@ant-design/icons';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';

interface FiscalPeriod {
  id: string;
  periodNo: number;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
}

interface FiscalYear {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
  _count?: { periods: number };
}

interface YearDetail extends FiscalYear {
  periods: FiscalPeriod[];
}

interface DocSequence {
  id: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}

function fmtDate(v: string): string {
  return v ? v.slice(0, 10) : '';
}

export function FiscalPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const yearsQuery = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: ({ signal }) => fiscalControllerListYears({ signal }).then((r) => r.data as unknown as FiscalYear[]),
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

  // The whole year at once (ADR-008 §7): every period closed or reopened.
  const toggleYear = useMutation({
    mutationFn: ({ id, close }: { id: string; close: boolean }) =>
      close ? fiscalControllerCloseYear(id) : fiscalControllerOpenYear(id),
    onSuccess: (_, v) => {
      apiMessage.success(t(v.close ? 'fiscal.yearClosed' : 'fiscal.yearOpened'));
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
            render: (v: string) => (
              <Tag color={v === 'OPEN' ? 'green' : 'default'}>
                {t(`fiscal.status.${v}`, { defaultValue: v })}
              </Tag>
            ),
          },
          {
            title: t('fiscal.periods'),
            width: 100,
            render: (_: unknown, y: FiscalYear) => y._count?.periods ?? '—',
          },
          {
            title: '',
            width: 150,
            render: (_: unknown, y: FiscalYear) => {
              const close = y.status === 'OPEN';
              return (
                <Popconfirm
                  title={t(close ? 'fiscal.closeYearConfirm' : 'fiscal.openYearConfirm', { code: y.code })}
                  description={close ? t('fiscal.closeYearHint') : undefined}
                  onConfirm={() => toggleYear.mutate({ id: y.id, close })}
                >
                  <Button size="small" danger={close} loading={toggleYear.isPending && toggleYear.variables?.id === y.id}>
                    {t(close ? 'fiscal.closeYear' : 'fiscal.openYear')}
                  </Button>
                </Popconfirm>
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
    queryFn: ({ signal }) => fiscalControllerGetYear(yearId, { signal }).then((r) => r.data as unknown as YearDetail),
  });
  const sequencesQuery = useQuery({
    queryKey: ['doc-sequences', yearId],
    queryFn: ({ signal }) =>
      fiscalControllerListSequences({ fiscalYearId: yearId }, { signal }).then(
        (r) => r.data as unknown as DocSequence[],
      ),
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
                { title: t('fiscal.documentType'), dataIndex: 'documentType' },
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
