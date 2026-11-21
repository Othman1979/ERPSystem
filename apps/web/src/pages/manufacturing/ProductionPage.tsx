import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Popconfirm, Select, Space, Table, Typography, message } from 'antd';
import { DatePicker } from '../../components/DatePicker';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { formatDate, formatDateTime } from '../../format/date';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import {
  productionVouchersControllerGet,
  productionVouchersControllerList,
  productionVouchersControllerReverse,
  type ProductionVoucherDetailDto,
  type ProductionVoucherLineDetailDto,
  type ProductionVoucherListItemDto,
  type DocumentStatus,
  type ProductionVouchersControllerListStatus,
} from '@erp/api-client';
import { useAuth } from '../../auth/AuthContext';
import { PERMISSIONS } from '../../auth/permissions';
import { DocField, DocFields, DocLayout, DocValue } from '../../components/DocLayout';
import { apiErrorText } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { NoAccess } from '../../components/NoAccess';
import { PageHeader } from '../../components/PageHeader';
import { PrintPdfButton } from '../../components/PrintPdfButton';
import { StatusTag, type StatusTone } from '../../components/StatusTag';
import { tableLocale } from '../../components/QueryState';
import { amountCell } from '../../format/cells';
import { formatAmount, formatQty, formatUnitCost } from '../../format/number';
import { idemHeaders } from '../../idempotency';
import { codeAndName } from '../../i18n/displayName';
import { usePagedQuery } from '../../hooks/usePagedQuery';
import { useNewFromUrl } from '../../useNewFromUrl';
import { ProductionEditor, type ProductionPrefill } from './ProductionEditor';
import { invalidateManufacturing, productionKeys } from './manufacturingQueries';
import { ManufacturedItemPicker } from './pickers';

/** What the page shows: the list, a new voucher (optionally prefilled), or one saved voucher. */
type Screen = { kind: 'list' } | { kind: 'new'; prefill?: ProductionPrefill } | { kind: 'voucher'; id: string };

const STATUSES: DocumentStatus[] = ['DRAFT', 'POSTED'];

const STATUS_TONE: Record<DocumentStatus, StatusTone> = {
  DRAFT: 'neutral',
  POSTED: 'success',
};

function VoucherStatusTag({ status }: { status: DocumentStatus }) {
  const { t } = useTranslation();
  return <StatusTag tone={STATUS_TONE[status]}>{t(`manufacturing.prod.status.${status}`)}</StatusTag>;
}

/**
 * Production vouchers (ADR-031 §7–§8): the materials of a formula become the
 * product. A draft is edited and posted; a posted voucher is read, and it can be
 * reversed while its output is still in stock.
 */
