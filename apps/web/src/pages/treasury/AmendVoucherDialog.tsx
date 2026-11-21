import { EditOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, InputNumber, message, Tooltip } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, treasuryControllerAmendPayment, treasuryControllerAmendReceipt } from '@erp/api-client';
import { DatePicker } from '../../components/DatePicker';
import { EnterNav } from '../../components/EnterNav';
import { FormDialog, FormSection } from '../../components/FormDialog';
import { useDocumentLock } from '../../hooks/useDocumentLock';
import { idemHeaders } from '../../idempotency';

export interface AmendableVoucher {
  id: string;
  date: string;
  amount: string;
  referenceNo?: string | null;
  description?: string | null;
}

/** ADR-039: edits a posted receipt or payment in place (date, amount, reference, description). */
export function AmendVoucherButton({
  kind,
  voucher,
  onDone,
  onDialogOpenChange,
  disabled = false,
  disabledTooltip,
}: {
  kind: 'receipt' | 'payment';
  voucher: AmendableVoucher;
  onDone: () => void;
  onDialogOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  disabledTooltip?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [api, contextHolder] = message.useMessage();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [referenceNo, setReferenceNo] = useState('');
  const [description, setDescription] = useState('');
  const docType = kind === 'receipt' ? 'RECEIPT' : 'PAYMENT';
  const lock = useDocumentLock(docType, voucher.id, open);
  useEffect(() => {
    if (lock.state.status !== 'locked') return;
    void queryClient.invalidateQueries({ queryKey: ['document-lock-status', docType, voucher.id] });
    setOpen(false);
  }, [docType, lock.state, queryClient, voucher.id]);
  useEffect(() => onDialogOpenChange?.(open), [onDialogOpenChange, open]);

  const start = () => {
    // The API's date is midnight UTC: take the calendar day, not the local instant.
    setDate(dayjs(voucher.date.slice(0, 10)));
    setAmount(voucher.amount);
    setReferenceNo(voucher.referenceNo ?? '');
    setDescription(voucher.description ?? '');
    setOpen(true);
  };

  const amend = useMutation({
    mutationFn: async () => {
      const fn = kind === 'receipt' ? treasuryControllerAmendReceipt : treasuryControllerAmendPayment;
      const res = await fn(
        voucher.id,
        {
          voucherDate: date!.format('YYYY-MM-DD'),
          amount: amount!,
          referenceNo: referenceNo || undefined,
          description: description || undefined,
        },
        { headers: { ...idemHeaders(), ...lock.headers } },
      );
      return res.data;
    },
    onSuccess: () => {
      api.success(t('treasury.amended'));
      setOpen(false);
      onDone();
    },
    onError: (err) =>
      api.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, {
              userName: String(err.details?.userName ?? ''),
              defaultValue: err.message,
            })
          : t('errors.INTERNAL'),
      ),
  });

  const save = () => {
    if (lock.state.status !== 'held' && lock.state.status !== 'reconnecting') return;
    if (!date || !amount) {
      api.error(t('treasury.amendRequired'));
      return;
    }
    amend.mutate();
  };

  return (
    <>
      {contextHolder}
      <Tooltip title={disabledTooltip}>
        <span>
          <Button icon={<EditOutlined />} onClick={start} disabled={disabled}>
            {t('journal.amend')}
          </Button>
        </span>
      </Tooltip>
      <FormDialog
        open={open}
        title={t('treasury.amendTitle')}
        onCancel={() => setOpen(false)}
        onSave={save}
        saving={amend.isPending || lock.state.status === 'acquiring'}
        destroyOnHidden
      >
        {lock.state.status !== 'held' &&
        lock.state.status !== 'lost' &&
        lock.state.status !== 'reconnecting' ? (
          <Alert
            type={lock.state.status === 'error' ? 'error' : 'info'}
            showIcon
            message={lock.state.status === 'error' ? t('errors.INTERNAL') : t('common.documentLockAcquiring')}
          />
        ) : (
        <EnterNav autoFocusWhen={open}>
          <Form layout="vertical" component="div">
            {lock.state.status === 'reconnecting' && (
              <Alert type="warning" showIcon message={t('common.documentLockReconnecting')} />
            )}
            {lock.state.status === 'lost' && (
              <Alert type="error" showIcon message={t('common.documentLockLost')} />
            )}
            <FormSection title={t('treasury.amendTitle')} icon={<EditOutlined />}>
              <Form.Item label={t('treasury.date')} required>
                <DatePicker value={date} onChange={(d) => setDate(d)} />
              </Form.Item>
              <Form.Item label={t('treasury.amount')} required>
                <InputNumber<string> stringMode min="0" value={amount} onChange={(v) => setAmount(v)} />
              </Form.Item>
              <Form.Item label={t('treasury.referenceNo')}>
                <Input value={referenceNo} maxLength={100} onChange={(e) => setReferenceNo(e.target.value)} />
              </Form.Item>
              <Form.Item label={t('common.description')}>
                <Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
              </Form.Item>
            </FormSection>
          </Form>
        </EnterNav>
        )}
      </FormDialog>
    </>
  );
}
