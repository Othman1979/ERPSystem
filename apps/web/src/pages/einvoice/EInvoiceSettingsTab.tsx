import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiOutlined, BankOutlined, SaveOutlined, SendOutlined } from '@ant-design/icons';
import { Alert, App, Button, ConfigProvider, Form, Input, Radio, Skeleton, Switch, message } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetchData } from '@erp/api-client';
import { fieldPanelTheme } from '../../components/DocLayout';
import { FormSection } from '../../components/FormDialog';
import { Num } from '../../components/Num';

type Environment = 'SANDBOX' | 'PRODUCTION';
type Track = 'INCOME' | 'GENERAL_SALES';

interface EInvoiceSettings {
  sellerTaxNumber: string | null;
  sellerName: string | null;
  environment: Environment;
  baseUrl: string | null;
  defaultSandboxUrl: string;
  clientId: string | null;
  hasSecret: boolean;
  incomeSourceSequence: string | null;
  track: Track;
  nextIcv: number;
  isEnabled: boolean;
  enabledAt: string | null;
  encryptionKeySet: boolean;
}

interface SettingsForm {
  sellerTaxNumber?: string;
  sellerName?: string;
  environment: Environment;
  baseUrl?: string;
  clientId?: string;
  secretKey?: string;
  incomeSourceSequence?: string;
  track: Track;
  isEnabled: boolean;
}

const QUERY_KEY = ['einvoice-settings'];
const DIGITS = /^\d+$/;

/** The API names what is missing in English; show the known items in the UI language. */
const MISSING_KEYS: Record<string, string> = {
  'the company tax number (digits)': 'einvoice.missing_taxNumber',
  'JOD as the base currency': 'einvoice.missing_currency',
  'Client-Id': 'einvoice.missing_clientId',
  'Secret-Key': 'einvoice.missing_secretKey',
  'the income source sequence': 'einvoice.missing_incomeSource',
};

const toForm = (s: EInvoiceSettings): SettingsForm => ({
  sellerTaxNumber: s.sellerTaxNumber ?? undefined,
  sellerName: s.sellerName ?? undefined,
  environment: s.environment,
  baseUrl: s.baseUrl ?? undefined,
  clientId: s.clientId ?? undefined,
  // Write-only: never prefilled ('' rather than undefined so setFieldsValue clears a typed one).
  secretKey: '',
  incomeSourceSequence: s.incomeSourceSequence ?? undefined,
  track: s.track,
  isEnabled: s.isEnabled,
});

