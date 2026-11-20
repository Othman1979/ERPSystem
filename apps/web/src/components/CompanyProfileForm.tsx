import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import { App, Button, Form, Image, Input, Select, Space, Switch, Tag, Typography, Upload } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { PROCUREMENT_LEVELS } from '../auth/procurementLevel';
import { displayName } from '../i18n/displayName';
import {
  ApiError,
  type CompanyDto,
  companyControllerGet,
  companyControllerLogo,
  companyControllerRemoveLogo,
  companyControllerUpdate,
  companyControllerUploadLogo,
  type PurchaseDirectGapDto,
  usersControllerPurchaseDirectGaps,
} from '@erp/api-client';
import { EnterNav } from './EnterNav';

/** The tenant's company profile (one query shared by the wizard, settings and home). */
export function useCompany() {
  return useQuery({
    queryKey: ['company'],
    queryFn: ({ signal }) => companyControllerGet({ signal }).then((r) => r.data),
  });
}

const LOGO_MAX_BYTES = 1024 * 1024;

/** ADR-025 §4: the procurement level goes up out of SIMPLE (to MEDIUM or FULL). */
function isRaiseFromSimple(from: string | undefined, to: string | undefined): boolean {
  return from === 'SIMPLE' && (to === 'MEDIUM' || to === 'FULL');
}

type FormValues = Pick<
  CompanyDto,
  'legalNameAr' | 'legalNameEn' | 'taxNumber' | 'commercialRegistration' | 'address' | 'phone' | 'pricesIncludeTax' | 'procurementLevel'
  | 'costCentersEnabled'
>;

/**
 * Company name, tax number, address, phone and logo (setup wizard step 1,
 * settings). `withTax` adds the "prices include tax" switch; `withProcurement`
 * the procurement level (ADR-024 §2), which only company.manage may change;
 * `onSaved` runs after a successful save (the wizard moves on).
 */
export function CompanyProfileForm({
  withTax = false,
  withProcurement = false,
  submitLabel,
  onSaved,
}: {
  withTax?: boolean;
  withProcurement?: boolean;
  submitLabel?: string;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const company = useCompany();
  const logo = useQuery({
    queryKey: ['company-logo', company.data?.logo?.id],
    queryFn: ({ signal }) =>
      companyControllerLogo({ signal }).then((r) => `data:${r.data.mimeType};base64,${r.data.base64}`),
    enabled: !!company.data?.logo,
  });

  useEffect(() => {
    if (company.data) form.setFieldsValue(company.data);
  }, [company.data, form]);

  const onError = (err: unknown) =>
    message.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['company'] });

  const save = useMutation({
    mutationFn: (v: FormValues) => companyControllerUpdate(v),
    onSuccess: () => {
      message.success(t('common.saved'));
      refresh();
      onSaved?.();
    },
    onError: (err) => {
      // A refused lowering (ADR-024 §2.2): the select goes back to the saved level.
      if (err instanceof ApiError && err.code === 'PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS' && company.data) {
        form.setFieldsValue({ procurementLevel: company.data.procurementLevel });
      }
      onError(err);
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) => companyControllerUploadLogo({ file }),
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

  /**
   * ADR-025 §4: raising the level out of SIMPLE first lists the members who
   * would lose purchase-invoice access without a purchase order. The owner
   * confirms or cancels; nothing is granted automatically. The list needs
   * company.manage, the same permission that may change the level.
   */
  const requestSave = async (v: FormValues) => {
    const raising = withProcurement && isRaiseFromSimple(company.data?.procurementLevel, v.procurementLevel);
    if (!raising || !can(PERMISSIONS.COMPANY_MANAGE)) {
      save.mutate(v);
      return;
    }
    let gaps: PurchaseDirectGapDto[];
    try {
      gaps = (await usersControllerPurchaseDirectGaps()).data;
    } catch (err) {
      onError(err);
      return;
    }
    if (gaps.length === 0) {
      save.mutate(v);
      return;
    }
    modal.confirm({
      title: t('procurement.directGapsTitle'),
      content: (
        <>
          <Typography.Paragraph>{t('procurement.directGapsBody')}</Typography.Paragraph>
          {/* A long list scrolls, so the dialog buttons stay on screen. */}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {gaps.map((gap) => (
                <li key={gap.email}>
                  <Space size={8} wrap>
                    <Typography.Text strong>{gap.fullName}</Typography.Text>
                    <Typography.Text type="secondary" dir="ltr">
                      {gap.email}
                    </Typography.Text>
                    <Tag>{displayName(gap.role)}</Tag>
                  </Space>
                </li>
              ))}
            </ul>
          </div>
        </>
      ),
      okText: t('procurement.directGapsConfirm'),
      cancelText: t('common.cancel'),
      onOk: () => save.mutate(v),
    });
  };

  return (
    <EnterNav>
      <Form form={form} layout="vertical" onFinish={(v) => void requestSave(v)} style={{ maxWidth: 720 }}>
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
        {withTax && (
          <Form.Item
            name="costCentersEnabled"
            label={t('costCenters.enableLabel')}
            valuePropName="checked"
            extra={t('costCenters.enableHint')}
          >
            <Switch />
          </Form.Item>
        )}
        {withProcurement && (
          <Form.Item
            name="procurementLevel"
            label={t('company.procurementLevel')}
            extra={t('company.procurementLevelHint')}
            style={{ maxWidth: 480 }}
          >
            <Select
              disabled={!can(PERMISSIONS.COMPANY_MANAGE)}
              options={PROCUREMENT_LEVELS.map((level) => ({ value: level, label: t(`company.procurementLevels.${level}`) }))}
            />
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
    </EnterNav>
  );
}
