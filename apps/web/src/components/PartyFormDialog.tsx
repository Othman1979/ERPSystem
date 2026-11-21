import { IdcardOutlined, PhoneOutlined, WalletOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Form, Input, InputNumber, Radio, Select, Space, Switch, message } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  partiesControllerCreate,
  partiesControllerUpdate,
  type PartyDto,
  type PartyType,
} from '@erp/api-client';
import { FormDialog, FormSection } from './FormDialog';
import { partyCreateBody, partyUpdateBody, type PartyFormValues } from '../pages/parties/partyPayload';

export interface PartyFormDialogProps {
  open: boolean;
  editing?: PartyDto | null;
  initialValues?: Partial<PartyFormValues>;
  lockPartyType?: boolean;
  enableSaveAndNew?: boolean;
  onSaved: (created: PartyDto) => void;
  onCancel: () => void;
}

export function PartyFormDialog({
  open,
  editing,
  initialValues,
  lockPartyType = false,
  enableSaveAndNew = false,
  onSaved,
  onCancel,
}: PartyFormDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PartyFormValues>();
  const [apiMessage, contextHolder] = message.useMessage();
  const saveAndNew = useRef(false);

  useEffect(() => {
    if (!open) return;
    saveAndNew.current = false;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        nameAr: editing.nameAr,
        nameEn: editing.nameEn ?? undefined,
        partyType: editing.partyType,
        taxNumber: editing.taxNumber ?? undefined,
        nationalId: editing.nationalId ?? undefined,
        nationalIdKind: editing.nationalIdKind ?? 'NIN',
        phone: editing.phone ?? undefined,
        creditLimit: editing.creditLimit ?? undefined,
        paymentTermsDays: editing.paymentTermsDays ?? undefined,
        isCashCustomer: editing.isCashCustomer,
        isActive: editing.isActive,
      });
    } else {
      form.setFieldsValue({
        partyType: 'CUSTOMER',
        nationalIdKind: 'NIN',
        isCashCustomer: false,
        isActive: true,
        ...initialValues,
      });
    }
  }, [editing, form, initialValues, open]);

  const save = useMutation({
    mutationFn: async (values: PartyFormValues) => {
      const response = editing
        ? await partiesControllerUpdate(editing.id, partyUpdateBody(values))
        : await partiesControllerCreate(partyCreateBody(values));
      return response.data;
    },
    onSuccess: (created) => {
      apiMessage.success(t('common.saved'));
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      if (saveAndNew.current) {
        saveAndNew.current = false;
        const partyType = form.getFieldValue('partyType') as PartyType;
        form.resetFields();
        form.setFieldsValue({
          partyType,
          nationalIdKind: 'NIN',
          isCashCustomer: false,
          isActive: true,
        });
        requestAnimationFrame(() => form.getFieldInstance('code')?.focus?.());
        return;
      }
      onSaved(created);
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  return (
    <>
      {contextHolder}
      <FormDialog
        open={open}
        title={editing ? t('parties.edit') : t('parties.new')}
        onCancel={onCancel}
        onSave={() => {
          saveAndNew.current = false;
          form.submit();
        }}
        onSaveAndNew={
          !editing && enableSaveAndNew
            ? () => {
                saveAndNew.current = true;
                form.submit();
              }
            : undefined
        }
        saving={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
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
                disabled={lockPartyType}
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
    </>
  );
}
