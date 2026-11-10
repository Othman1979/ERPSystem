import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  settingsControllerCreatePaymentMethod,
  settingsControllerCreateTaxCategory,
  settingsControllerCreateUnit,
  settingsControllerListPaymentMethods,
  settingsControllerListTaxCategories,
  settingsControllerListUnits,
  settingsControllerUpdatePaymentMethod,
  settingsControllerUpdateTaxCategory,
  settingsControllerUpdateUnit,
} from '@erp/api-client';
import { SettingOutlined } from '@ant-design/icons';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { displayName } from '../i18n/displayName';
import { Num } from '../components/Num';
import { formatPercent } from '../format/number';

type LookupKind = 'unit' | 'taxCategory' | 'paymentMethod';

interface LookupRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
  rate?: string;
  isDefault?: boolean;
  einvoiceCode?: string | null;
  unEceCode?: string | null;
}

const LIST_FN = {
  unit: settingsControllerListUnits,
  taxCategory: settingsControllerListTaxCategories,
  paymentMethod: settingsControllerListPaymentMethods,
} as const;
const CREATE_FN = {
  unit: settingsControllerCreateUnit,
  taxCategory: settingsControllerCreateTaxCategory,
  paymentMethod: settingsControllerCreatePaymentMethod,
} as const;
const UPDATE_FN = {
  unit: settingsControllerUpdateUnit,
  taxCategory: settingsControllerUpdateTaxCategory,
  paymentMethod: settingsControllerUpdatePaymentMethod,
} as const;

function LookupTable({ kind, title }: { kind: LookupKind; title: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LookupRow | null>(null);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();
  const queryKey = ['settings', kind];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => LIST_FN[kind]().then((r) => r.data as unknown as LookupRow[]),
  });

  const showError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const save = useMutation({
    mutationFn: async (v: {
      code?: string;
      nameAr: string;
      nameEn?: string;
      rate?: string;
      isDefault?: boolean;
      einvoiceCode?: string;
      unEceCode?: string;
    }) => {
      const base = {
        nameAr: v.nameAr,
        nameEn: v.nameEn || null,
      };
      if (editing) {
        const upd =
          kind === 'taxCategory'
            ? { ...base, rate: v.rate, isDefault: v.isDefault, einvoiceCode: v.einvoiceCode || null }
            : { ...base, unEceCode: v.unEceCode || null };
        return UPDATE_FN[kind](editing.id, upd as never);
      }
      const create =
        kind === 'taxCategory'
          ? { code: v.code!, ...base, rate: v.rate ?? '0', isDefault: v.isDefault, einvoiceCode: v.einvoiceCode || undefined }
          : { code: v.code!, ...base, unEceCode: v.unEceCode || undefined };
      return CREATE_FN[kind](create as never);
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: showError,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => UPDATE_FN[kind](id, { isActive: false } as never),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
    onError: showError,
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };
  const openEdit = (row: LookupRow) => {
    setEditing(row);
    form.setFieldsValue({
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      rate: row.rate ?? undefined,
      isDefault: row.isDefault,
      einvoiceCode: row.einvoiceCode,
      unEceCode: row.unEceCode,
    });
    setModalOpen(true);
  };

  const isTax = kind === 'taxCategory';

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Button size="small" type="primary" onClick={openCreate}>
          {t('settings.add')}
        </Button>
      }
    >
      {contextHolder}
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        columns={[
          { title: t('settings.code'), dataIndex: 'code', width: 110 },
          { title: t('common.name'), key: 'name', render: (_: unknown, r: LookupRow) => displayName(r) },
          { title: t('settings.nameEn'), dataIndex: 'nameEn' },
          ...(kind === 'unit'
            ? [{ title: t('settings.unEceCode'), dataIndex: 'unEceCode', width: 110, render: (v?: string | null) => v ?? '—' }]
            : []),
          ...(isTax
            ? [
                {
                  title: t('settings.rate'),
                  dataIndex: 'rate',
                  width: 100,
                  align: 'right' as const,
                  render: (v?: string | null) =>
                    v != null ? <Num>{`${formatPercent(v)}%`}</Num> : '—',
                },
                {
                  title: t('settings.isDefault'),
                  dataIndex: 'isDefault',
                  width: 90,
                  render: (v: boolean) => (v ? <Tag color="blue">✓</Tag> : '—'),
                },
              ]
            : []),
          {
            title: t('common.status'),
            dataIndex: 'isActive',
            width: 90,
            render: (v: boolean) =>
              v ? (
                <Tag color="green">{t('common.active')}</Tag>
              ) : (
                <Tag>{t('common.inactive')}</Tag>
              ),
          },
          {
            title: t('common.actions'),
            width: 150,
            render: (_: unknown, row: LookupRow) => (
              <Space>
                <Button size="small" onClick={() => openEdit(row)}>
                  {t('common.edit')}
                </Button>
                {row.isActive && (
                  <Popconfirm title={t('common.confirmDeactivate')} onConfirm={() => deactivate.mutate(row.id)}>
<Button size="small" danger >
                    {t('common.deactivate')}
                  </Button>
</Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <FormDialog
        title={editing ? t('settings.edit') : `${t('settings.add')} — ${title}`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection title={t('items.general')} icon={<SettingOutlined />}>
            {!editing && (
              <Form.Item name="code" label={t('settings.code')} rules={[{ required: true }]}>
                <Input maxLength={50} />
              </Form.Item>
            )}
            <Form.Item name="nameAr" label={t('settings.nameAr')} rules={[{ required: true }]}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('settings.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
            {kind === 'unit' && (
              <Form.Item name="unEceCode" label={t('settings.unEceCode')}>
                <Input maxLength={10} placeholder="PCE / KGM / LTR…" />
              </Form.Item>
            )}
            {isTax && (
              <>
                <Form.Item name="rate" label={t('settings.rate')} rules={[{ required: true }]}>
                  <InputNumber<string> stringMode min="0" max="100" step="0.0001" />
                </Form.Item>
                <Form.Item name="isDefault" label={t('settings.isDefault')} valuePropName="checked">
                  <input type="checkbox" />
                </Form.Item>
                <Form.Item name="einvoiceCode" label={t('settings.einvoiceCode')}>
                  <Input maxLength={50} />
                </Form.Item>
              </>
            )}
          </FormSection>
        </Form>
      </FormDialog>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t('settings.title')} />
      <Card>
      <Tabs
        items={[
          { key: 'units', label: t('settings.units'), children: <LookupTable kind="unit" title={t('settings.units')} /> },
          {
            key: 'tax',
            label: t('settings.taxCategories'),
            children: <LookupTable kind="taxCategory" title={t('settings.taxCategories')} />,
          },
          {
            key: 'payments',
            label: t('settings.paymentMethods'),
            children: <LookupTable kind="paymentMethod" title={t('settings.paymentMethods')} />,
          },
        ]}
      />
      </Card>
    </div>
  );
}
