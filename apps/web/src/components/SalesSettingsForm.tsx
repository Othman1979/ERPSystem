import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Alert, Button, Form, InputNumber, Select, Switch } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  companyControllerUpdate,
  type SalesOrderApproval,
  type SalesReservation,
  type UpdateCompanyDto,
} from '@erp/api-client';
import { useCompany } from './CompanyProfileForm';
import { EnterNav } from './EnterNav';
import { WinGroup, WinPanel } from './WinForm';

const RESERVATIONS: readonly SalesReservation[] = ['NONE', 'SOFT', 'HARD'];
const APPROVALS: readonly SalesOrderApproval[] = ['NONE', 'OVER_CREDIT_LIMIT', 'ALWAYS'];

/** The five sales settings of the company (ADR-027 §1). */
type SalesSettingsValues = Required<
  Pick<UpdateCompanyDto, 'salesOrderRequired' | 'salesReservation' | 'salesOrderApproval' | 'salesPriceLocked' | 'quoteValidityDays'>
>;

/**
 * The company's sales cycle settings (ADR-027 §1), owner only. Turning the
 * order requirement on warns with how many direct draft invoices it will
 * refuse to post; nothing is changed for them automatically.
 */
export function SalesSettingsForm() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const company = useCompany();
  const [form] = Form.useForm<SalesSettingsValues>();
  const orderRequired = Form.useWatch('salesOrderRequired', form);
  const reservation = Form.useWatch('salesReservation', form);
  const approval = Form.useWatch('salesOrderApproval', form);

  useEffect(() => {
    const c = company.data;
    if (!c) return;
    form.setFieldsValue({
      salesOrderRequired: c.salesOrderRequired,
      salesReservation: c.salesReservation,
      salesOrderApproval: c.salesOrderApproval,
      salesPriceLocked: c.salesPriceLocked,
      quoteValidityDays: c.quoteValidityDays,
    });
  }, [company.data, form]);

  const save = useMutation({
    mutationFn: (values: SalesSettingsValues) => companyControllerUpdate(values),
    onSuccess: () => {
      message.success(t('salesCycle.settings.saved'));
      void queryClient.invalidateQueries({ queryKey: ['company'] });
    },
    onError: (err) =>
      message.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL')),
  });

  const direct = company.data?.directSalesDraftCount ?? 0;

  return (
    <EnterNav>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <WinPanel
          title={t('salesCycle.settings.title')}
          footer={
            <Button type="primary" htmlType="submit" loading={save.isPending}>
              {t('salesCycle.settings.save')}
            </Button>
          }
        >
        <WinGroup title={t('salesCycle.formGroups.policy')} cols={2}>
        <Form.Item
          name="salesOrderRequired"
          label={t('salesCycle.settings.orderRequired')}
          valuePropName="checked"
          extra={t('salesCycle.settings.orderRequiredHint')}
        >
          <Switch />
        </Form.Item>
        {orderRequired && direct > 0 && (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={t('salesCycle.settings.orderRequiredWarning', { count: direct })} />
        )}
        <Form.Item
          name="salesReservation"
          label={t('salesCycle.settings.reservation')}
          extra={reservation ? t(`salesCycle.settings.reservationHints.${reservation}`) : undefined}
          style={{ maxWidth: 480 }}
        >
          <Select options={RESERVATIONS.map((r) => ({ value: r, label: t(`salesCycle.settings.reservationOptions.${r}`) }))} />
        </Form.Item>
        <Form.Item
          name="salesOrderApproval"
          label={t('salesCycle.settings.approval')}
          extra={approval ? t(`salesCycle.settings.approvalHints.${approval}`) : undefined}
          style={{ maxWidth: 480 }}
        >
          <Select options={APPROVALS.map((a) => ({ value: a, label: t(`salesCycle.settings.approvalOptions.${a}`) }))} />
        </Form.Item>
        </WinGroup>
        <WinGroup title={t('salesCycle.formGroups.quotes')} cols={2}>
        <Form.Item
          name="salesPriceLocked"
          label={t('salesCycle.settings.priceLocked')}
          valuePropName="checked"
          extra={t('salesCycle.settings.priceLockedHint')}
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="quoteValidityDays"
          label={t('salesCycle.settings.validityDays')}
          extra={t('salesCycle.settings.validityDaysHint')}
          rules={[{ required: true, type: 'number', min: 0, max: 365, message: t('salesCycle.settings.validityDaysHint') }]}
          style={{ maxWidth: 240 }}
          className="win-w-num"
        >
          <InputNumber min={0} max={365} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        </WinGroup>
        </WinPanel>
      </Form>
    </EnterNav>
  );
}
