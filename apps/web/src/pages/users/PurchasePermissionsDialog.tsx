import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { App, Checkbox, Form, Input, Space, Typography } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type UserMembershipDto, usersControllerUpdatePurchasePermissions } from '@erp/api-client';
import { FormDialog, FormSection } from '../../components/FormDialog';
import {
  APPROVE_CODE,
  SALES_APPROVE_CODE,
  isApprovalLimit,
  PURCHASE_PERMISSIONS,
  purchasePermissionsPayload,
  type PurchasePermissionsForm,
  toPurchaseForm,
} from './purchasePermissions';

/**
 * The owner's editor for one member's purchase permissions (ADR-024 §3): the
 * three fixed codes, and the approval limit when purchase.approve is ticked.
 * Saves the whole set (PUT users/:membershipId/purchase-permissions).
 */
export function PurchasePermissionsDialog({ member, onClose }: { member: UserMembershipDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PurchasePermissionsForm>();
  const codes = Form.useWatch('codes', form) ?? [];

  useEffect(() => {
    if (member) form.setFieldsValue(toPurchaseForm(member.purchasePermissions));
  }, [member, form]);

  const save = useMutation({
    mutationFn: (values: PurchasePermissionsForm) =>
      usersControllerUpdatePurchasePermissions(member!.membershipId, purchasePermissionsPayload(values)),
    onSuccess: () => {
      message.success(t('users.purchaseSaved'));
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err: unknown) =>
      message.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL')),
  });

  return (
    <FormDialog
      title={t('users.purchaseTitle', { name: member?.user.fullName ?? member?.user.email ?? '' })}
      open={member !== null}
      onCancel={onClose}
      onSave={() => form.submit()}
      saving={save.isPending}
      width={560}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} initialValues={{ codes: [] }}>
        <FormSection title={t('users.purchase')} icon={<SafetyCertificateOutlined />} cols={2}>
          <Typography.Paragraph type="secondary" className="span-all">
            {t('users.purchaseIntro')}
          </Typography.Paragraph>
          <Form.Item name="codes" className="span-all" style={{ marginBottom: 8 }}>
            <Checkbox.Group style={{ width: '100%' }}>
              <Space direction="vertical" size={10}>
                {PURCHASE_PERMISSIONS.map((p) => (
                  <Checkbox key={p.code} value={p.code}>
                    <span>{t(`users.purchaseCodes.${p.key}`)}</span>
                    <br />
                    <Typography.Text type="secondary">{t(`users.purchaseHints.${p.key}`)}</Typography.Text>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          {codes.includes(APPROVE_CODE) && (
            <Form.Item
              name="approvalLimit"
              label={t('users.approvalLimit')}
              extra={t('users.approvalLimitHint')}
              rules={[
                {
                  validator: (_, v: string | undefined) =>
                    !v?.trim() || isApprovalLimit(v.trim()) ? Promise.resolve() : Promise.reject(new Error(t('users.approvalLimitInvalid'))),
                },
              ]}
            >
              <Input dir="ltr" inputMode="decimal" maxLength={19} placeholder={t('users.noLimit')} style={{ maxWidth: 220 }} />
            </Form.Item>
          )}
          {codes.includes(SALES_APPROVE_CODE) && (
            <Form.Item
              name="salesApprovalLimit"
              label={t('users.salesApprovalLimit')}
              extra={t('users.approvalLimitHint')}
              rules={[
                {
                  validator: (_, v: string | undefined) =>
                    !v?.trim() || isApprovalLimit(v.trim()) ? Promise.resolve() : Promise.reject(new Error(t('users.approvalLimitInvalid'))),
                },
              ]}
            >
              <Input dir="ltr" inputMode="decimal" maxLength={19} placeholder={t('users.noLimit')} style={{ maxWidth: 220 }} />
            </Form.Item>
          )}
        </FormSection>
      </Form>
    </FormDialog>
  );
}
