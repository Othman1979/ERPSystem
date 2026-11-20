import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BankOutlined } from '@ant-design/icons';
import { App, Button, Form, Input, Popconfirm, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  companiesControllerCreate,
  companiesControllerList,
  companiesControllerUpdate,
  type CompanyEntryDto,
} from '@erp/api-client';
import { FormDialog, FormSection } from '../../components/FormDialog';
import { tableLocale } from '../../components/QueryState';
import { ActiveTag } from '../../components/StatusTag';
import { useAuth } from '../../auth/AuthContext';

const COMPANIES_QUERY_KEY = ['companies'];

interface CompanyForm {
  legalNameAr: string;
  legalNameEn?: string;
}

/** ADR-040 §4: the owner adds, renames and deactivates the tenant's companies. */
export function CompaniesTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { refreshMe } = useAuth();
  const [form] = Form.useForm<CompanyForm>();
  const [dialog, setDialog] = useState<{ mode: 'new' } | { mode: 'edit'; row: CompanyEntryDto } | null>(null);

  const list = useQuery({
    queryKey: COMPANIES_QUERY_KEY,
    queryFn: async () => (await companiesControllerList()).data,
  });
  const showError = (err: unknown) =>
    message.error(
      err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
    );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: COMPANIES_QUERY_KEY });
    void refreshMe();
  };

  const save = useMutation({
    mutationFn: (v: CompanyForm): Promise<unknown> =>
      dialog?.mode === 'edit'
        ? companiesControllerUpdate(dialog.row.id, { legalNameAr: v.legalNameAr, legalNameEn: v.legalNameEn ?? '' })
        : companiesControllerCreate({ legalNameAr: v.legalNameAr, legalNameEn: v.legalNameEn || undefined }),
    onSuccess: () => {
      message.success(t('companies.saved'));
      setDialog(null);
      form.resetFields();
      refresh();
    },
    onError: showError,
  });
  const setActive = useMutation({
    mutationFn: (r: CompanyEntryDto) => companiesControllerUpdate(r.id, { isActive: !r.isActive }),
    onSuccess: refresh,
    onError: showError,
  });

  const open = (next: NonNullable<typeof dialog>) => {
    form.setFieldsValue(
      next.mode === 'edit'
        ? { legalNameAr: next.row.legalNameAr, legalNameEn: next.row.legalNameEn ?? '' }
        : { legalNameAr: '', legalNameEn: '' },
    );
    setDialog(next);
  };

  return (
    <>
      <Button type="primary" style={{ marginBottom: 16 }} onClick={() => open({ mode: 'new' })}>
        {t('companies.new')}
      </Button>
      <Table<CompanyEntryDto>
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data ?? []}
        locale={tableLocale(list)}
        pagination={false}
        columns={[
          {
            title: t('companies.nameAr'),
            key: 'nameAr',
            render: (_: unknown, r) => (
              <Space>
                {r.legalNameAr}
                {r.current && <Tag color="blue">{t('companies.current')}</Tag>}
              </Space>
            ),
          },
          { title: t('companies.nameEn'), dataIndex: 'legalNameEn', key: 'nameEn' },
          { title: t('common.status'), key: 'active', render: (_: unknown, r) => <ActiveTag active={r.isActive} /> },
          {
            title: t('common.actions'),
            key: 'actions',
            render: (_: unknown, r) => (
              <Space>
                <Button size="small" onClick={() => open({ mode: 'edit', row: r })}>
                  {t('common.edit')}
                </Button>
                <Popconfirm
                  title={r.isActive ? t('companies.deactivateConfirm') : t('companies.activateConfirm')}
                  onConfirm={() => setActive.mutate(r)}
                >
                  <Button size="small" danger={r.isActive}>
                    {r.isActive ? t('companies.deactivate') : t('companies.activate')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <FormDialog
        title={dialog?.mode === 'edit' ? t('companies.edit') : t('companies.new')}
        open={dialog !== null}
        onCancel={() => setDialog(null)}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection title={t('companies.title')} icon={<BankOutlined />}>
            <Form.Item name="legalNameAr" label={t('companies.nameAr')} rules={[{ required: true, whitespace: true }]}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="legalNameEn" label={t('companies.nameEn')}>
              <Input maxLength={191} dir="ltr" />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
    </>
  );
}
