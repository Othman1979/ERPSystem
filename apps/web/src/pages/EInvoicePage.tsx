import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReloadOutlined, SendOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Descriptions,
  Drawer,
  Grid,
  Modal,
  QRCode,
  Select,
  Skeleton,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetchData } from '@erp/api-client';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { tableLocale } from '../components/QueryState';
import { Num } from '../components/Num';
import { PageHeader } from '../components/PageHeader';
import { idemHeaders } from '../idempotency';
import {
  EINVOICE_STATUSES,
  EInvoiceStatusTag,
  isInFlight,
  type EInvoiceError,
  type EInvoiceStatus,
} from './einvoice/EInvoiceStatus';

type DocumentType = 'SALES_INVOICE' | 'SALES_RETURN';

interface Submission {
  id: string;
  documentType: DocumentType;
  documentId: string;
  documentNo: string;
  uuid: string;
  icv: number;
  environment: 'SANDBOX' | 'PRODUCTION';
  status: EInvoiceStatus;
  attemptCount: number;
  errors: EInvoiceError[] | null;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Attempt {
  attemptNo: number;
  outcome: 'accepted' | 'rejected' | 'unknown' | 'not-sent';
  httpStatus: number | null;
  message: string | null;
  startedAt: string;
  finishedAt: string;
}

interface SubmissionDetail extends Submission {
  qrPayload: string | null;
  governmentUuid: string | null;
  requestXml: string | null;
  responseCode: number | null;
  responseBody: string | null;
  originalSubmission: { id: string; documentNo: string; status: EInvoiceStatus } | null;
  attempts: Attempt[];
}

interface SubmissionList {
  rows: Submission[];
  counts: Partial<Record<EInvoiceStatus, number>>;
}

const RESENDABLE: EInvoiceStatus[] = ['REJECTED', 'FAILED', 'UNKNOWN'];

const OUTCOME_COLORS: Record<Attempt['outcome'], string> = {
  accepted: 'success',
  rejected: 'error',
  unknown: 'warning',
  'not-sent': 'volcano',
};
const OUTCOME_KEYS: Record<Attempt['outcome'], string> = {
  accepted: 'einvoice.outcomes.accepted',
  rejected: 'einvoice.outcomes.rejected',
  unknown: 'einvoice.outcomes.unknown',
  'not-sent': 'einvoice.outcomes.notSent',
};

const dateTime = (v: string | null | undefined) =>
  v ? <Num>{dayjs(v).format('YYYY-MM-DD HH:mm')}</Num> : '—';

/** A JSON answer reads better indented; anything else is shown as it came. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** E-invoice status: every document sent to JoFotara, what it answered, and resend (Phase 7). */
export function EInvoicePage() {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<EInvoiceStatus | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState<DocumentType | undefined>(undefined);
  const [search, setSearch] = useState('');
  // The last opened row stays loaded while the drawer slides shut.
  const [openId, setOpenId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['einvoice-submissions', statusFilter, typeFilter],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams();
      if (statusFilter) q.set('status', statusFilter);
      if (typeFilter) q.set('documentType', typeFilter);
      return apiFetchData<SubmissionList>(`/api/v1/einvoice/submissions?${q.toString()}`, { signal });
    },
    // The worker sends in the background: follow documents still on their way.
    refetchInterval: (query) => (query.state.data?.rows.some((r) => isInFlight(r.status)) ? 5000 : false),
  });
  const { data, isLoading, isFetching, refetch, error } = listQuery;

  const counts = data?.counts ?? {};
  const shown = (data?.rows ?? []).filter((r) => matchesSearch(search, r.documentNo, r.uuid));

  const columns = [
    {
      title: t('einvoice.documentType'),
      dataIndex: 'documentType',
      width: 130,
      render: (v: DocumentType) => t(`einvoice.type_${v}`),
    },
    {
      title: t('einvoice.documentNo'),
      dataIndex: 'documentNo',
      width: 170,
      render: (v: string) => <span className="doc-no">{v}</span>,
    },
    {
      title: t('einvoice.icv'),
      dataIndex: 'icv',
      width: 80,
      align: 'right' as const,
      render: (v: number) => <Num>{v}</Num>,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 130,
      render: (v: EInvoiceStatus) => <EInvoiceStatusTag status={v} />,
    },
    {
      title: t('einvoice.attempts'),
      dataIndex: 'attemptCount',
      width: 90,
      align: 'right' as const,
      render: (v: number) => <Num>{v}</Num>,
    },
    {
      title: t('einvoice.lastError'),
      dataIndex: 'errors',
      width: 320,
      ellipsis: { showTitle: false },
      render: (v: EInvoiceError[] | null) =>
        v && v.length > 0 ? (
          <Tooltip title={v.map((e) => e.message).join(' • ')}>
            <span>
              {v[0].message}
              {v.length > 1 && ` (+${v.length - 1})`}
            </span>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    {
      title: t('einvoice.sentAt'),
      dataIndex: 'sentAt',
      width: 140,
      render: dateTime,
    },
  ];

  return (
    <div>
      <PageHeader title={t('einvoice.title')} />
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder={t('einvoice.searchPlaceholder')}
        filters={
          <>
            <Select
              allowClear
              placeholder={t('common.status')}
              value={statusFilter}
              onChange={setStatusFilter}
              popupMatchSelectWidth={false}
              options={EINVOICE_STATUSES.map((s) => ({
                value: s,
                label: `${t(`einvoice.statuses.${s}`)} (${counts[s] ?? 0})`,
              }))}
            />
            <Select
              allowClear
              placeholder={t('einvoice.documentType')}
              value={typeFilter}
              onChange={setTypeFilter}
              popupMatchSelectWidth={false}
              options={[
                { value: 'SALES_INVOICE', label: t('einvoice.type_SALES_INVOICE') },
                { value: 'SALES_RETURN', label: t('einvoice.type_SALES_RETURN') },
              ]}
            />
          </>
        }
        count={shown.length}
        actions={
          <Button icon={<ReloadOutlined />} loading={isFetching && !isLoading} onClick={() => void refetch()}>
            {t('einvoice.refresh')}
          </Button>
        }
      />
      {error && (
        <Alert
          banner
          type="error"
          showIcon
          message={
            error instanceof ApiError
              ? t(`errors.${error.code}`, { defaultValue: error.message })
              : t('errors.INTERNAL')
          }
        />
      )}
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={shown}
        locale={tableLocale(listQuery)}
        columns={columns}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 'max-content' }}
        onRow={(r) => ({
          onClick: () => {
            setOpenId(r.id);
            setDrawerOpen(true);
          },
          style: { cursor: 'pointer' },
        })}
      />
      <SubmissionDrawer id={openId} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}

