import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  usersControllerInvite,
  usersControllerList,
  usersControllerReissueInvitationCode,
  usersControllerResetPassword,
  usersControllerRoles,
  usersControllerSuspend,
  usersControllerUpdate,
} from '@erp/api-client';
import { CheckOutlined, CopyOutlined, KeyOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { tableLocale } from '../components/QueryState';

interface Membership {
  membershipId: string;
  status: string;
  /** Null while an invited user has not accepted yet. */
  user: { id: string; email: string; fullName: string | null; isActive: boolean };
  role: { code: string; nameAr: string; nameEn: string | null };
  defaultBranch: { id: string; code: string; nameAr: string } | null;
  branches: { id: string; code: string; nameAr: string }[];
  temporaryPassword?: string;
  acceptanceCode?: string;
  acceptanceCodeExpiresAt?: string;
}

interface Role {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
}

/** An invitation code shown once; the admin hands it to the person directly. */
interface IssuedCode {
  value: string;
  expiresAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'green',
  INVITED: 'orange',
  SUSPENDED: 'red',
};

const DATE_FORMAT = 'YYYY-MM-DD HH:mm';
const CODE_FONT = "Consolas, 'Cascadia Mono', 'Courier New', monospace";

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm] = Form.useForm();
  // One modal shows whichever temporary password was just issued (invite or reset).
  const [tempPassword, setTempPassword] = useState<{
    value: string;
    purpose: 'invite' | 'reset';
  } | null>(null);
  // Acceptance code of an existing user: invited, or re-issued from the table.
  const [issuedCode, setIssuedCode] = useState<IssuedCode | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [apiMessage, contextHolder] = message.useMessage();

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersControllerList().then((r) => r.data as unknown as Membership[]),
  });
  const { data, isLoading } = usersQuery;

  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => usersControllerRoles().then((r) => r.data as unknown as Role[]),
  });

  const onError = (err: unknown) => {
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  };

  const openIssuedCode = (code: IssuedCode) => {
    setCodeCopied(false);
    setIssuedCode(code);
  };

  const copyCode = async () => {
    if (!issuedCode) return;
    try {
      await navigator.clipboard.writeText(issuedCode.value);
      setCodeCopied(true);
    } catch {
      apiMessage.error(t('users.codeCopyFailed'));
    }
  };

  const invite = useMutation({
    mutationFn: (values: { email: string; fullName?: string; roleCode: string }) =>
      usersControllerInvite({
        email: values.email,
        fullName: values.fullName || undefined,
        roleCode: values.roleCode,
      }),
    onSuccess: (res) => {
      const body = res.data as unknown as Membership;
      if (body.temporaryPassword) {
        setTempPassword({ value: body.temporaryPassword, purpose: 'invite' });
      } else if (body.acceptanceCode && body.acceptanceCodeExpiresAt) {
        openIssuedCode({ value: body.acceptanceCode, expiresAt: body.acceptanceCodeExpiresAt });
        setInviteOpen(false);
        inviteForm.resetFields();
      }
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError,
  });

  const reissue = useMutation({
    mutationFn: (membershipId: string) => usersControllerReissueInvitationCode(membershipId),
    onSuccess: (res) => {
      const body = res.data as unknown as { acceptanceCode: string; acceptanceCodeExpiresAt: string };
      openIssuedCode({ value: body.acceptanceCode, expiresAt: body.acceptanceCodeExpiresAt });
    },
    onError,
  });

  const changeRole = useMutation({
    mutationFn: ({ id, roleCode }: { id: string; roleCode: string }) =>
      usersControllerUpdate(id, { roleCode }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError,
  });

  const suspend = useMutation({
    mutationFn: (id: string) => usersControllerSuspend(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError,
  });

  // On an INVITED membership the same DELETE cancels the invitation instead.
  const cancelInvitation = useMutation({
    mutationFn: (membershipId: string) => usersControllerSuspend(membershipId),
    onSuccess: () => {
      apiMessage.success(t('users.invitationCancelled'));
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError,
  });

  const resetPassword = useMutation({
    mutationFn: (membershipId: string) => usersControllerResetPassword(membershipId),
    onSuccess: (res) => {
      const body = res.data as unknown as { temporaryPassword: string };
      setTempPassword({ value: body.temporaryPassword, purpose: 'reset' });
    },
    onError,
  });

  const roleName = (_code: string, ar: string, en: string | null) =>
    i18n.language === 'ar' ? ar : (en ?? ar);

  // Mirrors the server refusals in UsersService.resetPassword: no self-reset,
  // no suspended or invited members, and only an owner may reset an owner.
  const canResetPassword = (m: Membership) =>
    m.user.id !== me?.user.id &&
    m.status !== 'SUSPENDED' &&
    m.status !== 'INVITED' &&
    !(m.role.code === 'OWNER' && me?.currentMembership?.roleCode !== 'OWNER');

  // Mirrors the server refusals in UsersService.update/invite (PLAT-01): no one
  // changes their own role or status, and only an owner grants OWNER or
  // changes an owner's membership.
  const isOwner = me?.currentMembership?.roleCode === 'OWNER';
  const canManage = (m: Membership) =>
    m.user.id !== me?.user.id && (isOwner || m.role.code !== 'OWNER');
  const roleOptions = (roles ?? [])
    .filter((r) => isOwner || r.code !== 'OWNER')
    .map((r) => ({ value: r.code, label: roleName(r.code, r.nameAr, r.nameEn) }));

  const shown = (data ?? []).filter((m) =>
    matchesSearch(search, m.user.fullName ?? '', m.user.email),
  );

  return (
    <div>
      <PageHeader title={t('users.title')} />
      <Card>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={
          <Button type="primary" onClick={() => setInviteOpen(true)}>
            {t('users.invite')}
          </Button>
        }
      />
      <Table
        rowKey="membershipId"
        loading={isLoading}
        dataSource={shown}
        locale={tableLocale(usersQuery)}
        pagination={false}
        columns={[
          {
            title: t('users.name'),
            render: (_: unknown, m: Membership) =>
              m.status === 'INVITED' ? (
                <Typography.Text type="secondary">{t('users.notAcceptedYet')}</Typography.Text>
              ) : (
                m.user.fullName
              ),
          },
          { title: t('users.email'), render: (_: unknown, m: Membership) => m.user.email },
          {
            title: t('users.role'),
            render: (_: unknown, m: Membership) =>
              roleName(m.role.code, m.role.nameAr, m.role.nameEn),
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            render: (s: string) => <Tag color={STATUS_COLORS[s]}>{t(`users.status.${s}`)}</Tag>,
          },
          {
            title: t('users.actions'),
            render: (_: unknown, m: Membership) => (
              <Space wrap>
                {canManage(m) && (
                  <Select
                    size="small"
                    style={{ width: 140 }}
                    value={m.role.code}
                    onChange={(roleCode) => changeRole.mutate({ id: m.membershipId, roleCode })}
                    options={roleOptions}
                  />
                )}
                {canResetPassword(m) && (
                  <Popconfirm
                    title={t('users.resetPasswordConfirm')}
                    okText={t('common.ok')}
                    cancelText={t('common.cancel')}
                    onConfirm={() => resetPassword.mutate(m.membershipId)}
                  >
                    {/* Icon only: the actions column stays narrow next to role and suspend. */}
                    <Tooltip title={t('users.resetPassword')}>
                      <Button
                        size="small"
                        icon={<KeyOutlined />}
                        aria-label={t('users.resetPassword')}
                        loading={resetPassword.isPending && resetPassword.variables === m.membershipId}
                      />
                    </Tooltip>
                  </Popconfirm>
                )}
                {m.status === 'ACTIVE' && canManage(m) && (
                  <Button
                    size="small"
                    danger
                    onClick={() => suspend.mutate(m.membershipId)}
                  >
                    {t('users.suspend')}
                  </Button>
                )}
                {m.status === 'INVITED' && canManage(m) && (
                  <>
                    <Tooltip title={t('users.statusLockedInvited')}>
                      <span>
                        <Button size="small" disabled>
                          {t('users.suspend')}
                        </Button>
                      </span>
                    </Tooltip>
                    <Button
                      size="small"
                      loading={reissue.isPending && reissue.variables === m.membershipId}
                      onClick={() => reissue.mutate(m.membershipId)}
                    >
                      {t('users.newCode')}
                    </Button>
                    <Popconfirm
                      title={t('users.cancelInvitationConfirm')}
                      okText={t('common.ok')}
                      cancelText={t('common.cancel')}
                      onConfirm={() => cancelInvitation.mutate(m.membershipId)}
                    >
                      <Button
                        size="small"
                        danger
                        loading={cancelInvitation.isPending && cancelInvitation.variables === m.membershipId}
                      >
                        {t('users.cancelInvitation')}
                      </Button>
                    </Popconfirm>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      <FormDialog
        title={t('users.invite')}
        open={inviteOpen && tempPassword === null}
        onCancel={() => setInviteOpen(false)}
        onSave={() => inviteForm.submit()}
        saving={invite.isPending}
      >
        <Form
          form={inviteForm}
          layout="vertical"
          onFinish={(v) => invite.mutate(v)}
        >
          <FormSection title={t('users.details')} icon={<UserOutlined />}>
            <Form.Item name="email" label={t('users.email')} rules={[{ required: true, type: 'email' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="fullName" label={t('users.name')}>
              <Input />
            </Form.Item>
            <Form.Item name="roleCode" label={t('users.role')} rules={[{ required: true }]}>
              <Select options={roleOptions} />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>

      <Modal
        title={
          tempPassword?.purpose === 'reset'
            ? t('users.resetPasswordTitle')
            : t('users.tempPasswordTitle')
        }
        open={tempPassword !== null}
        footer={[
          <Button
            key="ok"
            type="primary"
            onClick={() => {
              setTempPassword(null);
              setInviteOpen(false);
              inviteForm.resetFields();
            }}
          >
            {t('common.ok')}
          </Button>,
        ]}
      >
        <p>
          {tempPassword?.purpose === 'reset'
            ? t('users.resetPasswordBody')
            : t('users.tempPasswordBody')}
        </p>
        <Typography.Text code copyable>
          {tempPassword?.value}
        </Typography.Text>
      </Modal>

      <Modal
        title={t('users.codeTitle')}
        open={issuedCode !== null}
        onCancel={() => setIssuedCode(null)}
        footer={[
          <Button key="ok" type="primary" onClick={() => setIssuedCode(null)}>
            {t('common.ok')}
          </Button>,
        ]}
      >
        <p>{t('users.codeBody')}</p>
        <Space wrap size={12} align="center">
          <Typography.Text
            strong
            style={{
              fontFamily: CODE_FONT,
              fontSize: 28,
              letterSpacing: 4,
              direction: 'ltr',
              unicodeBidi: 'isolate',
            }}
          >
            {issuedCode?.value}
          </Typography.Text>
          <Button
            icon={codeCopied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={() => void copyCode()}
          >
            {codeCopied ? t('users.codeCopied') : t('users.codeCopy')}
          </Button>
        </Space>
        <p>
          <Typography.Text type="secondary">
            {t('users.codeExpires', {
              // First-strong isolate: the date keeps its left-to-right order inside an Arabic sentence.
              date: issuedCode ? `⁨${dayjs(issuedCode.expiresAt).format(DATE_FORMAT)}⁩` : '',
            })}
          </Typography.Text>
        </p>
      </Modal>
      </Card>
    </div>
  );
}
