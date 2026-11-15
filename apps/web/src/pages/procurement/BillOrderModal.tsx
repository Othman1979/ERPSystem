import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Checkbox, DatePicker, Input, Modal, Radio, Select, Table, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  purchasesControllerBill,
  purchasesControllerBillable,
  type BillableLineDto,
  type PurchaseOrderDetailDto,
  type PurchaseOrderLineViewDto,
} from '@erp/api-client';
import { selectCashBank, useAccounts } from '../../hooks/useAccounts';
import { StatusTag } from '../../components/StatusTag';
import { qtyCell, unitCostCell } from '../../format/cells';
import { codeAndName } from '../../i18n/displayName';
import { idemHeaders } from '../../idempotency';
import { invalidateStockDocument } from '../../stockQueries';
import { invalidateProcurement, procurementKeys } from './queryKeys';
import {
  aboveRows,
  billBody,
  billIssues,
  defaultBillRows,
  isBilledRow,
  type BillHeaderForm,
  type BillIssue,
  type BillRow,
} from './billPayload';

export interface BillOrderModalProps {
  order: PurchaseOrderDetailDto;
  open: boolean;
  onClose: () => void;
  /** Called with the new draft invoice after the bill is saved. */
  onBilled: (invoiceId: string) => void;
}

/** The form starts with today's date, a credit bill and no cash account. */
function defaultHeader(): BillHeaderForm {
  return { invoiceDate: dayjs().format('YYYY-MM-DD'), paymentType: 'CREDIT', supplierInvoiceNo: '' };
}

/**
 * Bills a purchase order from its posted receipts (ADR-026): a three-way
 * match of receipt, order and invoice lines. The server prices and checks the
 * bill; this view shows the match and flags lines priced above the order.
 */