// ------------------------------------------------------------- details

function SubmissionDrawer({ id, open, onClose }: { id: string | null; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  const [apiMessage, contextHolder] = message.useMessage();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['einvoice-submission', id],
    queryFn: ({ signal }) => apiFetchData<SubmissionDetail>(`/api/v1/einvoice/submissions/${id}`, { signal }),
    // Disabled while closed, so reopening a row fetches it fresh.
    enabled: open && !!id,
    refetchInterval: (query) => (isInFlight(query.state.data?.status) ? 4000 : false),
  });

  const resend = useMutation({
    mutationFn: (subId: string) =>
      apiFetchData<SubmissionDetail>(`/api/v1/einvoice/submissions/${subId}/resend`, {
        method: 'POST',
        headers: idemHeaders(),
      }),
    onSuccess: (updated) => {
      setConfirmOpen(false);
      apiMessage.success(t('einvoice.resendQueued'));
      queryClient.setQueryData(['einvoice-submission', updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['einvoice-submissions'] });
      void queryClient.invalidateQueries({ queryKey: ['sales-invoice'] });
      void queryClient.invalidateQueries({ queryKey: ['sales-return'] });
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
      ),
  });

  const sub = data && data.id === id ? data : undefined;
  const canResend = !!sub && RESENDABLE.includes(sub.status);
  const errors = sub?.errors ?? [];
  // Collapsed by default: the XML and the raw answer are for whoever diagnoses a rejection.
  const technical = [
    ...(sub?.requestXml
      ? [
          {
            key: 'xml',
            label: t('einvoice.requestXml'),
            children: <pre className="einvoice-xml">{sub.requestXml}</pre>,
          },
        ]
      : []),
    ...(sub?.responseBody
      ? [
          {
            key: 'response',
            label: t('einvoice.responseBody'),
            children: <pre className="einvoice-xml">{pretty(sub.responseBody)}</pre>,
          },
        ]
      : []),
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={screens.md === false ? '100%' : 680}
      placement={i18n.dir() === 'rtl' ? 'left' : 'right'}
      title={
        sub ? (
          <span className="einvoice-drawer-title">
            {t(`einvoice.type_${sub.documentType}`)}
            <span className="doc-no">{sub.documentNo}</span>
            <EInvoiceStatusTag status={sub.status} />
          </span>
        ) : (
          t('common.loading')
        )
      }
      extra={
        canResend && (
          <Button type="primary" icon={<SendOutlined />} onClick={() => setConfirmOpen(true)}>
            {t('einvoice.resend')}
          </Button>
        )
      }
    >
      {contextHolder}
      {isLoading || !sub ? (
        <Skeleton active />
      ) : (
        <div className="einvoice-detail">
          <Alert
            type={
              sub.status === 'ACCEPTED'
                ? 'success'
                : sub.status === 'REJECTED' || sub.status === 'FAILED'
                  ? 'error'
                  : sub.status === 'UNKNOWN'
                    ? 'warning'
                    : 'info'
            }
            showIcon
            message={t(`einvoice.statuses.${sub.status}`)}
            description={t(`einvoice.statusHints.${sub.status}`)}
          />

          {sub.status === 'ACCEPTED' && sub.qrPayload && (
            <div className="einvoice-qr-panel">
              <QRCode value={sub.qrPayload} type="svg" size={160} bordered={false} />
              <strong>{t('einvoice.acceptedCaption')}</strong>
            </div>
          )}

          <Descriptions size="small" bordered column={screens.md === false ? 1 : 2}>
            <Descriptions.Item label={t('einvoice.icv')}>
              <Num>{sub.icv}</Num>
            </Descriptions.Item>
            <Descriptions.Item label={t('einvoice.environment')}>
              {t(`einvoice.env_${sub.environment}`)}
            </Descriptions.Item>
            <Descriptions.Item label={t('einvoice.uuid')} span="filled">
              <span className="doc-no">{sub.uuid}</span>
            </Descriptions.Item>
            {sub.governmentUuid && (
              <Descriptions.Item label={t('einvoice.governmentUuid')} span="filled">
                <span className="doc-no">{sub.governmentUuid}</span>
              </Descriptions.Item>
            )}
            <Descriptions.Item label={t('einvoice.sentAt')}>{dateTime(sub.sentAt)}</Descriptions.Item>
            <Descriptions.Item label={t('einvoice.completedAt')}>{dateTime(sub.completedAt)}</Descriptions.Item>
            <Descriptions.Item label={t('einvoice.attempts')}>
              <Num>{sub.attemptCount}</Num>
            </Descriptions.Item>
            <Descriptions.Item label={t('einvoice.responseCode')}>
              {sub.responseCode != null ? <Num>{sub.responseCode}</Num> : '—'}
            </Descriptions.Item>
            {sub.originalSubmission && (
              <Descriptions.Item label={t('einvoice.originalDocument')} span="filled">
                <span className="einvoice-drawer-title">
                  <span className="doc-no">{sub.originalSubmission.documentNo}</span>
                  <EInvoiceStatusTag status={sub.originalSubmission.status} />
                </span>
              </Descriptions.Item>
            )}
          </Descriptions>

          {errors.length > 0 && (
            <section>
              <Typography.Title level={5}>{t('einvoice.errorsTitle')}</Typography.Title>
              <Table
                size="small"
                pagination={false}
                dataSource={errors.map((e, i) => ({ ...e, key: i }))}
                columns={[
                  {
                    title: t('einvoice.errorSource'),
                    dataIndex: 'source',
                    width: 110,
                    render: (v: EInvoiceError['source']) => (
                      <Tag color={v === 'jofotara' ? 'blue' : 'default'}>{t(`einvoice.source_${v}`)}</Tag>
                    ),
                  },
                  {
                    title: t('einvoice.errorCode'),
                    dataIndex: 'code',
                    width: 140,
                    render: (v: string) => <span className="doc-no">{v}</span>,
                  },
                  { title: t('einvoice.message'), dataIndex: 'message' },
                ]}
              />
            </section>
          )}

          <section>
            <Typography.Title level={5}>{t('einvoice.attemptsTitle')}</Typography.Title>
            <Table
              rowKey="attemptNo"
              size="small"
              pagination={false}
              dataSource={sub.attempts}
              locale={{ emptyText: t('einvoice.noAttempts') }}
              columns={[
                { title: '#', dataIndex: 'attemptNo', width: 50 },
                {
                  title: t('einvoice.outcome'),
                  dataIndex: 'outcome',
                  width: 110,
                  render: (v: Attempt['outcome']) => <Tag color={OUTCOME_COLORS[v]}>{t(OUTCOME_KEYS[v])}</Tag>,
                },
                {
                  title: t('einvoice.httpStatus'),
                  dataIndex: 'httpStatus',
                  width: 70,
                  render: (v: number | null) => (v != null ? <Num>{v}</Num> : '—'),
                },
                { title: t('einvoice.message'), dataIndex: 'message', render: (v: string | null) => v ?? '—' },
                { title: t('einvoice.startedAt'), dataIndex: 'startedAt', width: 140, render: dateTime },
              ]}
            />
          </section>

          {technical.length > 0 && <Collapse size="small" items={technical} />}
        </div>
      )}

      {confirmOpen && sub && (
        <ResendDialog
          status={sub.status}
          loading={resend.isPending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => resend.mutate(sub.id)}
        />
      )}
    </Drawer>
  );
}

/**
 * Resend confirmation. UNKNOWN re-sends the exact XML, which JoFotara may
 * already have recorded: the user must first confirm they checked the portal.
 */
function ResendDialog({
  status,
  loading,
  onCancel,
  onConfirm,
}: {
  status: EInvoiceStatus;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(false);
  const isUnknown = status === 'UNKNOWN';
  return (
    <Modal
      open
      title={t('einvoice.resendTitle')}
      okText={t('einvoice.resend')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: isUnknown && !checked, danger: isUnknown }}
      confirmLoading={loading}
      onOk={onConfirm}
      onCancel={onCancel}
    >
      {isUnknown ? (
        <>
          <Alert type="warning" showIcon message={t('einvoice.resendUnknown')} style={{ marginBottom: 12 }} />
          <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)}>
            {t('einvoice.resendUnknownCheck')}
          </Checkbox>
        </>
      ) : (
        <Typography.Paragraph style={{ margin: 0 }}>
          {status === 'REJECTED' ? t('einvoice.resendRejected') : t('einvoice.resendFailed')}
        </Typography.Paragraph>
      )}
    </Modal>
  );
}
