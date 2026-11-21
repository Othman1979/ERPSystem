import { BookOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Form, Input, Select, Switch, message } from 'antd';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  accountingControllerCreateAccount,
  accountingControllerUpdateAccount,
  type AccountDto,
  type AccountType,
  type CashFlowActivity,
} from '@erp/api-client';
import { FormDialog, FormSection } from './FormDialog';
import { codeAndName } from '../i18n/displayName';
import { ACCOUNTS_QUERY_KEY, useAccounts, type AccountRow } from '../hooks/useAccounts';
import { useCostCenters } from '../hooks/useCostCenters';

const CASH_FLOW_ACTIVITIES: CashFlowActivity[] = ['OPERATING', 'INVESTING', 'FINANCING'];

interface AccountFormValues {
  code?: string;
  nameAr: string;
  nameEn?: string;
  parentId?: string;
  accountType: AccountType;
  isPostable?: boolean;
  costCenterRequired?: boolean;
  cashFlowActivity?: CashFlowActivity | null;
}

export interface AccountFormDialogProps {
  open: boolean;
  editing?: AccountRow | null;
  initialValues?: Partial<AccountFormValues>;
  onSaved: (created: AccountDto) => void;
  onCancel: () => void;
}

export function AccountFormDialog({
  open,
  editing,
  initialValues,
  onSaved,
  onCancel,
}: AccountFormDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<AccountFormValues>();
  const [apiMessage, contextHolder] = message.useMessage();
  const accountsQuery = useAccounts();
  const data = accountsQuery.data;
  const { enabled: costCentersOn } = useCostCenters();

  const watchedParentId = Form.useWatch('parentId', form) as string | undefined;
  const watchedAccountType = Form.useWatch('accountType', form) as AccountType | undefined;
  const typeForCentre = editing ? editing.accountType : watchedAccountType;
  const takesCentre = typeForCentre === 'REVENUE' || typeForCentre === 'EXPENSE';
  const showCentreFlag = costCentersOn && takesCentre;
  const controlForCashFlow = editing ? editing.controlType : null;
  const showCashFlow =
    !!typeForCentre && !takesCentre && controlForCashFlow !== 'CASH' && controlForCashFlow !== 'BANK';
  const selectedParent = useMemo(
    () => (data ?? []).find((account) => account.id === watchedParentId) ?? null,
    [data, watchedParentId],
  );
  const autoCode = useMemo(() => {
    if (!selectedParent) return null;
    const prefix = `${selectedParent.code}-`;
    let max = 0;
    for (const account of data ?? []) {
      if (account.code.startsWith(prefix)) {
        const suffix = account.code.slice(prefix.length);
        if (/^\d+$/.test(suffix)) max = Math.max(max, Number(suffix));
      }
    }
    return `${prefix}${String(max + 1).padStart(2, '0')}`;
  }, [data, selectedParent]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        nameAr: editing.nameAr,
        nameEn: editing.nameEn ?? undefined,
        isPostable: editing.isPostable,
        costCenterRequired: editing.costCenterRequired,
        cashFlowActivity: editing.cashFlowActivity ?? null,
      });
    } else {
      form.setFieldsValue(initialValues ?? {});
    }
  }, [editing, form, initialValues, open]);

  const save = useMutation({
    mutationFn: async (values: AccountFormValues) => {
      const response = editing
        ? await accountingControllerUpdateAccount(editing.id, {
            nameAr: values.nameAr,
            nameEn: values.nameEn || null,
            isPostable: values.isPostable,
            costCenterRequired: showCentreFlag ? values.costCenterRequired === true : undefined,
            cashFlowActivity: showCashFlow ? (values.cashFlowActivity ?? null) : undefined,
          })
        : await accountingControllerCreateAccount({
            code: values.parentId ? undefined : values.code!,
            nameAr: values.nameAr,
            nameEn: values.nameEn || undefined,
            parentId: values.parentId || undefined,
            accountType: values.accountType,
            isPostable: values.isPostable ?? true,
            costCenterRequired: showCentreFlag ? values.costCenterRequired === true : undefined,
            cashFlowActivity: showCashFlow ? (values.cashFlowActivity ?? null) : undefined,
          });
      return response.data;
    },
    onSuccess: (created) => {
      apiMessage.success(t('common.saved'));
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
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

  const parentOptions = (data ?? [])
    .filter((account) => account.isActive && account.id !== editing?.id)
    .map((account) => ({ value: account.id, label: codeAndName(account) }));

  return (
    <>
      {contextHolder}
      <FormDialog
        title={editing ? t('accounts.edit') : t('accounts.add')}
        open={open}
        onCancel={onCancel}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          {!editing && selectedParent && autoCode && (
            <Alert
              type="warning"
              showIcon
              style={{ margin: 12, marginBottom: 0 }}
              message={t('accounts.childUnder', { code: selectedParent.code })}
              description={
                <>
                  {t('accounts.autoCodePreview', { code: autoCode })}
                  <br />
                  {t('accounts.parentNonPostableWarning')}
                </>
              }
            />
          )}
          <FormSection title={t('accounts.details')} icon={<BookOutlined />}>
            {!editing && (
              <>
                {!watchedParentId && (
                  <Form.Item name="code" label={t('accounts.code')} rules={[{ required: true }]}>
                    <Input maxLength={50} />
                  </Form.Item>
                )}
                <Form.Item name="parentId" label={t('accounts.parent')}>
                  <Select allowClear showSearch optionFilterProp="label" options={parentOptions} />
                </Form.Item>
                <Form.Item name="accountType" label={t('accounts.type')} rules={[{ required: true }]}>
                  <Select
                    options={(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const).map(
                      (value) => ({ value, label: t(`accounts.types.${value}`) }),
                    )}
                  />
                </Form.Item>
              </>
            )}
            <Form.Item name="nameAr" label={t('accounts.nameAr')} rules={[{ required: true }]} className="span-2">
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('accounts.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="isPostable" label={t('accounts.postable')}>
              <Select
                allowClear
                options={[
                  { value: true, label: t('common.active') },
                  { value: false, label: '—' },
                ]}
              />
            </Form.Item>
            {showCashFlow && (
              <Form.Item name="cashFlowActivity" label={t('cashFlow.activity')} extra={t('cashFlow.activityHint')}>
                <Select
                  allowClear
                  options={CASH_FLOW_ACTIVITIES.map((value) => ({
                    value,
                    label: t(`cashFlow.activity_${value}`),
                  }))}
                />
              </Form.Item>
            )}
            {showCentreFlag && (
              <Form.Item
                name="costCenterRequired"
                label={t('costCenters.required')}
                valuePropName="checked"
                extra={t('costCenters.requiredHint')}
              >
                <Switch />
              </Form.Item>
            )}
          </FormSection>
        </Form>
      </FormDialog>
    </>
  );
}
