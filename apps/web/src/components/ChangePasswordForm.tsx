import { useMutation } from '@tanstack/react-query';
import { App, Button, Form, Input } from 'antd';
import { useTranslation } from 'react-i18next';
import { ApiError, authControllerChangePassword } from '@erp/api-client';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

interface ChangePasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * Current + new password form, shared by the topbar dialog and the forced
 * change screen. Other sessions are signed out by the server on success.
 */
export function ChangePasswordForm({
  onDone,
  submitLabel,
}: {
  onDone: () => void;
  submitLabel?: string;
}) {
  const { t } = useTranslation();
  // App.useApp() messages survive this form unmounting right after success.
  const { message } = App.useApp();
  const [form] = Form.useForm<ChangePasswordValues>();

  const change = useMutation({
    mutationFn: (values: ChangePasswordValues) =>
      authControllerChangePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
    onSuccess: () => {
      message.success(t('auth.passwordChanged'));
      form.resetFields();
      onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'INVALID_CURRENT_PASSWORD') {
        form.setFields([
          { name: 'currentPassword', errors: [t('errors.INVALID_CURRENT_PASSWORD')] },
        ]);
        return;
      }
      message.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  return (
    <Form<ChangePasswordValues>
      form={form}
      layout="vertical"
      requiredMark={false}
      onFinish={(values) => change.mutate(values)}
    >
      <Form.Item name="currentPassword" label={t('auth.currentPassword')} rules={[{ required: true }]}>
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      <Form.Item
        name="newPassword"
        label={t('auth.newPassword')}
        rules={[
          { required: true },
          { min: MIN_PASSWORD_LENGTH, message: t('auth.passwordMinLength') },
          ({ getFieldValue }) => ({
            validator(_, value: string | undefined) {
              if (!value || value !== getFieldValue('currentPassword')) return Promise.resolve();
              return Promise.reject(new Error(t('auth.passwordSameAsCurrent')));
            },
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" maxLength={MAX_PASSWORD_LENGTH} />
      </Form.Item>
      <Form.Item
        name="confirmPassword"
        label={t('auth.confirmPassword')}
        dependencies={['newPassword']}
        rules={[
          { required: true },
          ({ getFieldValue }) => ({
            validator(_, value: string | undefined) {
              if (!value || value === getFieldValue('newPassword')) return Promise.resolve();
              return Promise.reject(new Error(t('auth.passwordMismatch')));
            },
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" maxLength={MAX_PASSWORD_LENGTH} />
      </Form.Item>
      <Button type="primary" htmlType="submit" block loading={change.isPending}>
        {submitLabel ?? t('auth.changePassword')}
      </Button>
    </Form>
  );
}
