import { EditOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { Button, Form, Input, InputNumber, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, treasuryControllerAmendPayment, treasuryControllerAmendReceipt } from '@erp/api-client';
import { DatePicker } from '../../components/DatePicker';
import { EnterNav } from '../../components/EnterNav';
import { FormDialog, FormSection } from '../../components/FormDialog';
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
  const { t } = useTranslation();
  const [api, contextHolder] = message.useMessage();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState<Dayjs | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [referenceNo, setReferenceNo] = useState('');
  const [description, setDescription] = useState('');

  const start = () => {
    setDate(dayjs(voucher.date));
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
        { headers: idemHeaders() },
      );
      return res.data;
    },
    onSuccess: () => {
      api.success(t('treasury.amended'));
      setOpen(false);
      onDone();
    },
    onError: (err) =>
      api.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL')),
  });

  const save = () => {
    if (!date || !amount) {
      api.error(t('treasury.amendRequired'));
      return;
    }
    amend.mutate();
  };

  return (
    <>
      {contextHolder}
      <Button icon={<EditOutlined />} onClick={start}>
        {t('journal.amend')}
      </Button>
      <FormDialog
        open={open}
        title={t('treasury.amendTitle')}
        onCancel={() => setOpen(false)}
        onSave={save}
        saving={amend.isPending}
        destroyOnHidden
      >
        <EnterNav autoFocusWhen={open}>
          <Form layout="vertical" component="div">
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
      </FormDialog>
    </>
  );
}
