import { BookOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Form, Input, Select, Switch, message } from 'antd';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  accountingControllerCreateAccount,
  accountingControllerUpdateAccount,
  type AccountDto,
  type AccountCreatedDto,
  type AccountType,
  type CashFlowActivity,
} from '@erp/api-client';
import { FormDialog, FormSection } from './FormDialog';
import { codeAndName } from '../i18n/displayName';
import { ACCOUNTS_QUERY_KEY, useAccounts, type AccountRow } from '../hooks/useAccounts';
import { useCostCenters } from '../hooks/useCostCenters';

const CASH_FLOW_ACTIVITIES: CashFlowActivity[] = ['OPERATING', 'INVESTING', 'FINANCING'];

export function isValidChildAccountCode(code: unknown, parentCode: string): code is string {
  return typeof code === 'string' && code.startsWith(parentCode) && code.length > parentCode.length;
}

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
  onSaved: (created: AccountDto | AccountCreatedDto) => void;
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
  const previousParentId = useRef<string | undefined>(undefined);
  const previousAutoCode = useRef<string | null>(null);

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
  const selectedParentHasChildren = selectedParent
    ? (data ?? []).some((account) => account.parentId === selectedParent.id)
    : false;
  const showLinkMoveNotice = !!selectedParent?.isPostable && !selectedParentHasChildren;

  useEffect(() => {
    if (!open) return;
    previousParentId.current = undefined;
    previousAutoCode.current = null;
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

  useEffect(() => {
    if (!open || editing) return;
    const currentCode = form.getFieldValue('code') as string | undefined;
    const parentChanged = watchedParentId !== previousParentId.current;
    if (watchedParentId && autoCode) {
      if (parentChanged || currentCode === undefined || currentCode === previousAutoCode.current) {
        form.setFieldValue('code', autoCode);
      }
    } else if (!watchedParentId && previousParentId.current && currentCode === previousAutoCode.current) {
      form.setFieldValue('code', undefined);
    }
    previousParentId.current = watchedParentId;
    previousAutoCode.current = autoCode;
  }, [autoCode, editing, form, open, watchedParentId]);

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
            code: values.parentId ? (values.code === autoCode ? undefined : values.code) : values.code!,
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
      if ('movedLinks' in created) {
        const { movedLinks } = created;
        if (Object.values(movedLinks).some((count) => count > 0)) {
          apiMessage.info(t('accounts.linksMoved', { ...movedLinks }));
        }
        if (movedLinks.mappings > 0) {
          void queryClient.invalidateQueries({ queryKey: ['account-mappings'] });
        }
        if (movedLinks.cashBoxes > 0) {
          void queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
          void queryClient.invalidateQueries({ queryKey: ['payroll', 'cashBoxes'] });
        }
        if (movedLinks.bankAccounts > 0) {
          void queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
          void queryClient.invalidateQueries({ queryKey: ['treasury-bank-accounts'] });
          void queryClient.invalidateQueries({ queryKey: ['payroll', 'bankAccounts'] });
        }
      }
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      onSaved(created);
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        apiMessage.error(t('errors.INTERNAL'));
        return;
      }
      const reason = err.details?.reason;
      if (reason === 'CODE_PREFIX') {
        apiMessage.error(
          t('accounts.errors.codePrefix', { parentCode: String(err.details?.parentCode ?? '') }),
        );
        return;
      }
      if (err.code === 'VALIDATION' && reason === 'LINKS_NEED_POSTABLE_CHILD') {
        apiMessage.error(
          t('accounts.errors.linksNeedPostableChild', { parentCode: String(err.details?.parentCode ?? '') }),
        );
        return;
      }
      if (err.code === 'VALIDATION' && reason === 'MAPPING_RULE') {
        apiMessage.error(
          t('accounts.errors.mappingRule', { mappingKey: String(err.details?.mappingKey ?? '') }),
        );
        return;
      }
      if (err.code === 'ACCOUNT_IN_USE' && reason === 'HAS_LINES') {
        apiMessage.error(t('accounts.errors.hasLines'));
        return;
      }
      if (err.code === 'ACCOUNT_IN_USE' && reason === 'USED_IN_DOCUMENTS') {
        const documents = Array.isArray(err.details?.documents)
          ? err.details.documents.map((document) => t(`accounts.documentTypes.${String(document)}`)).join(', ')
          : '';
        apiMessage.error(t('accounts.errors.usedInDocuments', { documents }));
        return;
      }
      apiMessage.error(t(`errors.${err.code}`, { defaultValue: err.message }));
    },
  });

  const parentOptions = (data ?? [])
    .filter((account) => account.isActive && account.id !== editing?.id)
    .map((account) => ({
      value: account.id,
      label: codeAndName(account),
      searchText: `${account.code} ${account.nameAr} ${account.nameEn ?? ''}`.toLocaleLowerCase(),
    }));

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
                  {showLinkMoveNotice && (
                    <>
                      <br />
                      {t('accounts.firstChildLinkMoveNotice')}
                    </>
                  )}
                </>
              }
            />
          )}
          <FormSection title={t('accounts.details')} icon={<BookOutlined />}>
            {!editing && (
              <>
                <Form.Item
                  name="code"
                  label={t('accounts.code')}
                  rules={[
                    { required: !watchedParentId },
                    ...(watchedParentId && selectedParent
                      ? [
                          {
                            validator: (_: unknown, value?: string) =>
                              isValidChildAccountCode(value, selectedParent.code)
                                ? Promise.resolve()
                                : Promise.reject(
                                    new Error(
                                      t('accounts.errors.codePrefix', { parentCode: selectedParent.code }),
                                    ),
                                  ),
                          },
                        ]
                      : []),
                  ]}
                >
                  <Input maxLength={50} />
                </Form.Item>
                <Form.Item name="parentId" label={t('accounts.parent')}>
                  <Select
                    allowClear
                    showSearch
                    filterOption={(input, option) =>
                      (
                        option as unknown as { searchText?: string } | undefined
                      )?.searchText?.includes(input.toLocaleLowerCase()) ?? false
                    }
                    options={parentOptions}
                  />
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
