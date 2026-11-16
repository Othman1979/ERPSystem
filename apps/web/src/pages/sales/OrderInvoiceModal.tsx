import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DatePicker, Modal, Radio, Select, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { salesCycleControllerInvoiceOrder, type SalesCycleOrderDetailDto } from '@erp/api-client';
import { selectCashBank, useAccounts } from '../../hooks/useAccounts';
import { codeAndName } from '../../i18n/displayName';
import { idemHeaders } from '../../idempotency';
import { invalidateSalesCycle } from './cycleQueryKeys';
import { apiErrorText as errorText } from '../../components/ExportButtons';
import { orderInvoiceBody, orderInvoiceGaps, type OrderInvoiceForm } from './orderPayload';

/** The form starts with today's date, a credit invoice and no account (ADR-027 §4). */
function defaultForm(): OrderInvoiceForm {
  return { invoiceDate: dayjs().format('YYYY-MM-DD'), paymentType: 'CREDIT' };
}

/**
 * Makes a draft sales invoice from a confirmed order: what is left of each
 * line is copied, and the user picks the payment. The invoice is only a draft;
 * posting it is a separate step on the invoice screen.
 */
export function OrderInvoiceModal({
  order,
  open,
  onClose,
  onCreated,
}: {
  order: SalesCycleOrderDetailDto;
  open: boolean;
  onClose: () => void;
  /** Called with the new draft invoice's id. */
  onCreated: (invoiceId: string) => void;
}) {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const queryClient = useQueryClient();
  const accounts = useAccounts(selectCashBank);
  const [form, setForm] = useState<OrderInvoiceForm>(defaultForm);
  const [tried, setTried] = useState(false);
  const gaps = orderInvoiceGaps(form);

  const create = useMutation({
    mutationFn: () => salesCycleControllerInvoiceOrder(order.id, orderInvoiceBody(form), { headers: idemHeaders() }),
    onSuccess: (res) => {
      void invalidateSalesCycle(queryClient);
      onCreated(res.data.id);
    },
    onError: (err) => apiMessage.error(errorText(t, err)),
  });

  const submit = () => {
    setTried(true);
    if (gaps.cashAccount || create.isPending) return;
    create.mutate();
  };

  const orderLabel = order.orderNo ?? `#${order.id}`;

  return (
    <Modal
      open={open}
      title={t('salesCycle.invoiceModalTitle', { orderNo: orderLabel })}
      okText={t('salesCycle.createInvoice')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      destroyOnHidden
      onOk={submit}
      onCancel={onClose}
    >
      {contextHolder}
      <Typography.Paragraph type="secondary">{t('salesCycle.invoiceModalHint')}</Typography.Paragraph>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <Typography.Text>{t('sales.paymentType')}</Typography.Text>
          <div>
            <Radio.Group
              value={form.paymentType}
              onChange={(e) => setForm((f) => ({ ...f, paymentType: e.target.value as 'CASH' | 'CREDIT' }))}
              optionType="button"
              options={[
                { value: 'CREDIT', label: t('sales.CREDIT') },
                { value: 'CASH', label: t('sales.CASH') },
              ]}
            />
          </div>
        </div>
        {form.paymentType === 'CASH' && (
          <div>
            <Typography.Text>{t('sales.cashAccount')}</Typography.Text>
            <Select
              style={{ width: '100%' }}
              status={tried && gaps.cashAccount ? 'error' : undefined}
              showSearch
              optionFilterProp="label"
              value={form.cashAccountId}
              onChange={(v: string) => setForm((f) => ({ ...f, cashAccountId: v }))}
              options={(accounts.data ?? []).map((a) => ({ value: a.id, label: codeAndName(a) }))}
            />
          </div>
        )}
        <div>
          <Typography.Text>{t('sales.invoiceDate')}</Typography.Text>
          <DatePicker
            style={{ width: '100%' }}
            value={dayjs(form.invoiceDate)}
            onChange={(d: Dayjs | null) => setForm((f) => ({ ...f, invoiceDate: d ? d.format('YYYY-MM-DD') : f.invoiceDate }))}
          />
        </div>
        <div>
          <Typography.Text>{t('sales.dueDate')}</Typography.Text>
          <DatePicker
            style={{ width: '100%' }}
            allowClear
            value={form.dueDate ? dayjs(form.dueDate) : null}
            onChange={(d: Dayjs | null) => setForm((f) => ({ ...f, dueDate: d ? d.format('YYYY-MM-DD') : undefined }))}
          />
        </div>
      </div>
    </Modal>
  );
}
