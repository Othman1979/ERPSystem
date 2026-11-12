import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  adminControllerCreateSubscription,
  adminControllerExtendTrial,
  adminControllerGet,
  adminControllerList,
  adminControllerUpdateStatus,
  adminErrorsControllerGet,
  adminErrorsControllerList,
  adminErrorsControllerReopen,
  adminErrorsControllerResolve,
  adminPlansControllerList,
  adminPlansControllerUpdate,
} from '@erp/api-client';
import { ListToolbar } from '../components/ListToolbar';
import { PageHeader } from '../components/PageHeader';
import { amountCell } from '../format/cells';
import { displayName } from '../i18n/displayName';

const STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_COLOR: Record<Status, string> = {
  TRIAL: 'blue',
  ACTIVE: 'green',
  PAST_DUE: 'orange',
  SUSPENDED: 'red',
  CANCELLED: 'default',
};

interface PlanRef {
  code: string;
  nameAr: string;
  nameEn: string | null;
}

interface TenantRow {
  id: string;
  name: string;
  status: Status;
  trialEndsAt: string | null;
  statusChangedAt: string | null;
  plan: PlanRef | null;
  members: number;
  branches: number;
  createdAt: string;
}

interface Subscription {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  amount: string | null;
  notes: string | null;
}

interface TenantDetail extends TenantRow {
  companies: { id: string; legalNameAr: string; isActive: boolean }[];
  subscriptions: Subscription[];
}

interface Plan extends PlanRef {
  id: string;
  maxUsers: number;
  maxBranches: number;
  maxWarehouses: number;
  maxInvoicesPerMonth: number;
  priceMonthly: string | null;
  priceYearly: string | null;
  isActive: boolean;
  tenants: number;
}

const day = (v: string | null | undefined) => (v ? dayjs(v).format('YYYY-MM-DD') : '—');

function StatusTag({ status }: { status: Status }) {
  const { t } = useTranslation();
  return <Tag color={STATUS_COLOR[status]}>{t(`platform.status_${status}`)}</Tag>;
}

/**
 * Platform owner console (BUILD_PLAN §13.3, ADR-009): tenants with their
 * status, plan and paid periods — no tenant financial data — and the plan
 * catalogue (limits, prices), and the error monitor (ADR-010 §10.3).
 * Visible to User.isPlatformAdmin only.
 */
export function PlatformAdminPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t('platform.title')} subtitle={t('platform.subtitle')} />
      <Card>
        <Tabs
          items={[
            { key: 'tenants', label: t('platform.tenants'), children: <TenantsTab /> },
            { key: 'plans', label: t('platform.plans'), children: <PlansTab /> },
            { key: 'errors', label: t('platform.errors'), children: <ErrorsTab /> },
          ]}
        />
      </Card>
    </div>
  );
}

function useApiError() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  return (err: unknown) =>
    message.error(
      err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
    );
}

// ------------------------------------------------------------------ tenants

function TenantsTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | undefined>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['platform-tenants', status, search, page],
    queryFn: () =>
      adminControllerList({ status: status ?? '', search, page: String(page), pageSize: '20' }).then(
        (r) => r.data as unknown as { total: number; items: TenantRow[] },
      ),
  });

  return (
    <>
      <ListToolbar
        search={search}
        onSearch={(v) => {
          setSearch(v);
          setPage(1);
        }}
        filters={
          <Select
            allowClear
            placeholder={t('platform.allStatuses')}
            style={{ minWidth: 160 }}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={STATUSES.map((s) => ({ value: s, label: t(`platform.status_${s}`) }))}
          />
        }
        count={data?.total}
      />
      <Table<TenantRow>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data?.items ?? []}
        pagination={{ current: page, pageSize: 20, total: data?.total ?? 0, onChange: setPage }}
        onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
        columns={[
          { title: t('platform.tenant'), dataIndex: 'name' },
          { title: t('common.status'), dataIndex: 'status', width: 130, render: (s: Status) => <StatusTag status={s} /> },
          { title: t('platform.plan'), dataIndex: 'plan', width: 130, render: (p: PlanRef | null) => (p ? displayName(p) : '—') },
          { title: t('platform.trialEndsAt'), dataIndex: 'trialEndsAt', width: 120, render: day },
          { title: t('platform.members'), dataIndex: 'members', width: 90, align: 'right' },
          { title: t('platform.branches'), dataIndex: 'branches', width: 80, align: 'right' },
          { title: t('platform.createdAt'), dataIndex: 'createdAt', width: 120, render: day },
        ]}
      />
      <TenantDrawer id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function TenantDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [newStatus, setNewStatus] = useState<Status | undefined>();
  const [reason, setReason] = useState('');
  const [trialDays, setTrialDays] = useState<number | null>(14);
  const [payment] = Form.useForm<{ planCode: string; period: [Dayjs, Dayjs]; amount?: string; notes?: string }>();

  const { data: tenant } = useQuery({
    queryKey: ['platform-tenant', id],
    queryFn: () => adminControllerGet(id!).then((r) => r.data as unknown as TenantDetail),
    enabled: !!id,
  });
  const { data: plans } = useQuery({
    queryKey: ['platform-plans'],
    queryFn: () => adminPlansControllerList().then((r) => r.data as unknown as Plan[]),
    enabled: !!id,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-tenants'] });
    void queryClient.invalidateQueries({ queryKey: ['platform-tenant', id] });
  };
  const done = () => {
    message.success(t('common.saved'));
    refresh();
  };

  const changeStatus = useMutation({
    mutationFn: () => adminControllerUpdateStatus(id!, { status: newStatus!, reason: reason || undefined } as never),
    onSuccess: () => {
      setNewStatus(undefined);
      setReason('');
      done();
    },
    onError,
  });
  const extendTrial = useMutation({
    mutationFn: () => adminControllerExtendTrial(id!, { days: trialDays } as never),
    onSuccess: done,
    onError,
  });
  const recordPayment = useMutation({
    mutationFn: (v: { planCode: string; period: [Dayjs, Dayjs]; amount?: string; notes?: string }) =>
      adminControllerCreateSubscription(id!, {
        planCode: v.planCode,
        periodStart: v.period[0].format('YYYY-MM-DD'),
        periodEnd: v.period[1].format('YYYY-MM-DD'),
        amount: v.amount || undefined,
        notes: v.notes || undefined,
      } as never),
    onSuccess: () => {
      payment.resetFields();
      done();
    },
    onError,
  });

  return (
    <Drawer open={!!id} onClose={onClose} width={620} title={tenant?.name ?? ''} destroyOnClose>
      {tenant && (
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label={t('common.status')}>
              <StatusTag status={tenant.status} />
            </Descriptions.Item>
            <Descriptions.Item label={t('platform.plan')}>{tenant.plan ? displayName(tenant.plan) : '—'}</Descriptions.Item>
            <Descriptions.Item label={t('platform.trialEndsAt')}>{day(tenant.trialEndsAt)}</Descriptions.Item>
            <Descriptions.Item label={t('platform.statusChangedAt')}>{day(tenant.statusChangedAt)}</Descriptions.Item>
            <Descriptions.Item label={t('platform.members')}>{tenant.members}</Descriptions.Item>
            <Descriptions.Item label={t('platform.branches')}>{tenant.branches}</Descriptions.Item>
          </Descriptions>

          <section>
            <Typography.Title level={5}>{t('platform.recordPayment')}</Typography.Title>
            <Typography.Paragraph type="secondary">{t('platform.recordPaymentHint')}</Typography.Paragraph>
            <Form form={payment} layout="vertical" onFinish={(v) => recordPayment.mutate(v)}>
              <Space wrap align="start">
                <Form.Item name="planCode" label={t('platform.plan')} rules={[{ required: true }]} initialValue={tenant.plan?.code !== 'TRIAL' ? tenant.plan?.code : undefined}>
                  <Select
                    style={{ width: 160 }}
                    options={(plans ?? [])
                      .filter((p) => p.isActive && p.code !== 'TRIAL')
                      .map((p) => ({ value: p.code, label: displayName(p) }))}
                  />
                </Form.Item>
                <Form.Item name="period" label={t('platform.period')} rules={[{ required: true }]}>
                  <DatePicker.RangePicker />
                </Form.Item>
                <Form.Item name="amount" label={t('platform.amount')}>
                  <InputNumber<string> stringMode min="0" style={{ width: 130 }} />
                </Form.Item>
              </Space>
              <Form.Item name="notes" label={t('platform.paymentNotes')}>
                <Input maxLength={500} placeholder={t('platform.paymentNotesHint')} />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={recordPayment.isPending}>
                {t('platform.recordPayment')}
              </Button>
            </Form>
          </section>

          {tenant.status === 'TRIAL' && (
            <section>
              <Typography.Title level={5}>{t('platform.extendTrial')}</Typography.Title>
              <Space>
                <InputNumber min={1} max={365} value={trialDays} onChange={setTrialDays} addonAfter={t('platform.days')} />
                <Button loading={extendTrial.isPending} disabled={!trialDays} onClick={() => extendTrial.mutate()}>
                  {t('platform.extendTrial')}
                </Button>
              </Space>
            </section>
          )}

          <section>
            <Typography.Title level={5}>{t('platform.changeStatus')}</Typography.Title>
            <Typography.Paragraph type="secondary">{t('platform.changeStatusHint')}</Typography.Paragraph>
            <Space wrap>
              <Select
                style={{ width: 160 }}
                placeholder={t('common.status')}
                value={newStatus}
                onChange={setNewStatus}
                options={STATUSES.filter((s) => s !== tenant.status).map((s) => ({ value: s, label: t(`platform.status_${s}`) }))}
              />
              <Input style={{ width: 240 }} maxLength={500} placeholder={t('platform.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button
                danger={newStatus === 'SUSPENDED' || newStatus === 'CANCELLED'}
                disabled={!newStatus}
                loading={changeStatus.isPending}
                onClick={() =>
                  modal.confirm({
                    title: t('platform.confirmStatus', { status: newStatus ? t(`platform.status_${newStatus}`) : '' }),
                    onOk: () => changeStatus.mutate(),
                  })
                }
              >
                {t('platform.changeStatus')}
              </Button>
            </Space>
          </section>

          <section>
            <Typography.Title level={5}>{t('platform.subscriptions')}</Typography.Title>
            <Table<Subscription>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={tenant.subscriptions}
              locale={{ emptyText: t('platform.noSubscriptions') }}
              columns={[
                { title: t('platform.periodStart'), dataIndex: 'periodStart', render: day },
                { title: t('platform.periodEnd'), dataIndex: 'periodEnd', render: day },
                { title: t('common.status'), dataIndex: 'status', render: (s: string) => <Tag>{t(`platform.sub_${s}`, { defaultValue: s })}</Tag> },
                { title: t('platform.amount'), dataIndex: 'amount', align: 'right', render: amountCell },
                { title: t('platform.paymentNotes'), dataIndex: 'notes', render: (v: string | null) => v ?? '—' },
              ]}
            />
          </section>
        </Space>
      )}
    </Drawer>
  );
}

// -------------------------------------------------------------------- plans

function PlansTab() {
  const { t } = useTranslation();
  const onError = useApiError();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [form] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['platform-plans'],
    queryFn: () => adminPlansControllerList().then((r) => r.data as unknown as Plan[]),
  });
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      adminPlansControllerUpdate(editing!.code, {
        ...v,
        priceMonthly: v.priceMonthly ? String(v.priceMonthly) : null,
        priceYearly: v.priceYearly ? String(v.priceYearly) : null,
      } as never),
    onSuccess: () => {
      message.success(t('common.saved'));
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['platform-plans'] });
    },
    onError,
  });

  const open = (p: Plan) => {
    setEditing(p);
    form.setFieldsValue(p);
  };

  return (
    <>
      <Typography.Paragraph type="secondary">{t('platform.plansHint')}</Typography.Paragraph>
      <Table<Plan>
        rowKey="code"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        columns={[
          { title: t('platform.planCode'), dataIndex: 'code', width: 90 },
          { title: t('common.name'), render: (_: unknown, p) => displayName(p) },
          { title: t('platform.maxUsers'), dataIndex: 'maxUsers', align: 'right' },
          { title: t('platform.maxBranches'), dataIndex: 'maxBranches', align: 'right' },
          { title: t('platform.maxWarehouses'), dataIndex: 'maxWarehouses', align: 'right' },
          { title: t('platform.maxInvoices'), dataIndex: 'maxInvoicesPerMonth', align: 'right' },
          { title: t('platform.priceMonthly'), dataIndex: 'priceMonthly', align: 'right', render: amountCell },
          { title: t('platform.priceYearly'), dataIndex: 'priceYearly', align: 'right', render: amountCell },
          { title: t('platform.tenantsOnPlan'), dataIndex: 'tenants', align: 'right' },
          {
            title: t('common.status'),
            dataIndex: 'isActive',
            render: (v: boolean) => (v ? <Tag color="green">{t('common.active')}</Tag> : <Tag>{t('common.inactive')}</Tag>),
          },
          { title: '', width: 80, render: (_: unknown, p) => <Button size="small" onClick={() => open(p)}>{t('common.edit')}</Button> },
        ]}
      />
      <Modal
        open={!!editing}
        title={editing ? `${t('platform.editPlan')} — ${editing.code}` : ''}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Space wrap>
            <Form.Item name="nameAr" label={t('settings.nameAr')} rules={[{ required: true }]}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('settings.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
          </Space>
          <Space wrap>
            {(['maxUsers', 'maxBranches', 'maxWarehouses', 'maxInvoicesPerMonth'] as const).map((k) => (
              <Form.Item key={k} name={k} label={t(`platform.${k === 'maxInvoicesPerMonth' ? 'maxInvoices' : k}`)} rules={[{ required: true }]}>
                <InputNumber min={1} precision={0} style={{ width: 120 }} />
              </Form.Item>
            ))}
          </Space>
          <Space wrap>
            <Form.Item name="priceMonthly" label={t('platform.priceMonthly')}>
              <InputNumber<string> stringMode min="0" style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="priceYearly" label={t('platform.priceYearly')}>
              <InputNumber<string> stringMode min="0" style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="isActive" label={t('common.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

// -------------------------------------------------------------------- errors

interface ErrorEvent {
  id: string;
  source: 'API' | 'WEB' | 'JOB';
  name: string;
  message: string;
  method: string | null;
  path: string | null;
  status: number | null;
  tenantId: string | null;
  userId: string | null;
  requestId: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  stack?: string | null;
}

const ERROR_FILTERS = ['open', 'resolved', 'all'] as const;
const ERROR_SOURCES = ['API', 'WEB', 'JOB'] as const;

/** Errors of the server, the web app and Cron jobs, grouped and counted (ADR-010 §10.3). */
function ErrorsTab() {
  const { t } = useTranslation();
  const onError = useApiError();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<(typeof ERROR_FILTERS)[number]>('open');
  const [source, setSource] = useState<(typeof ERROR_SOURCES)[number] | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['platform-errors', status, source],
    queryFn: () => adminErrorsControllerList({ status, ...(source ? { source } : {}) }).then((r) => r.data as unknown as ErrorEvent[]),
  });
  const { data: detail } = useQuery({
    queryKey: ['platform-error', openId],
    queryFn: () => adminErrorsControllerGet(Number(openId)).then((r) => r.data as unknown as ErrorEvent),
    enabled: !!openId,
  });
  const toggle = useMutation({
    mutationFn: (e: ErrorEvent) => (e.resolvedAt ? adminErrorsControllerReopen(Number(e.id)) : adminErrorsControllerResolve(Number(e.id))),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-errors'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-error'] });
    },
    onError,
  });
  const when = (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm');

  return (
    <>
      <Typography.Paragraph type="secondary">{t('platform.errorsHint')}</Typography.Paragraph>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          style={{ minWidth: 140 }}
          value={status}
          onChange={setStatus}
          options={ERROR_FILTERS.map((f) => ({ value: f, label: t(`platform.errors_${f}`) }))}
        />
        <Select
          allowClear
          style={{ minWidth: 140 }}
          placeholder={t('platform.errorSource')}
          value={source}
          onChange={setSource}
          options={ERROR_SOURCES.map((s) => ({ value: s, label: t(`platform.errorSource_${s}`) }))}
        />
      </Space>
      <Table<ErrorEvent>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={{ pageSize: 50 }}
        onRow={(e) => ({ onClick: () => setOpenId(e.id), style: { cursor: 'pointer' } })}
        columns={[
          { title: t('platform.errorSource'), dataIndex: 'source', width: 80, render: (v: ErrorEvent['source']) => <Tag>{t(`platform.errorSource_${v}`)}</Tag> },
          {
            title: t('platform.errorMessage'),
            render: (_: unknown, e) => (
              <Typography.Text ellipsis style={{ maxWidth: 420 }}>
                <b>{e.name}</b>: {e.message}
              </Typography.Text>
            ),
          },
          { title: t('platform.errorWhere'), render: (_: unknown, e) => [e.method, e.path].filter(Boolean).join(' ') || '—' },
          { title: t('platform.errorCount'), dataIndex: 'count', align: 'right', width: 80 },
          { title: t('platform.errorLastSeen'), dataIndex: 'lastSeenAt', width: 150, render: when },
          {
            title: '',
            width: 120,
            render: (_: unknown, e) => (
              <Button
                size="small"
                loading={toggle.isPending && toggle.variables?.id === e.id}
                onClick={(ev) => {
                  ev.stopPropagation();
                  toggle.mutate(e);
                }}
              >
                {e.resolvedAt ? t('platform.errorReopen') : t('platform.errorResolve')}
              </Button>
            ),
          },
        ]}
      />
      <Drawer open={!!openId} width={720} onClose={() => setOpenId(null)} title={detail ? `${detail.name}: ${detail.message}` : ''}>
        {detail && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('platform.errorSource')}>{t(`platform.errorSource_${detail.source}`)}</Descriptions.Item>
              <Descriptions.Item label={t('platform.errorWhere')}>{[detail.method, detail.path, detail.status].filter(Boolean).join(' ') || '—'}</Descriptions.Item>
              <Descriptions.Item label={t('platform.errorCount')}>{detail.count}</Descriptions.Item>
              <Descriptions.Item label={t('platform.errorFirstSeen')}>{when(detail.firstSeenAt)}</Descriptions.Item>
              <Descriptions.Item label={t('platform.errorLastSeen')}>{when(detail.lastSeenAt)}</Descriptions.Item>
              <Descriptions.Item label={t('platform.errorTenant')}>{detail.tenantId ?? '—'}</Descriptions.Item>
              <Descriptions.Item label={t('platform.errorRequest')}>{detail.requestId ?? '—'}</Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph style={{ marginTop: 16 }}>
              <Typography.Text code style={{ whiteSpace: 'pre-wrap', display: 'block', direction: 'ltr', textAlign: 'left' }}>
                {detail.stack ?? t('platform.errorNoStack')}
              </Typography.Text>
            </Typography.Paragraph>
          </>
        )}
      </Drawer>
    </>
  );
}
