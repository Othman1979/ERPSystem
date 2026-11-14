import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IdcardOutlined, PhoneOutlined, PlusOutlined, WalletOutlined } from '@ant-design/icons';
import {
  Button,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  partiesControllerCreate,
  partiesControllerDeactivate,
  partiesControllerList,
  partiesControllerUpdate,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { FormDialog, FormSection } from '../components/FormDialog';
import { displayName, type Named } from '../i18n/displayName';
import { amountCell } from '../format/cells';

interface Party {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  partyType: 'CUSTOMER' | 'SUPPLIER' | 'BOTH';
  taxNumber?: string | null;
  nationalId?: string | null;
  /** JoFotara buyer scheme for nationalId: NIN Jordanian, PN non-Jordanian. */
  nationalIdKind?: 'NIN' | 'PN';
  phone?: string | null;
  creditLimit?: string | null;
  paymentTermsDays?: number | null;
  isCashCustomer?: boolean;
  isActive: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  CUSTOMER: 'blue',
  SUPPLIER: 'orange',
  BOTH: 'green',
};

export function PartiesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);
  const [form] = Form.useForm();
  const saveAndNew = useRef(false);
  const [apiMessage, contextHolder] = message.useMessage();

  const partiesQuery = useQuery({
    queryKey: ['parties', typeFilter],
    queryFn: ({ signal }) =>
      partiesControllerList({ partyType: typeFilter ?? '', isActive: '' }, { signal }).then(
        (r) => r.data as unknown as Party[],
      ),
  });
  const { data: parties, isLoading } = partiesQuery;

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['parties'] });
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ partyType: 'CUSTOMER', nationalIdKind: 'NIN', isCashCustomer: false, isActive: true });
    setModalOpen(true);
  };

  const openEdit = (p: Party) => {
    setEditing(p);
    form.setFieldsValue({
      nameAr: p.nameAr,
      nameEn: p.nameEn ?? undefined,
      partyType: p.partyType,
      taxNumber: p.taxNumber ?? undefined,
      nationalId: p.nationalId ?? undefined,
      nationalIdKind: p.nationalIdKind ?? 'NIN',
      phone: p.phone ?? undefined,
      creditLimit: p.creditLimit ?? undefined,
      paymentTermsDays: p.paymentTermsDays ?? undefined,
      isCashCustomer: p.isCashCustomer,
      isActive: p.isActive,
    });
    setModalOpen(true);
  };

  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const payload = {
        nameAr: values.nameAr,
        nameEn: values.nameEn,
        partyType: values.partyType,
        taxNumber: values.taxNumber,
        nationalId: values.nationalId,
        nationalIdKind: values.nationalIdKind,
        phone: values.phone,
        creditLimit: values.creditLimit ?? undefined,
        paymentTermsDays: values.paymentTermsDays,
        isCashCustomer: values.isCashCustomer,
        isActive: values.isActive,
      };
      const res = editing
        ? await partiesControllerUpdate(editing.id, payload as never)
        : await partiesControllerCreate({ code: values.code, ...payload } as never);
      return res as never;
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      invalidate();
      if (saveAndNew.current) {
        // Save & new: keep the dialog open on an empty form, same party type.
        saveAndNew.current = false;
        const partyType = form.getFieldValue('partyType');
        form.resetFields();
        form.setFieldsValue({ partyType, nationalIdKind: 'NIN', isCashCustomer: false, isActive: true });
        requestAnimationFrame(() => form.getFieldInstance('code')?.focus?.());
        return;
      }
      setModalOpen(false);
    },
    onError,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => partiesControllerDeactivate(id),
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      invalidate();
    },
    onError,
  });

  const columns = [
    { title: t('parties.code'), dataIndex: 'code', width: 110 },
    { title: t('common.name'), key: 'name', render: (_: unknown, r: Named) => displayName(r) },
    {
      title: t('parties.type'),
      dataIndex: 'partyType',
      width: 120,
      render: (v: string) => <Tag color={TYPE_COLORS[v]}>{t(`parties.type_${v}`)}</Tag>,
    },
    { title: t('parties.taxNumber'), dataIndex: 'taxNumber', width: 140, render: (v?: string | null) => v ?? '—' },
    { title: t('parties.phone'), dataIndex: 'phone', width: 130, render: (v?: string | null) => v ?? '—' },
    {
      title: t('parties.creditLimit'),
      dataIndex: 'creditLimit',
      width: 120,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('common.status'),
      dataIndex: 'isActive',
      width: 100,
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? t('common.active') : t('common.inactive')}</Tag>,
    },
    {
      title: '',
      width: 170,
      render: (_: unknown, p: Party) => (
        <Space>
          <Button size="small" onClick={() => openEdit(p)}>{t('common.edit')}</Button>
          {p.isActive && (
            <Popconfirm
              title={t('parties.deactivateConfirm')}
              onConfirm={() => deactivate.mutate(p.id)}
            >
              <Button size="small" danger>{t('common.deactivate')}</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const shown = (parties ?? []).filter((p) =>
    matchesSearch(search, p.code, displayName(p), p.phone, p.taxNumber, p.nationalId),
  );

  return (
    <div>
      {contextHolder}
      <PageHeader title={t('nav.parties')} />
      <ListToolbar
        search={search}
        onSearch={setSearch}
        filters={
          <Select
            allowClear
            placeholder={t('parties.type')}
            value={typeFilter}
            onChange={setTypeFilter}
            options={[
              { value: 'CUSTOMER', label: t('parties.type_CUSTOMER') },
              { value: 'SUPPLIER', label: t('parties.type_SUPPLIER') },
              { value: 'BOTH', label: t('parties.type_BOTH') },
            ]}
          />
        }
        count={shown.length}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('parties.new')}
          </Button>
        }
      />

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shown}
        locale={tableLocale(partiesQuery)}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
      />

      <FormDialog
        open={modalOpen}
        title={editing ? t('parties.edit') : t('parties.new')}
        onCancel={() => setModalOpen(false)}
        onSave={() => {
          saveAndNew.current = false;
          form.submit();
        }}
        onSaveAndNew={
          editing
            ? undefined
            : () => {
                saveAndNew.current = true;
                form.submit();
              }
        }
        saving={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection
            title={t('common.basicInfo')}
            icon={<IdcardOutlined />}
            extra={
              <>
                {t('common.active')}
                <Form.Item name="isActive" valuePropName="checked" noStyle>
                  <Switch size="small" />
                </Form.Item>
              </>
            }
          >
            {!editing && (
              <Form.Item name="code" label={t('parties.code')} rules={[{ required: true }]}>
                <Input maxLength={50} />
              </Form.Item>
            )}
            <Form.Item
              name="partyType"
              label={t('parties.type')}
              rules={[{ required: true }]}
              className={editing ? 'span-all' : 'span-2'}
            >
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={[
                  { value: 'CUSTOMER', label: t('parties.type_CUSTOMER') },
                  { value: 'SUPPLIER', label: t('parties.type_SUPPLIER') },
                  { value: 'BOTH', label: t('parties.type_BOTH') },
                ]}
              />
            </Form.Item>
            <Form.Item name="nameAr" label={t('parties.nameAr')} rules={[{ required: true }]} className="span-2">
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('parties.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
          </FormSection>

          <FormSection title={t('parties.contact')} icon={<PhoneOutlined />}>
            <Form.Item name="taxNumber" label={t('parties.taxNumber')}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item label={t('parties.nationalId')} tooltip={t('parties.nationalIdHint')} className="span-2">
              <Space.Compact block>
                <Form.Item name="nationalIdKind" noStyle>
                  <Select
                    style={{ width: 130, flex: 'none' }}
                    aria-label={t('parties.nationalId')}
                    options={[
                      { value: 'NIN', label: t('parties.nationalIdKind_NIN') },
                      { value: 'PN', label: t('parties.nationalIdKind_PN') },
                    ]}
                  />
                </Form.Item>
                <Form.Item name="nationalId" noStyle>
                  <Input maxLength={50} />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="phone" label={t('parties.phone')}>
              <Input maxLength={50} />
            </Form.Item>
          </FormSection>

          <FormSection title={t('parties.terms')} icon={<WalletOutlined />}>
            <Form.Item name="creditLimit" label={t('parties.creditLimit')}>
              <InputNumber<string> stringMode min="0" />
            </Form.Item>
            <Form.Item name="paymentTermsDays" label={t('parties.paymentTerms')}>
              <InputNumber min={0} max={3650} />
            </Form.Item>
            <Form.Item name="isCashCustomer" label={t('parties.isCashCustomer')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
    </div>
  );
}
