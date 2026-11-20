import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, InputNumber, Modal, Table, Typography, message } from 'antd';
import { DatePicker } from '../../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import Decimal from 'decimal.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ApiError,
  receivingControllerReceive,
  type PurchaseOrderDetailDto,
  type PurchaseOrderLineViewDto,
  type ReceiveLineDto,
} from '@erp/api-client';
import { idemHeaders } from '../../idempotency';
import { codeAndName } from '../../i18n/displayName';
import { cellLabel } from '../../components/gridA11y';
import { qtyCell } from '../../format/cells';
import { dec, toDecimal } from '../../format/number';
import { invalidateStockDocument } from '../../stockQueries';
import { invalidateProcurement } from './queryKeys';

/*
 * Receiving against an order (ADR-026): the user records how much of each line
 * arrived. One action creates and posts the goods receipt in a single server
 * transaction, which moves the stock and updates the lines' received quantities.
 * Every quantity here is in base units.
 */

/** Base quantity still to receive on a line: ordered minus received, never below zero. */
export function remainingBaseQty(line: PurchaseOrderLineViewDto): Decimal {
  const left = dec(line.qtyBase).minus(dec(line.receivedQty));
  return left.gt(0) ? left : new Decimal(0);
}

/** Each line's quantity input starts at what is still left on it. */
export function defaultReceiveQtys(lines: PurchaseOrderLineViewDto[]): Record<string, string> {
  return Object.fromEntries(lines.map((l) => [l.id, remainingBaseQty(l).toFixed()]));
}

export interface ReceivePlan {
  /** The lines to send: only those with a quantity above zero. */
  lines: ReceiveLineDto[];
  /** Ids of the lines whose typed quantity is not a number from zero up to what is left. */
  invalid: Set<string>;
}

/**
 * Reads the typed quantities. A blank or zero line is skipped; a quantity that is
 * not a number, is negative, or is above what is left on the line is invalid.
 */
export function planReceive(lines: PurchaseOrderLineViewDto[], qtys: Record<string, string>): ReceivePlan {
  const plan: ReceivePlan = { lines: [], invalid: new Set() };
  for (const l of lines) {
    const raw = (qtys[l.id] ?? '').trim();
    if (raw === '') continue;
    const qty = toDecimal(raw);
    if (qty === null || qty.lt(0) || qty.gt(remainingBaseQty(l))) {
      plan.invalid.add(l.id);
      continue;
    }
    if (qty.isZero()) continue;
    plan.lines.push({ poLineId: l.id, qty: qty.toFixed() });
  }
  return plan;
}

function errorText(t: TFunction, err: unknown): string {
  return err instanceof ApiError
    ? t(`errors.${err.code}`, { defaultValue: err.message })
    : t('errors.INTERNAL');
}

export interface ReceiveOrderModalProps {
  order: PurchaseOrderDetailDto;
  open: boolean;
  onClose: () => void;
  /** Called once the receipt is posted; the page closes the modal and refreshes the order. */
  onDone: () => void;
}

export function ReceiveOrderModal({ order, open, onClose, onDone }: ReceiveOrderModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const lines = order.lines ?? [];
  const [date, setDate] = useState<Dayjs>(() => dayjs());
  const [qtys, setQtys] = useState<Record<string, string>>(() => defaultReceiveQtys(lines));
  const [tried, setTried] = useState(false);
  const plan = planReceive(lines, qtys);

  const receive = useMutation({
    mutationFn: () =>
      receivingControllerReceive(
        order.id,
        { noteDate: date.format('YYYY-MM-DD'), lines: plan.lines },
        { headers: idemHeaders() },
      ).then((r) => r.data),
    onSuccess: (note) => {
      apiMessage.success(t('procurement.receiptPostedNo', { docNo: note.docNo ?? `#${note.id}` }));
      void invalidateProcurement(queryClient);
      invalidateStockDocument(queryClient, 'goodsNote');
      onDone();
    },
    onError: (err) => apiMessage.error(errorText(t, err)),
  });

  const submit = () => {
    setTried(true);
    if (receive.isPending || plan.lines.length === 0 || plan.invalid.size > 0) return;
    receive.mutate();
  };

  const footer = [
    <Button key="cancel" onClick={onClose}>
      {t('common.cancel')}
    </Button>,
    <Button key="submit" type="primary" loading={receive.isPending} disabled={receive.isPending} onClick={submit}>
      {t('procurement.receiveSubmit')}
    </Button>,
  ];

  return (
    <Modal open={open} title={t('procurement.receiveTitle')} onCancel={onClose} footer={footer} width={880} destroyOnClose>
      {contextHolder}
      <div style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">{t('procurement.receiveDate')}</Typography.Text>
        <div>
          <DatePicker value={date} onChange={(d) => d && setDate(d)} />
        </div>
      </div>
      <Table<PurchaseOrderLineViewDto>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={lines}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          { title: t('procurement.item'), render: (_: unknown, l: PurchaseOrderLineViewDto) => codeAndName(l.item) ?? l.itemId },
          { title: t('procurement.orderedQty'), dataIndex: 'qtyBase', width: 100, align: 'right' as const, render: qtyCell },
          { title: t('procurement.receivedQty'), dataIndex: 'receivedQty', width: 100, align: 'right' as const, render: qtyCell },
          {
            title: t('procurement.leftToReceive'),
            width: 100,
            align: 'right' as const,
            render: (_: unknown, l: PurchaseOrderLineViewDto) => qtyCell(remainingBaseQty(l).toFixed()),
          },
          {
            title: t('procurement.receiveQty'),
            width: 140,
            render: (_: unknown, l: PurchaseOrderLineViewDto, row: number) => (
              <InputNumber<string>
                aria-label={cellLabel(t, t('procurement.receiveQty'), row)}
                stringMode
                min="0"
                disabled={remainingBaseQty(l).isZero()}
                status={plan.invalid.has(l.id) ? 'error' : undefined}
                value={qtys[l.id] ?? ''}
                onChange={(v) => setQtys((prev) => ({ ...prev, [l.id]: v ?? '' }))}
                style={{ width: '100%' }}
                size="small"
                controls={false}
              />
            ),
          },
        ]}
      />
      {tried && plan.lines.length === 0 && <Typography.Text type="danger">{t('procurement.receiveNothing')}</Typography.Text>}
      {plan.invalid.size > 0 && <Typography.Text type="danger">{t('procurement.receiveTooMany')}</Typography.Text>}
    </Modal>
  );
}