/** Settings → E-invoicing: the JoFotara seller, connection and on/off switch (Phase 7). */
export function EInvoiceSettingsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { modal } = App.useApp();
  const [apiMessage, contextHolder] = message.useMessage();
  const [form] = Form.useForm<SettingsForm>();
  const environment = Form.useWatch('environment', form);
  // What the server said is missing on the last save that tried to enable sending.
  const [notReady, setNotReady] = useState<{ missing: boolean; items: string[] } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => apiFetchData<EInvoiceSettings>('/api/v1/einvoice/settings', { signal }),
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 1,
  });

  const save = useMutation({
    mutationFn: (v: SettingsForm) =>
      apiFetchData<EInvoiceSettings>('/api/v1/einvoice/settings', {
        method: 'PUT',
        body: JSON.stringify({
          // Empty seller fields keep what is stored (the API rejects blanks).
          sellerTaxNumber: v.sellerTaxNumber?.trim() || undefined,
          sellerName: v.sellerName?.trim() || undefined,
          environment: v.environment,
          ...(v.environment === 'SANDBOX' ? { baseUrl: v.baseUrl?.trim() || null } : {}),
          clientId: v.clientId?.trim() || null,
          // Omitted when empty: the stored secret stays.
          ...(v.secretKey ? { secretKey: v.secretKey } : {}),
          incomeSourceSequence: v.incomeSourceSequence?.trim() || null,
          track: v.track,
          isEnabled: v.isEnabled,
        }),
      }),
    onSuccess: (saved) => {
      setNotReady(null);
      queryClient.setQueryData(QUERY_KEY, saved);
      form.setFieldsValue(toForm(saved));
      apiMessage.success(t('common.saved'));
    },
    onError: (err, v) => {
      if (err instanceof ApiError && err.code === 'EINVOICE_NOT_READY') {
        const missing = err.details?.missing;
        const items = Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [];
        setNotReady(items.length > 0 ? { missing: true, items } : { missing: false, items: [err.message] });
        return;
      }
      setNotReady(null);
      apiMessage.error(
        err instanceof ApiError
          ? err.code === 'FORBIDDEN' && v.environment === 'PRODUCTION'
            ? t('einvoice.ownerOnly')
            : t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  const onFinish = (v: SettingsForm) => {
    if (v.environment === 'PRODUCTION' && data?.environment !== 'PRODUCTION') {
      modal.confirm({
        title: t('einvoice.productionConfirm'),
        content: t('einvoice.productionConfirmHint'),
        okText: t('common.save'),
        okButtonProps: { danger: true },
        cancelText: t('common.cancel'),
        onOk: () => save.mutate(v),
      });
      return;
    }
    save.mutate(v);
  };

  if (isLoading) return <Skeleton active />;
  if (error || !data) {
    return (
      <Alert
        type="error"
        showIcon
        message={
          error instanceof ApiError && error.status === 403
            ? t('einvoice.noPermission')
            : error instanceof ApiError
              ? t(`errors.${error.code}`, { defaultValue: error.message })
              : t('errors.INTERNAL')
        }
      />
    );
  }

  const isProduction = environment === 'PRODUCTION';

  return (
    <div className="settings-panel">
      {contextHolder}
      {!data.encryptionKeySet && (
        <Alert
          banner
          type="error"
          showIcon
          message={t('einvoice.encryptionKeyMissing')}
          description={t('einvoice.encryptionKeyMissingHint')}
        />
      )}
      <ConfigProvider theme={fieldPanelTheme}>
        <Form
          form={form}
          layout="vertical"
          initialValues={toForm(data)}
          onFinish={onFinish}
          autoComplete="off"
        >
          <FormSection title={t('einvoice.seller')} icon={<BankOutlined />} cols={2}>
            <Form.Item
              name="sellerTaxNumber"
              label={t('einvoice.sellerTaxNumber')}
              rules={[{ pattern: DIGITS, message: t('einvoice.digitsOnly') }]}
            >
              <Input maxLength={50} inputMode="numeric" dir="ltr" />
            </Form.Item>
            <Form.Item name="sellerName" label={t('einvoice.sellerName')} rules={[{ min: 2 }]}>
              <Input maxLength={191} />
            </Form.Item>
          </FormSection>

          <FormSection title={t('einvoice.connection')} icon={<ApiOutlined />}>
            <Form.Item name="environment" label={t('einvoice.environment')} className="span-2">
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={[
                  { value: 'SANDBOX', label: t('einvoice.env_SANDBOX') },
                  { value: 'PRODUCTION', label: t('einvoice.env_PRODUCTION') },
                ]}
              />
            </Form.Item>
            {!isProduction && (
              <Form.Item name="baseUrl" label={t('einvoice.baseUrl')} extra={t('einvoice.baseUrlHint')}>
                <Input maxLength={255} dir="ltr" placeholder={data.defaultSandboxUrl} />
              </Form.Item>
            )}
            <div className="span-all">
              {isProduction ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t('einvoice.productionNote')}
                  description={t('einvoice.productionNoteHint')}
                />
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message={t('einvoice.sandboxNote')}
                  description={t('einvoice.sandboxNoteHint')}
                />
              )}
            </div>
            <Form.Item name="clientId" label={t('einvoice.clientId')}>
              <Input maxLength={191} dir="ltr" />
            </Form.Item>
            <Form.Item
              name="secretKey"
              label={t('einvoice.secretKey')}
              extra={data.hasSecret ? t('einvoice.secretHint') : undefined}
            >
              <Input.Password
                maxLength={255}
                dir="ltr"
                autoComplete="new-password"
                disabled={!data.encryptionKeySet}
                placeholder={data.hasSecret ? t('einvoice.secretSaved') : undefined}
              />
            </Form.Item>
            <Form.Item
              name="incomeSourceSequence"
              label={t('einvoice.incomeSourceSequence')}
              extra={t('einvoice.incomeSourceSequenceHint')}
              rules={[{ pattern: DIGITS, message: t('einvoice.digitsOnly') }]}
            >
              <Input maxLength={50} inputMode="numeric" dir="ltr" />
            </Form.Item>
            <Form.Item name="track" label={t('einvoice.track')} extra={t('einvoice.trackHint')} className="span-all">
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={[
                  { value: 'INCOME', label: t('einvoice.track_INCOME') },
                  { value: 'GENERAL_SALES', label: t('einvoice.track_GENERAL_SALES') },
                ]}
              />
            </Form.Item>
          </FormSection>

          <FormSection title={t('einvoice.sending')} icon={<SendOutlined />}>
            <Form.Item
              name="isEnabled"
              label={t('einvoice.isEnabled')}
              extra={t('einvoice.isEnabledHint')}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item label={t('einvoice.nextIcv')} tooltip={t('einvoice.nextIcvHint')}>
              <div className="doc-field-value">
                <Num>{data.nextIcv}</Num>
              </div>
            </Form.Item>
            <Form.Item label={t('einvoice.enabledAt')}>
              <div className="doc-field-value">
                {data.enabledAt ? <Num>{dayjs(data.enabledAt).format('YYYY-MM-DD HH:mm')}</Num> : '—'}
              </div>
            </Form.Item>
          </FormSection>
        </Form>
      </ConfigProvider>
      {notReady && (
        <Alert
          banner
          type="error"
          showIcon
          message={t('errors.EINVOICE_NOT_READY')}
          description={
            <>
              {notReady.missing && t('einvoice.missing')}
              <ul className="einvoice-banner-errors">
                {notReady.items.map((m) => (
                  <li key={m}>{MISSING_KEYS[m] ? t(MISSING_KEYS[m]) : m}</li>
                ))}
              </ul>
            </>
          }
        />
      )}
      <div className="settings-panel-footer">
        <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={() => form.submit()}>
          {t('common.save')}
        </Button>
        <Button
          disabled={save.isPending}
          onClick={() => {
            form.setFieldsValue(toForm(data));
            setNotReady(null);
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