export function BillOrderModal({ order, open, onClose, onBilled }: BillOrderModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const accounts = useAccounts(selectCashBank);
  const [header, setHeader] = useState<BillHeaderForm>(defaultHeader);
  const [rows, setRows] = useState<BillRow[]>([]);
  const [tried, setTried] = useState(false);

  // Fetched on each opening: the match always reflects what is unbilled now,
  // and no refetch on focus, so the user's edits are not replaced underneath.
  const billable = useQuery({
    queryKey: [...procurementKeys.order(order.id), 'billable'],
    queryFn: ({ signal }) => purchasesControllerBillable(order.id, { signal }).then((r) => r.data),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (open) {
      setHeader(defaultHeader());
      setTried(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && billable.data) setRows(defaultBillRows(billable.data));
  }, [open, billable.data]);

  const linesById = useMemo(
    () => new Map<string, BillableLineDto>((billable.data?.lines ?? []).map((l) => [l.grnLineId, l])),
    [billable.data],
  );
  const orderLinesById = useMemo(
    () => new Map<string, PurchaseOrderLineViewDto>((order.lines ?? []).map((l) => [l.id, l])),
    [order.lines],
  );
  // The receipts the selected rows bill, shown in the header so the user sees which GRNs are included.
  const grnLabels = [
    ...new Set(
      rows
        .filter((r) => r.selected)
        .map((r) => linesById.get(r.grnLineId))
        .filter((l): l is BillableLineDto => l !== undefined)
        .map((l) => l.grnDocNo ?? `#${l.grnId}`),
    ),
  ];
  const issues: BillIssue[] = billable.data ? billIssues(billable.data, header, rows) : [];
  const above = billable.data ? aboveRows(billable.data, rows) : [];
  const aboveIds = new Set(above.map((r) => r.grnLineId));
  const billedCount = rows.filter(isBilledRow).length;

  const patchRow = (grnLineId: string, patch: Partial<BillRow>) =>
    setRows((current) => current.map((r) => (r.grnLineId === grnLineId ? { ...r, ...patch } : r)));

  const bill = useMutation({
    mutationFn: () =>
      purchasesControllerBill(order.id, billBody(header, rows), { headers: idemHeaders() }),
    onSuccess: (res) => {
      invalidateProcurement(queryClient);
      invalidateStockDocument(queryClient, 'purchaseInvoice');
      onBilled(res.data.id);
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
      ),
  });

  const submit = () => {
    setTried(true);
    if (issues.length > 0) return;
    bill.mutate();
  };

  const issueText = (issue: BillIssue) => t(`billing.issue.${issue.code}`);
  const issuesByLine = (grnLineId: string) =>
    issues.filter((i) => i.grnLineId === grnLineId && i.code !== 'NO_LINES');

  const columns = [
    {
      title: '',
      width: 40,
      render: (_: unknown, r: BillRow) => (
        <Checkbox
          aria-label={t('billing.selectLine')}
          checked={r.selected}
          onChange={(e) => patchRow(r.grnLineId, { selected: e.target.checked })}
        />
      ),
    },
    {
      title: t('billing.grnNo'),
      render: (_: unknown, r: BillRow) => linesById.get(r.grnLineId)?.grnDocNo ?? '—',
    },
    {
      title: t('items.title'),
      render: (_: unknown, r: BillRow) => {
        const line = linesById.get(r.grnLineId);
        if (!line) return null;
        return (
          <>
            <div>{codeAndName(line.item)}</div>
            {aboveIds.has(r.grnLineId) && (
              <div style={{ marginTop: 4 }}>
                <StatusTag tone="warning">{t('billing.aboveOrderPrice')}</StatusTag>
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                  {t('billing.aboveOrderPriceHint')}
                </Typography.Text>
              </div>
            )}
          </>
        );
      },
    },
    {
      title: t('procurement.orderedQty'),
      align: 'end' as const,
      render: (_: unknown, r: BillRow) => {
        const poLineId = linesById.get(r.grnLineId)?.poLineId ?? '';
        return qtyCell(orderLinesById.get(poLineId)?.qtyBase);
      },
    },
    {
      title: t('billing.received'),
      align: 'end' as const,
      render: (_: unknown, r: BillRow) => qtyCell(linesById.get(r.grnLineId)?.receivedQty),
    },
    {
      title: t('billing.billed'),
      align: 'end' as const,
      render: (_: unknown, r: BillRow) => qtyCell(linesById.get(r.grnLineId)?.billedQty),
    },
    {
      title: t('billing.unbilled'),
      align: 'end' as const,
      render: (_: unknown, r: BillRow) => qtyCell(linesById.get(r.grnLineId)?.unbilledQty),
    },
    {
      title: t('stock.qty'),
      width: 120,
      render: (_: unknown, r: BillRow) => {
        const lineIssues = issuesByLine(r.grnLineId).filter((i) => i.code.startsWith('QTY'));
        return (
          <Input
            aria-label={t('stock.qty')}
            inputMode="decimal"
            value={r.qty}
            status={tried && lineIssues.length > 0 ? 'error' : undefined}
            onChange={(e) => patchRow(r.grnLineId, { qty: e.target.value })}
          />
        );
      },
    },
    {
      title: t('billing.receiptCost'),
      align: 'end' as const,
      render: (_: unknown, r: BillRow) => unitCostCell(linesById.get(r.grnLineId)?.receiptUnitCost),
    },
    {
      title: t('billing.orderNetPrice'),
      align: 'end' as const,
      render: (_: unknown, r: BillRow) => unitCostCell(linesById.get(r.grnLineId)?.orderNetUnitPrice),
    },
    {
      title: t('purchases.unitCost'),
      width: 130,
      render: (_: unknown, r: BillRow) => {
        const lineIssues = issuesByLine(r.grnLineId).filter((i) => i.code === 'UNIT_COST_INVALID');
        return (
          <Input
            aria-label={t('purchases.unitCost')}
            inputMode="decimal"
            value={r.unitCost}
            status={tried && lineIssues.length > 0 ? 'error' : undefined}
            onChange={(e) => patchRow(r.grnLineId, { unitCost: e.target.value })}
          />
        );
      },
    },
    {
      title: t('purchases.discountPct'),
      width: 100,
      render: (_: unknown, r: BillRow) => {
        const lineIssues = issuesByLine(r.grnLineId).filter((i) => i.code === 'DISCOUNT_INVALID');
        return (
          <Input
            aria-label={t('purchases.discountPct')}
            inputMode="decimal"
            value={r.discountPct}
            status={tried && lineIssues.length > 0 ? 'error' : undefined}
            onChange={(e) => patchRow(r.grnLineId, { discountPct: e.target.value })}
          />
        );
      },
    },
  ];

  const shownIssues = tried ? issues : [];
  const orderLabel = order.orderNo ?? `#${order.id}`;

  return (
    <Modal
      open={open}
      title={
        <>
          <div>{t('billing.billOrderTitle', { orderNo: orderLabel })}</div>
          {grnLabels.length > 0 && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 13, fontWeight: 400 }}>
              {t('billing.grnsIncluded', { list: grnLabels.join(', ') })}
            </Typography.Text>
          )}
        </>
      }
      width={1100}
      destroyOnClose
      okText={t('billing.submit')}
      cancelText={t('common.cancel')}
      onOk={submit}
      onCancel={onClose}
      confirmLoading={bill.isPending}
      okButtonProps={{ type: 'primary', disabled: !billable.data || rows.length === 0 }}
    >
      {contextHolder}
      {billable.isError && <Alert type="error" showIcon message={t('common.loadFailed')} />}
      {billable.isLoading && <Typography.Text>{t('common.loading')}</Typography.Text>}

      {billable.data && rows.length === 0 && (
        <Alert type="info" showIcon message={t('billing.nothingToBill')} style={{ marginBottom: 12 }} />
      )}

      {above.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t('billing.needsApproval', { count: above.length })}
          style={{ marginBottom: 12 }}
        />
      )}

      {shownIssues.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {[...new Map(shownIssues.map((i) => [i.code + (i.grnLineId ?? ''), i])).values()].map((i) => (
                <li key={i.code + (i.grnLineId ?? '')}>{issueText(i)}</li>
              ))}
            </ul>
          }
          style={{ marginBottom: 12 }}
        />
      )}

      {billable.data && rows.length > 0 && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <Typography.Text>{t('purchases.invoiceDate')}</Typography.Text>
              <DatePicker
                style={{ width: '100%' }}
                format="YYYY-MM-DD"
                value={dayjs(header.invoiceDate)}
                onChange={(d: Dayjs | null) =>
                  setHeader((h) => ({ ...h, invoiceDate: d ? d.format('YYYY-MM-DD') : h.invoiceDate }))
                }
              />
            </div>
            <div>
              <Typography.Text>{t('purchases.paymentType')}</Typography.Text>
              <div>
                <Radio.Group
                  value={header.paymentType}
                  onChange={(e) => setHeader((h) => ({ ...h, paymentType: e.target.value }))}
                  options={[
                    { value: 'CREDIT', label: t('purchases.CREDIT') },
                    { value: 'CASH', label: t('purchases.CASH') },
                  ]}
                  optionType="button"
                />
              </div>
            </div>
            {header.paymentType === 'CASH' && (
              <div>
                <Typography.Text>{t('purchases.cashAccount')}</Typography.Text>
                <Select
                  style={{ width: '100%' }}
                  status={tried && !header.cashAccountId ? 'error' : undefined}
                  showSearch
                  optionFilterProp="label"
                  value={header.cashAccountId}
                  onChange={(v: string) => setHeader((h) => ({ ...h, cashAccountId: v }))}
                  options={(accounts.data ?? []).map((a) => ({ value: a.id, label: codeAndName(a) }))}
                />
              </div>
            )}
            <div>
              <Typography.Text>{t('purchases.supplierInvoiceNo')}</Typography.Text>
              <Input
                maxLength={100}
                value={header.supplierInvoiceNo}
                onChange={(e) => setHeader((h) => ({ ...h, supplierInvoiceNo: e.target.value }))}
              />
            </div>
          </div>

          <Table
            rowKey="grnLineId"
            size="small"
            pagination={false}
            dataSource={rows}
            columns={columns}
            scroll={{ x: true }}
          />
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            {t('billing.selectedCount', { count: billedCount })}
          </Typography.Text>
        </>
      )}
    </Modal>
  );
}