export function ProductionPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // A reversal or an original links here with ?voucherId=...: that voucher opens. The address is cleaned up below.
  const linkedId = params.get('voucherId');
  const [screen, setScreen] = useState<Screen>(() => (linkedId ? { kind: 'voucher', id: linkedId } : { kind: 'list' }));
  useEffect(() => {
    if (!linkedId) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('voucherId');
        return next;
      },
      { replace: true },
    );
  }, [linkedId, setParams]);
  useNewFromUrl(() => setScreen({ kind: 'new' }));

  return (
    <div>
      <PageHeader title={t('nav.production')} />
      {screen.kind === 'list' ? (
        <VouchersList onOpen={(id) => setScreen({ kind: 'voucher', id })} onNew={() => setScreen({ kind: 'new' })} />
      ) : (
        <VoucherScreen
          key={screen.kind === 'voucher' ? `voucher-${screen.id}` : `new-${screen.prefill?.itemId ?? ''}`}
          id={screen.kind === 'voucher' ? screen.id : undefined}
          prefill={screen.kind === 'new' ? screen.prefill : undefined}
          onBack={() => setScreen({ kind: 'list' })}
          onOpen={(id) => setScreen({ kind: 'voucher', id })}
          onProduce={(itemId, qty) => setScreen({ kind: 'new', prefill: { itemId, qty } })}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ list

function VouchersList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<DocumentStatus | undefined>(undefined);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);

  // Server-paged (ADR-022): search, filters and page go to the API.
  const list = usePagedQuery<
    ProductionVoucherListItemDto,
    { itemId?: string; status?: ProductionVouchersControllerListStatus; from?: string; to?: string }
  >({
    key: productionKeys.list(),
    filters: { itemId, status, from, to },
    fetch: (params, signal) => productionVouchersControllerList(params, { signal }).then((r) => r.data),
  });

  const columns: ColumnsType<ProductionVoucherListItemDto> = [
    {
      title: t('manufacturing.prod.docNo'),
      dataIndex: 'docNo',
      width: 140,
      className: 'nowrap',
      render: (v: string | null) => v ?? t('procurement.draftNo'),
    },
    {
      title: t('manufacturing.prod.date'),
      dataIndex: 'voucherDate',
      width: 110,
      render: (v: string) => formatDate(v),
    },
    {
      title: t('manufacturing.prod.product'),
      dataIndex: 'item',
      minWidth: 180,
      render: (_: unknown, r: ProductionVoucherListItemDto) => codeAndName(r.item),
    },
    {
      title: t('manufacturing.prod.qty'),
      dataIndex: 'qty',
      width: 160,
      align: 'right' as const,
      render: (_: unknown, r: ProductionVoucherListItemDto) =>
        `${formatQty(r.qty)} ${codeAndName(r.itemUnit?.unit ?? r.item.baseUnit)}`,
    },
    {
      title: t('manufacturing.prod.outputTotal'),
      dataIndex: 'outputTotal',
      width: 130,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 120,
      render: (v: DocumentStatus, r: ProductionVoucherListItemDto) => (
        <Space size={4} wrap>
          <VoucherStatusTag status={v} />
          {r.reversalOfId && <StatusTag tone="warning">{t('manufacturing.prod.reversalTag')}</StatusTag>}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        searchPlaceholder={t('manufacturing.prod.searchPlaceholder')}
        filters={
          <Space wrap>
            <ManufacturedItemPicker
              allowClear
              style={{ minWidth: 220 }}
              placeholder={t('manufacturing.prod.product')}
              value={itemId}
              onChange={(v) => setItemId(v)}
            />
            <Select
              allowClear
              style={{ minWidth: 150 }}
              placeholder={t('common.status')}
              value={status}
              onChange={setStatus}
              options={STATUSES.map((s) => ({ value: s, label: t(`manufacturing.prod.status.${s}`) }))}
            />
            <DatePicker.RangePicker
              allowClear
              format="YYYY-MM-DD"
              value={from && to ? [dayjs(from), dayjs(to)] : null}
              onChange={(_, dateStrings) => {
                setFrom(dateStrings[0] || undefined);
                setTo(dateStrings[1] || undefined);
              }}
            />
          </Space>
        }
        count={list.total}
        actions={
          can(PERMISSIONS.STOCK_MOVEMENT) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={onNew}>
              {t('manufacturing.prod.new')}
            </Button>
          )
        }
      />
      <Table
        rowKey="id"
        loading={list.query.isLoading}
        dataSource={list.rows}
        locale={tableLocale(list.query)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
        onRow={(r) => ({ onClick: () => onOpen(r.id), style: { cursor: 'pointer' } })}
      />
    </div>
  );
}

// ------------------------------------------------------------------ screen

/** Loads a saved voucher: a draft (or a new one) opens in the editor, a posted one in the view. */
function VoucherScreen({
  id,
  prefill,
  onBack,
  onOpen,
  onProduce,
}: {
  id?: string;
  prefill?: ProductionPrefill;
  onBack: () => void;
  onOpen: (id: string) => void;
  onProduce: (itemId: string, qty: string) => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.STOCK_MOVEMENT);
  const detail = useQuery({
    queryKey: productionKeys.detail(id),
    queryFn: ({ signal }) => productionVouchersControllerGet(id!, { signal }).then((r) => r.data),
    enabled: !!id,
  });

  if (id && detail.isError) return <Alert type="error" showIcon message={t('common.loadFailed')} />;
  if (id && detail.isPending) return <Typography.Text>{t('common.loading')}</Typography.Text>;
  if (!id && !canManage) return <NoAccess />;

  const voucher = detail.data;
  if (voucher && (voucher.status !== 'DRAFT' || !canManage)) {
    return <VoucherView voucher={voucher} onBack={onBack} onOpen={onOpen} />;
  }
  return (
    <ProductionEditor
      voucher={voucher}
      prefill={prefill}
      onBack={onBack}
      onSaved={onOpen}
      onDeleted={onBack}
      onProduce={onProduce}
    />
  );
}

// ------------------------------------------------------------------ view

/**
 * A posted voucher: the materials at their standard and actual quantities, the
 * costs written at posting, the journal entry, and the reversal (ADR-031 §8).
 * A reversal and its original link to each other.
 */
function VoucherView({
  voucher,
  onBack,
  onOpen,
}: {
  voucher: ProductionVoucherDetailDto;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const canManage = can(PERMISSIONS.STOCK_MOVEMENT);
  const reversed = voucher.reversals.length > 0;
  const canReverse = canManage && voucher.status === 'POSTED' && !voucher.reversalOfId && !reversed;

  const reverse = useMutation({
    mutationFn: () => productionVouchersControllerReverse(voucher.id, { headers: idemHeaders() }),
    onSuccess: (res) => {
      apiMessage.success(t('manufacturing.prod.reversed'));
      void invalidateManufacturing(queryClient, { stock: true });
      onOpen(res.data.id);
    },
    onError: (err) => apiMessage.error(apiErrorText(t, err)),
  });

  const columns: ColumnsType<ProductionVoucherLineDetailDto> = [
    { title: '#', width: 44, render: (_: unknown, _l: ProductionVoucherLineDetailDto, index: number) => index + 1 },
    { title: t('manufacturing.prod.material'), render: (_: unknown, l: ProductionVoucherLineDetailDto) => codeAndName(l.item) },
    {
      title: t('manufacturing.prod.standardQty'),
      align: 'right',
      render: (_: unknown, l: ProductionVoucherLineDetailDto) => formatQty(l.standardQtyBase),
    },
    { title: t('manufacturing.prod.actualQty'), align: 'right', render: (_: unknown, l: ProductionVoucherLineDetailDto) => formatQty(l.qtyBase) },
    { title: t('manufacturing.prod.unitCost'), align: 'right', render: (_: unknown, l: ProductionVoucherLineDetailDto) => formatUnitCost(l.unitCost) },
    { title: t('manufacturing.prod.lineCost'), align: 'right', render: (_: unknown, l: ProductionVoucherLineDetailDto) => formatAmount(l.totalCost) },
  ];

  return (
    <DocLayout
      title={t('manufacturing.prod.viewTitle')}
      docNo={voucher.docNo ?? t('procurement.draftNo')}
      status={voucher.status}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          {canReverse && (
            <Popconfirm
              title={t('manufacturing.prod.reverseConfirm')}
              okText={t('manufacturing.prod.reverse')}
              okButtonProps={{ danger: true }}
              onConfirm={() => reverse.mutate()}
            >
              <Button danger loading={reverse.isPending}>
                {t('manufacturing.prod.reverse')}
              </Button>
            </Popconfirm>
          )}
          <PrintPdfButton path={`/production-vouchers/${voucher.id}/pdf`} />
        </>
      }
    >
      {voucher.reversalOf && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space wrap>
              {t('manufacturing.prod.isReversal')}
              <Button type="link" style={{ padding: 0 }} onClick={() => onOpen(voucher.reversalOf!.id)}>
                {t('manufacturing.prod.reversalOf', { no: voucher.reversalOf.docNo ?? '' })}
              </Button>
            </Space>
          }
        />
      )}
      {reversed && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space wrap>
              {t('manufacturing.prod.isReversed')}
              {voucher.reversals.map((r) => (
                <Button key={r.id} type="link" style={{ padding: 0 }} onClick={() => onOpen(r.id)}>
                  {t('manufacturing.prod.reversedBy', { no: r.docNo ?? '' })}
                </Button>
              ))}
            </Space>
          }
        />
      )}
      <DocFields>
        <DocField label={t('manufacturing.prod.product')}>
          <DocValue>{codeAndName(voucher.item)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.qty')}>
          <DocValue>{`${formatQty(voucher.qty)} ${codeAndName(voucher.itemUnit?.unit ?? voucher.item.baseUnit)}`}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.formula')}>
          <DocValue>{`v${voucher.bom.versionNo}`}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.date')}>
          <DocValue>{formatDate(voucher.voucherDate)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.materialsWarehouse')}>
          <DocValue>{codeAndName(voucher.materialsWarehouse)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.outputWarehouse')}>
          <DocValue>{codeAndName(voucher.outputWarehouse)}</DocValue>
        </DocField>
        {voucher.costCenter && (
          <DocField label={t('costCenters.documentField')}>
            <DocValue>{codeAndName(voucher.costCenter)}</DocValue>
          </DocField>
        )}
        {voucher.description && (
          <DocField label={t('manufacturing.prod.description')} wide>
            <DocValue>{voucher.description}</DocValue>
          </DocField>
        )}
        <DocField label={t('manufacturing.prod.materialsTotal')}>
          <DocValue>{formatAmount(voucher.materialsTotal)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.appliedTotal')}>
          <DocValue>{formatAmount(voucher.appliedTotal)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.outputTotal')}>
          <DocValue>{formatAmount(voucher.outputTotal)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.outputUnitCost')}>
          <DocValue>{formatUnitCost(voucher.outputUnitCost)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.journal')}>
          <DocValue>{voucher.journalEntry?.entryNo ?? '—'}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.prod.postedAt')}>
          <DocValue>{voucher.postedAt ? formatDateTime(voucher.postedAt) : '—'}</DocValue>
        </DocField>
      </DocFields>
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        {t('manufacturing.prod.lines')}
      </Typography.Title>
      <Table<ProductionVoucherLineDetailDto>
        rowKey="id"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={voucher.lines}
        columns={columns}
      />
    </DocLayout>
  );
}
