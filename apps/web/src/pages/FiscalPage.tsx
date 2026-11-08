import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
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
  fiscalControllerCreateYear,
  fiscalControllerGetYear,
  fiscalControllerListSequences,
  fiscalControllerListYears,
  fiscalControllerOpenPeriod,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';

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

  const { data: years, isLoading } = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: () => fiscalControllerListYears().then((r) => r.data as unknown as FiscalYear[]),
  });

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
        ]}
      />
      <Modal
        title={t('fiscal.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={createYear.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => createYear.mutate(v)}
          requiredMark={false}
        >
          <Form.Item name="code" label={t('fiscal.code')} rules={[{ required: true }]}>
            <Input maxLength={20} placeholder="2025" />
          </Form.Item>
          <Form.Item
            name="range"
            label={`${t('fiscal.startDate')} — ${t('fiscal.endDate')}`}
            rules={[{ required: true }]}
          >
            <DatePicker.RangePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
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
    queryFn: () => fiscalControllerGetYear(yearId).then((r) => r.data as unknown as YearDetail),
  });
  const { data: sequences } = useQuery({
    queryKey: ['doc-sequences', yearId],
    queryFn: () =>
      fiscalControllerListSequences({ fiscalYearId: yearId }).then(
        (r) => r.data as unknown as DocSequence[],
      ),
  });

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
