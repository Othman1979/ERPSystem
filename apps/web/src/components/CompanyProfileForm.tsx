import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import { App, Button, Form, Image, Input, Space, Switch, Typography, Upload } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  companyControllerGet,
  companyControllerLogo,
  companyControllerRemoveLogo,
  companyControllerUpdate,
  companyControllerUploadLogo,
} from '@erp/api-client';

export interface CompanyProfile {
  id: string;
  legalNameAr: string;
  legalNameEn: string | null;
  taxNumber: string | null;
  commercialRegistration: string | null;
  address: string | null;
  phone: string | null;
  pricesIncludeTax: boolean;
  onboardingCompletedAt: string | null;
  logo: { id: string; fileName: string; mimeType: string } | null;
}

/** The tenant's company profile (one query shared by the wizard, settings and home). */
export function useCompany() {
  return useQuery({
    queryKey: ['company'],
    queryFn: () => companyControllerGet().then((r) => r.data as unknown as CompanyProfile),
  });
}

const LOGO_MAX_BYTES = 1024 * 1024;

type FormValues = Pick<
  CompanyProfile,
  'legalNameAr' | 'legalNameEn' | 'taxNumber' | 'commercialRegistration' | 'address' | 'phone' | 'pricesIncludeTax'
>;

/**
 * Company name, tax number, address, phone and logo (setup wizard step 1,
 * settings). `withTax` adds the "prices include tax" switch; `onSaved` runs
 * after a successful save (the wizard moves on).
 */
export function CompanyProfileForm({
  withTax = false,
  submitLabel,
  onSaved,
}: {
  withTax?: boolean;
  submitLabel?: string;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const company = useCompany();
  const logo = useQuery({
    queryKey: ['company-logo', company.data?.logo?.id],
    queryFn: () =>
      companyControllerLogo().then((r) => {
        const d = r.data as unknown as { mimeType: string; base64: string };
        return `data:${d.mimeType};base64,${d.base64}`;
      }),
    enabled: !!company.data?.logo,
  });

  useEffect(() => {
    if (company.data) form.setFieldsValue(company.data);
  }, [company.data, form]);

  const onError = (err: unknown) =>
    message.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['company'] });

  const save = useMutation({
    mutationFn: (v: FormValues) => companyControllerUpdate(v as never),
    onSuccess: () => {
      message.success(t('common.saved'));
      refresh();
      onSaved?.();
    },
    onError,
  });
  const upload = useMutation({
    mutationFn: (file: File) => companyControllerUploadLogo({ file } as never),
    onSuccess: () => {
      message.success(t('company.logoSaved'));
      refresh();
    },
    onError,
  });
  const removeLogo = useMutation({
    mutationFn: () => companyControllerRemoveLogo(),
    onSuccess: refresh,
    onError,
  });

  return (
    <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ maxWidth: 720 }}>
      {/* One aligned two-column grid, the same as the master-data dialogs (UI-11). */}
      <div className="form-section-grid cols-2 is-flush">
        <Form.Item name="legalNameAr" label={t('company.legalNameAr')} rules={[{ required: true, whitespace: true }]}>
          <Input maxLength={191} />
        </Form.Item>
        <Form.Item name="legalNameEn" label={t('company.legalNameEn')}>
          <Input maxLength={191} dir="ltr" />
        </Form.Item>
        <Form.Item
          name="taxNumber"
          label={t('company.taxNumber')}
          extra={t('company.taxNumberHint')}
          rules={[{ pattern: /^\d*$/, message: t('company.taxNumberDigits') }]}
        >
          <Input maxLength={50} dir="ltr" inputMode="numeric" />
        </Form.Item>
        <Form.Item name="commercialRegistration" label={t('company.commercialRegistration')}>
          <Input maxLength={100} dir="ltr" />
        </Form.Item>
        <Form.Item name="phone" label={t('company.phone')}>
          <Input maxLength={50} dir="ltr" />
        </Form.Item>
        <Form.Item name="address" label={t('company.address')} className="span-all">
          <Input.TextArea maxLength={512} autoSize={{ minRows: 2, maxRows: 4 }} />
        </Form.Item>
      </div>
      {withTax && (
        <Form.Item name="pricesIncludeTax" label={t('company.pricesIncludeTax')} valuePropName="checked" extra={t('company.pricesIncludeTaxHint')}>
          <Switch />
        </Form.Item>
      )}

      <Form.Item label={t('company.logo')} extra={t('company.logoHint')}>
        <Space align="center" size={16} wrap>
          {logo.data && <Image src={logo.data} alt={t('company.logo')} height={56} preview={false} style={{ objectFit: 'contain' }} />}
          <Upload
            accept="image/png,image/jpeg"
            showUploadList={false}
            beforeUpload={(file) => {
              if (file.size > LOGO_MAX_BYTES) {
                message.error(t('errors.UPLOAD_TOO_LARGE'));
              } else {
                upload.mutate(file);
              }
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={upload.isPending}>
              {company.data?.logo ? t('company.replaceLogo') : t('company.uploadLogo')}
            </Button>
          </Upload>
          {company.data?.logo && (
            <Button danger icon={<DeleteOutlined />} loading={removeLogo.isPending} onClick={() => removeLogo.mutate()}>
              {t('company.removeLogo')}
            </Button>
          )}
          {company.data?.logo && <Typography.Text type="secondary">{company.data.logo.fileName}</Typography.Text>}
        </Space>
      </Form.Item>

      <Button type="primary" htmlType="submit" loading={save.isPending}>
        {submitLabel ?? t('common.save')}
      </Button>
    </Form>
  );
}
