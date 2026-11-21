import { EditOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Form, Input, InputNumber, message, Modal } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, treasuryControllerAmendPayment, treasuryControllerAmendReceipt } from '@erp/api-client';
import { useAuth } from '../../auth/AuthContext';
import { PERMISSIONS } from '../../auth/permissions';
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
}: {
  kind: 'receipt' | 'payment';
  voucher: AmendableVoucher;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const [api, contextHolder] = message.useMessage();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [referenceNo, setReferenceNo] = useState('');
  const [description, setDescription] = useState('');
  const [lockedBy, setLockedBy] = useState<{ userName: string; acquiredAt: string } | null>(null);
  const lock = useDocumentLock(kind === 'receipt' ? 'RECEIPT' : 'PAYMENT', voucher.id, open);
  useEffect(() => {
    if (lock.state.status !== 'locked') return;
    setLockedBy({ userName: lock.state.userName, acquiredAt: lock.state.acquiredAt });
    setOpen(false);
  }, [lock.state]);

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
    if (lock.state.status !== 'held') return;
    if (!date || !amount) {
      api.error(t('treasury.amendRequired'));
      return;
    }
    amend.mutate();
  };

  return (
    <>
      {contextHolder}
      {lockedBy && (
        <Alert
          type="warning"
          showIcon
          message={t('common.documentLockLocked', {
            name: lockedBy.userName,
            time: new Date(lockedBy.acquiredAt).toLocaleString(i18n.language),
          })}
          action={
            can(PERMISSIONS.DOCUMENT_UNLOCK) ? (
              <Button
                onClick={() =>
                  Modal.confirm({
                    title: t('common.documentLockUnlockConfirm'),
                    onOk: async () => {
                      await lock.forceRelease();
                      setLockedBy(null);
                      start();
                    },
                  })
                }
              >
                {t('common.documentLockUnlock')}
              </Button>
            ) : undefined
          }
        />
      )}
      <Button icon={<EditOutlined />} onClick={start}>
        {t('journal.amend')}
      </Button>
      <FormDialog
        open={open}
        title={t('treasury.amendTitle')}
        onCancel={() => setOpen(false)}
        onSave={save}
        saving={amend.isPending || lock.state.status === 'acquiring'}
        destroyOnHidden
      >
        {lock.state.status !== 'held' && lock.state.status !== 'lost' ? (
          <Alert
            type={lock.state.status === 'error' ? 'error' : 'info'}
            showIcon
            message={lock.state.status === 'error' ? t('errors.INTERNAL') : t('common.documentLockAcquiring')}
          />
        ) : (
        <EnterNav autoFocusWhen={open}>
          <Form layout="vertical" component="div">
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
