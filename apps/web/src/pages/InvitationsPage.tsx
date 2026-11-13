import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  ApiError,
  invitationsControllerAccept,
  invitationsControllerDecline,
  invitationsControllerList,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';

interface Invitation {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  role: { code: string; nameAr: string; nameEn: string | null };
  invitedBy: { fullName: string; email: string } | null;
  invitedAt: string;
  codeExpiresAt: string;
}

const DATE_FORMAT = 'YYYY-MM-DD HH:mm';

/** A date and time kept left to right inside the Arabic layout. */
function LtrDate({ value }: { value: string }) {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {dayjs(value).format(DATE_FORMAT)}
    </span>
  );
}
const CODE_FONT = "Consolas, 'Cascadia Mono', 'Courier New', monospace";

/**
 * The signed-in user's own company invitations (ADR-012 §PLAT-10). Makes no
 * tenant-scoped requests, so it also works for a user with no company yet.
 */
export function InvitationsPage() {
  const { t, i18n } = useTranslation();
  const { switchTenant, refreshMe } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [form] = Form.useForm<{ code: string }>();
  const [accepting, setAccepting] = useState<Invitation | null>(null);
  // What the server said about the last code, shown inside the accept dialog.
  const [codeError, setCodeError] = useState<{ title: string; description: string } | null>(null);

  const query = useQuery({
    queryKey: ['invitations'],
    queryFn: () => invitationsControllerList().then((r) => r.data as unknown as Invitation[]),
  });
  const { data, isLoading } = query;

  const roleName = (ar: string, en: string | null) => (i18n.language === 'ar' ? ar : (en ?? ar));

  const closeAccept = () => {
    setAccepting(null);
    setCodeError(null);
    form.resetFields();
  };

  const onError = (err: unknown) => {
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  };

  const accept = useMutation({
    mutationFn: ({ membershipId, code }: { membershipId: string; code: string }) =>
      invitationsControllerAccept(membershipId, { code }),
    onSuccess: async (res) => {
      const body = res.data as unknown as { tenantId: string };
      // Same company switch as the selector in the top bar. It remounts the app
      // while the new company loads, so the redirect to home comes after it.
      await switchTenant(body.tenantId);
      navigate('/', { replace: true });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'INVITATION_CODE_INVALID') {
        const attemptsLeft = err.details?.attemptsLeft;
        const wrongCode = err.details?.reason === 'WRONG_CODE' && typeof attemptsLeft === 'number';
        setCodeError({
          title: t('errors.INVITATION_CODE_INVALID'),
          description: wrongCode
            ? t('invitations.attemptsLeft', { count: attemptsLeft })
            : t('invitations.askNewCode'),
        });
        return;
      }
      onError(err);
    },
  });

  const decline = useMutation({
    mutationFn: (membershipId: string) => invitationsControllerDecline(membershipId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
      // Keeps the pending count shown in the menu up to date.
      await refreshMe();
    },
    onError,
  });

  return (
    <div>
      <PageHeader title={t('invitations.title')} subtitle={t('invitations.subtitle')} />
      <Card>
        {contextHolder}
        <Table
          rowKey="membershipId"
          loading={isLoading}
          dataSource={data ?? []}
          locale={tableLocale(query, t('invitations.empty'))}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: t('invitations.company'),
              render: (_: unknown, i: Invitation) => <Typography.Text strong>{i.tenantName}</Typography.Text>,
            },
            {
              title: t('invitations.role'),
              render: (_: unknown, i: Invitation) => roleName(i.role.nameAr, i.role.nameEn),
            },
            {
              title: t('invitations.invitedBy'),
              render: (_: unknown, i: Invitation) =>
                i.invitedBy ? (
                  <>
                    {i.invitedBy.fullName}
                    <br />
                    <Typography.Text type="secondary">{i.invitedBy.email}</Typography.Text>
                  </>
                ) : (
                  '—'
                ),
            },
            {
              title: t('invitations.invitedAt'),
              render: (_: unknown, i: Invitation) => <LtrDate value={i.invitedAt} />,
            },
            {
              title: t('invitations.codeExpires'),
              render: (_: unknown, i: Invitation) => {
                const expired = dayjs(i.codeExpiresAt).isBefore(dayjs());
                return (
                  <Space size={6}>
                    <LtrDate value={i.codeExpiresAt} />
                    {expired && <Tag color="red">{t('invitations.expired')}</Tag>}
                  </Space>
                );
              },
            },
            {
              title: t('users.actions'),
              render: (_: unknown, i: Invitation) => (
                <Space>
                  <Button type="primary" size="small" onClick={() => setAccepting(i)}>
                    {t('invitations.accept')}
                  </Button>
                  <Popconfirm
                    title={t('invitations.declineConfirm')}
                    okText={t('invitations.decline')}
                    cancelText={t('common.cancel')}
                    onConfirm={() => decline.mutate(i.membershipId)}
                  >
                    <Button
                      size="small"
                      danger
                      loading={decline.isPending && decline.variables === i.membershipId}
                    >
                      {t('invitations.decline')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={t('invitations.acceptTitle')}
        open={accepting !== null}
        onCancel={closeAccept}
        onOk={() => form.submit()}
        okText={t('invitations.accept')}
        cancelText={t('common.cancel')}
        confirmLoading={accept.isPending}
        destroyOnHidden
      >
        <Typography.Paragraph>
          {t('invitations.acceptBody', { company: accepting?.tenantName ?? '' })}
        </Typography.Paragraph>
        {codeError && (
          <Alert
            type="error"
            showIcon
            message={codeError.title}
            description={codeError.description}
            style={{ marginBottom: 16 }}
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onFinish={({ code }) =>
            accepting && accept.mutate({ membershipId: accepting.membershipId, code: code.trim() })
          }
        >
          <Form.Item
            name="code"
            label={t('invitations.codeLabel')}
            normalize={(v: string) => v.toUpperCase()}
            rules={[{ required: true, whitespace: true }]}
          >
            <Input
              autoFocus
              autoComplete="one-time-code"
              spellCheck={false}
              style={{ fontFamily: CODE_FONT, direction: 'ltr', letterSpacing: 2 }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
