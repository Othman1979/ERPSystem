import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApartmentOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Form, Input, Popconfirm, Space, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  type CostCenterDto,
  costCentersControllerCreate,
  costCentersControllerRemove,
  costCentersControllerUpdate,
} from '@erp/api-client';
import { FormDialog, FormSection } from '../../components/FormDialog';
import { ActiveTag } from '../../components/StatusTag';
import { tableLocale } from '../../components/QueryState';
import { useAuth } from '../../auth/AuthContext';
import { PERMISSIONS } from '../../auth/permissions';
import { COST_CENTERS_QUERY_KEY, useCostCenters } from '../../hooks/useCostCenters';
import { codeAndName, displayName } from '../../i18n/displayName';
import { costCenterTree, type CostCenterNode } from './costCenterTree';

interface CentreForm {
  code?: string;
  nameAr: string;
  nameEn?: string;
}

/** The dialog is either a new centre (optionally under a parent) or an edit of one row. */
type DialogState = { mode: 'create'; parent: CostCenterDto | null } | { mode: 'edit'; row: CostCenterDto };

/**
 * The company's cost-centre tree (ADR-024 §1), managed from the settings.
 * Reading is open to every member; the actions need `cost_center.manage`.
 * The list is fetched even while the company switch is off, so the tree can
 * be prepared before the centres are turned on.
 */
export function CostCentersTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSIONS.COST_CENTER_MANAGE);
  const { enabled, list, rows } = useCostCenters({ always: true });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [form] = Form.useForm<CentreForm>();

  const tree = useMemo(() => costCenterTree(rows), [rows]);
  // Every group starts expanded. The rows arrive after mount, so the expansion is
  // driven by the data (only the rows the user collapsed are kept aside).
  const groupIds = useMemo(() => {
    const parents = new Set(rows.map((r) => r.parentId).filter((id): id is string => !!id));
    return rows.filter((r) => parents.has(r.id)).map((r) => r.id);
  }, [rows]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const expandedKeys = groupIds.filter((id) => !collapsed.has(id));

  const showError = (err: unknown) =>
    message.error(
      err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
    );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: COST_CENTERS_QUERY_KEY });

  const save = useMutation({
    mutationFn: (v: CentreForm): Promise<unknown> => {
      if (dialog?.mode === 'edit') {
        return costCentersControllerUpdate(dialog.row.id, { nameAr: v.nameAr, nameEn: v.nameEn || null });
      }
      return costCentersControllerCreate({
        code: v.code ?? '',
        nameAr: v.nameAr,
        nameEn: v.nameEn || undefined,
        parentId: dialog?.parent?.id,
      });
    },
    onSuccess: () => {
      message.success(t('costCenters.saved'));
      setDialog(null);
      form.resetFields();
      refresh();
    },
    onError: showError,
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      costCentersControllerUpdate(id, { isActive }),
    onSuccess: refresh,
    onError: showError,
  });

  const remove = useMutation({
    mutationFn: (c: CostCenterNode) => costCentersControllerRemove(c.id),
    onSuccess: () => {
      message.success(t('costCenters.deleted'));
      refresh();
    },
    onError: (err, c) => {
      // A centre already used by entries or documents is not deleted: offer to deactivate it instead.
      if (err instanceof ApiError && err.code === 'COST_CENTER_IN_USE') {
        modal.confirm({
          title: t('costCenters.deactivateConfirm', { name: displayName(c) }),
          content: t('errors.COST_CENTER_IN_USE'),
          okText: t('costCenters.deactivate'),
          okButtonProps: { danger: true },
          cancelText: t('common.cancel'),
          onOk: () => setActive.mutate({ id: c.id, isActive: false }),
        });
        return;
      }
      showError(err);
    },
  });

  const openCreate = (parent: CostCenterDto | null) => {
    form.resetFields();
    setDialog({ mode: 'create', parent });
  };
  const openEdit = (row: CostCenterDto) => {
    form.resetFields();
    form.setFieldsValue({ nameAr: row.nameAr, nameEn: row.nameEn ?? undefined });
    setDialog({ mode: 'edit', row });
  };

  const dialogTitle =
    dialog?.mode === 'edit'
      ? t('costCenters.edit')
      : dialog?.parent
        ? t('costCenters.addChild')
        : t('costCenters.add');

  return (
    <Card size="small">
      {!enabled && <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('costCenters.disabledNote')} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <Typography.Text type="secondary">{t('costCenters.intro')}</Typography.Text>
        {canManage && (
          <Button type="primary" onClick={() => openCreate(null)} style={{ flexShrink: 0 }}>
            {t('costCenters.add')}
          </Button>
        )}
      </div>
      <Table<CostCenterNode>
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={tree}
        locale={tableLocale(list, t('costCenters.empty'))}
        pagination={false}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpand: (open, row) =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (open) next.delete(row.id);
              else next.add(row.id);
              return next;
            }),
        }}
        columns={[
          { title: t('costCenters.code'), dataIndex: 'code', width: 130 },
          { title: t('costCenters.name'), key: 'name', render: (_: unknown, c: CostCenterNode) => displayName(c) },
          {
            title: t('costCenters.kind'),
            key: 'kind',
            width: 120,
            render: (_: unknown, c: CostCenterNode) => (c.isPostable ? t('costCenters.leaf') : t('costCenters.group')),
          },
          {
            title: t('costCenters.status'),
            dataIndex: 'isActive',
            width: 100,
            render: (v: boolean) => <ActiveTag active={v} />,
          },
          ...(canManage
            ? [
                {
                  title: t('common.actions'),
                  key: 'actions',
                  width: 360,
                  render: (_: unknown, c: CostCenterNode) => (
                    <Space wrap>
                      <Button size="small" onClick={() => openEdit(c)}>
                        {t('common.edit')}
                      </Button>
                      {c.isActive && (
                        <Button size="small" onClick={() => openCreate(c)}>
                          {t('costCenters.addChild')}
                        </Button>
                      )}
                      {c.isActive ? (
                        <Popconfirm
                          title={t('costCenters.deactivateConfirm', { name: displayName(c) })}
                          onConfirm={() => setActive.mutate({ id: c.id, isActive: false })}
                        >
                          <Button size="small" danger>
                            {t('costCenters.deactivate')}
                          </Button>
                        </Popconfirm>
                      ) : (
                        <Button size="small" onClick={() => setActive.mutate({ id: c.id, isActive: true })}>
                          {t('costCenters.reactivate')}
                        </Button>
                      )}
                      <Popconfirm
                        title={t('costCenters.deleteConfirm', { name: displayName(c) })}
                        onConfirm={() => remove.mutate(c)}
                      >
                        <Button size="small" danger>
                          {t('costCenters.delete')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
       scroll={{ x: 'max-content' }}/>
      <FormDialog
        title={dialogTitle}
        open={dialog !== null}
        onCancel={() => setDialog(null)}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection title={t('costCenters.title')} icon={<ApartmentOutlined />}>
            {dialog?.mode !== 'edit' && (
              <Form.Item name="code" label={t('costCenters.code')} rules={[{ required: true, whitespace: true }]}>
                <Input maxLength={50} dir="ltr" />
              </Form.Item>
            )}
            {dialog?.mode === 'create' && dialog.parent && (
              <Form.Item label={t('costCenters.parent')}>
                <Input value={codeAndName(dialog.parent)} disabled />
              </Form.Item>
            )}
            <Form.Item name="nameAr" label={t('costCenters.nameAr')} rules={[{ required: true, whitespace: true }]}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('costCenters.nameEn')}>
              <Input maxLength={191} dir="ltr" />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
    </Card>
  );
}
