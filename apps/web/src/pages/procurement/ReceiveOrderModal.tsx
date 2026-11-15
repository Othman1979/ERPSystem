import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, DatePicker, InputNumber, Modal, Table, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import Decimal from 'decimal.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ApiError,
  goodsNotesControllerPost,
  receivingControllerReceive,
  type GoodsNoteDetailDto,
  type PurchaseOrderDetailDto,
  type PurchaseOrderLineViewDto,
  type ReceiveLineDto,
} from '@erp/api-client';
import { idemHeaders } from '../../idempotency';
import { codeAndName } from '../../i18n/displayName';
import { cellLabel } from '../../components/gridA11y';
import { qtyCell } from '../../format/cells';
import { dec, toDecimal } from '../../format/number';
import { invalidateProcurement } from './queryKeys';

/*
 * Receiving against an order (ADR-026): the user records how much of each line
 * arrived. The API creates a draft goods receipt note; posting it moves the stock
 * and updates the lines' received quantities. Every quantity here is in base units.
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
  /** Called once the receipt is posted; the page refreshes the order from it. */
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
  // The draft receipt once created: the step that posts it.
  const [draft, setDraft] = useState<GoodsNoteDetailDto | null>(null);
  const plan = planReceive(lines, qtys);
  const onError = (err: unknown) => apiMessage.error(errorText(t, err));

  const receive = useMutation({
    mutationFn: () =>
      receivingControllerReceive(
        order.id,
        { noteDate: date.format('YYYY-MM-DD'), lines: plan.lines },
        { headers: idemHeaders() },
      ).then((r) => r.data),
    onSuccess: (note) => {
      setDraft(note);
      void invalidateProcurement(queryClient);
    },
    onError,
  });

  const post = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('no receipt to post');
      return goodsNotesControllerPost(draft.id, { headers: idemHeaders() });
    },
    onSuccess: () => {
      apiMessage.success(t('procurement.receiptPosted'));
      void invalidateProcurement(queryClient);
      onDone();
    },
    onError,
  });

  const busy = receive.isPending || post.isPending;

  const submit = () => {
    setTried(true);
    if (busy || plan.lines.length === 0 || plan.invalid.size > 0) return;
    receive.mutate();
  };

  const footer = draft
    ? [
        <Button key="done" onClick={onClose}>
          {t('procurement.receiveDone')}
        </Button>,
        <Button key="post" type="primary" loading={post.isPending} disabled={busy} onClick={() => post.mutate()}>
          {t('procurement.postReceipt')}
        </Button>,
      ]
    : [
        <Button key="cancel" onClick={onClose}>
          {t('common.cancel')}
        </Button>,
        <Button key="submit" type="primary" loading={receive.isPending} disabled={busy} onClick={submit}>
          {t('procurement.receiveSubmit')}
        </Button>,
      ];

  return (
    <Modal open={open} title={t('procurement.receiveTitle')} onCancel={onClose} footer={footer} width={880} destroyOnClose>
      {contextHolder}
      {draft ? (
        <Alert type="success" showIcon message={t('procurement.receiptDrafted')} />
      ) : (
        <>
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
        </>
      )}
    </Modal>
  );
}
