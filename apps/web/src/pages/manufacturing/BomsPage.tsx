import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Popconfirm, Select, Space, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import {
  bomsControllerActivate,
  bomsControllerCopy,
  bomsControllerDeactivate,
  bomsControllerGet,
  bomsControllerList,
  type BomDetailDto,
  type BomListItemDto,
  type BomLineDetailDto,
  type BomsControllerListStatus,
  type BomStatus,
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
import { formatAmount, formatQty } from '../../format/number';
import { idemHeaders } from '../../idempotency';
import { codeAndName } from '../../i18n/displayName';
import { usePagedQuery } from '../../hooks/usePagedQuery';
import { useNewFromUrl } from '../../useNewFromUrl';
import { BomEditor } from './BomEditor';
import { bomKeys, invalidateManufacturing } from './manufacturingQueries';
import { ManufacturedItemPicker } from './pickers';

/** What the page shows: the list, a new version (optionally for an item), or one saved version. */
type Screen = { kind: 'list' } | { kind: 'new'; itemId?: string } | { kind: 'bom'; id: string };

const STATUSES: BomStatus[] = ['DRAFT', 'ACTIVE', 'INACTIVE'];

const STATUS_TONE: Record<BomStatus, StatusTone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  INACTIVE: 'neutral',
};

/** A version's status as a tag; colour is not the only signal, the words say it too. */
export function BomStatusTag({ status }: { status: BomStatus }) {
  const { t } = useTranslation();
  return <StatusTag tone={STATUS_TONE[status]}>{t(`manufacturing.status.${status}`)}</StatusTag>;
}

/**
 * Bill of materials (ADR-031 §5): the versions of the manufactured items. A
 * draft is edited, an active or inactive version is read; the list links both.
 */
export function BomsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // The item page links a version here with ?bomId=...: that version opens. The address is cleaned up below.
  const linkedId = params.get('bomId');
  const [screen, setScreen] = useState<Screen>(() => (linkedId ? { kind: 'bom', id: linkedId } : { kind: 'list' }));
  useEffect(() => {
    if (!linkedId) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('bomId');
        return next;
      },
      { replace: true },
    );
  }, [linkedId, setParams]);
  useNewFromUrl(() => setScreen({ kind: 'new', itemId: params.get('itemId') ?? undefined }));

  return (
    <div>
      <PageHeader title={t('nav.boms')} />
      {screen.kind === 'list' ? (
        <BomsList onOpen={(id) => setScreen({ kind: 'bom', id })} onNew={() => setScreen({ kind: 'new' })} />
      ) : (
        <BomScreen
          key={screen.kind === 'bom' ? `bom-${screen.id}` : 'new'}
          id={screen.kind === 'bom' ? screen.id : undefined}
          itemId={screen.kind === 'new' ? screen.itemId : undefined}
          onBack={() => setScreen({ kind: 'list' })}
          onOpen={(id) => setScreen({ kind: 'bom', id })}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ list

function BomsList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<BomStatus | undefined>(undefined);

  // Server-paged (ADR-022): search, filters and page go to the API.
  const list = usePagedQuery<BomListItemDto, { itemId?: string; status?: BomsControllerListStatus }>({
    key: bomKeys.list(),
    filters: { itemId, status },
    fetch: (params, signal) => bomsControllerList(params, { signal }).then((r) => r.data),
  });

  const columns: ColumnsType<BomListItemDto> = [
    {
      title: t('manufacturing.bom.item'),
      dataIndex: 'item',
      minWidth: 180,
      render: (_: unknown, r: BomListItemDto) => codeAndName(r.item),
    },
    {
      title: t('manufacturing.bom.version'),
      dataIndex: 'versionNo',
      width: 90,
      render: (v: number) => `v${v}`,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 130,
      render: (v: BomStatus) => <BomStatusTag status={v} />,
    },
    {
      title: t('manufacturing.bom.output'),
      dataIndex: 'outputQty',
      width: 170,
      render: (_: unknown, r: BomListItemDto) =>
        `${formatQty(r.outputQty)} ${codeAndName(r.outputItemUnit?.unit ?? r.item.baseUnit)}`,
    },
    {
      title: t('manufacturing.bom.appliedCost'),
      dataIndex: 'appliedCostPerUnit',
      width: 150,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('manufacturing.bom.lineCount'),
      dataIndex: 'lineCount',
      width: 110,
      align: 'right' as const,
    },
  ];

  return (
    <div>
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        searchPlaceholder={t('manufacturing.bom.searchPlaceholder')}
        filters={
          <Space wrap>
            <ManufacturedItemPicker
              allowClear
              style={{ minWidth: 220 }}
              placeholder={t('manufacturing.bom.item')}
              value={itemId}
              onChange={(v) => setItemId(v)}
            />
            <Select
              allowClear
              style={{ minWidth: 150 }}
              placeholder={t('common.status')}
              value={status}
              onChange={setStatus}
              options={STATUSES.map((s) => ({ value: s, label: t(`manufacturing.status.${s}`) }))}
            />
          </Space>
        }
        count={list.total}
        actions={
          can(PERMISSIONS.ITEM_MANAGE) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={onNew}>
              {t('manufacturing.bom.new')}
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

/** Loads a saved version: a draft (or a new one) opens in the editor, anything else in the read-only view. */
function BomScreen({
  id,
  itemId,
  onBack,
  onOpen,
}: {
  id?: string;
  itemId?: string;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.ITEM_MANAGE);
  const detail = useQuery({
    queryKey: bomKeys.detail(id),
    queryFn: ({ signal }) => bomsControllerGet(id!, { signal }).then((r) => r.data),
    enabled: !!id,
  });

  if (id && detail.isError) return <Alert type="error" showIcon message={t('common.loadFailed')} />;
  if (id && detail.isPending) return <Typography.Text>{t('common.loading')}</Typography.Text>;
  if (!id && !canManage) return <NoAccess />;

  const bom = detail.data;
  if (bom && (bom.status !== 'DRAFT' || !canManage)) {
    return <BomView bom={bom} onBack={onBack} onOpen={onOpen} />;
  }
  return <BomEditor bom={bom} initialItemId={itemId} onBack={onBack} onSaved={onOpen} onDeleted={onBack} />;
}

// ------------------------------------------------------------------ view

/**
 * A version that is not a draft: read-only, with activation, deactivation,
 * a copy into a new draft (the only way to change it, ADR-031 §5) and the printout.
 */
function BomView({ bom, onBack, onOpen }: { bom: BomDetailDto; onBack: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const canManage = can(PERMISSIONS.ITEM_MANAGE);
  const onError = (err: unknown) => apiMessage.error(apiErrorText(t, err));

  const activate = useMutation({
    mutationFn: () => bomsControllerActivate(bom.id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('manufacturing.bom.activated'));
      void invalidateManufacturing(queryClient);
    },
    onError,
  });
  const deactivate = useMutation({
    mutationFn: () => bomsControllerDeactivate(bom.id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('manufacturing.bom.deactivated'));
      void invalidateManufacturing(queryClient);
    },
    onError,
  });
  const copy = useMutation({
    mutationFn: () => bomsControllerCopy(bom.id),
    onSuccess: (res) => {
      apiMessage.success(t('manufacturing.bom.copied'));
      void invalidateManufacturing(queryClient);
      onOpen(res.data.id);
    },
    onError,
  });
  const busy = activate.isPending || deactivate.isPending || copy.isPending;

  const columns: ColumnsType<BomLineDetailDto> = [
    { title: '#', width: 44, render: (_: unknown, _l: BomLineDetailDto, index: number) => index + 1 },
    { title: t('manufacturing.bom.component'), render: (_: unknown, l: BomLineDetailDto) => codeAndName(l.componentItem) },
    {
      title: t('manufacturing.bom.unit'),
      width: 110,
      render: (_: unknown, l: BomLineDetailDto) => codeAndName(l.itemUnit?.unit ?? l.componentItem.baseUnit),
    },
    { title: t('manufacturing.bom.qty'), align: 'right', width: 130, render: (_: unknown, l: BomLineDetailDto) => formatQty(l.qty) },
    { title: t('manufacturing.bom.waste'), align: 'right', width: 100, render: (_: unknown, l: BomLineDetailDto) => `${l.wastePct}%` },
    {
      title: t('manufacturing.bom.baseQty'),
      align: 'right',
      width: 130,
      render: (_: unknown, l: BomLineDetailDto) => formatQty(l.qtyBase),
    },
    { title: t('manufacturing.note'), render: (_: unknown, l: BomLineDetailDto) => l.note ?? '' },
  ];

  return (
    <DocLayout
      title={t('manufacturing.bom.viewTitle')}
      docNo={`${bom.item.code} · v${bom.versionNo}`}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <BomStatusTag status={bom.status} />
          {canManage && bom.status === 'INACTIVE' && (
            <Popconfirm title={t('manufacturing.bom.activateConfirm')} onConfirm={() => activate.mutate()}>
              <Button type="primary" disabled={busy} loading={activate.isPending}>
                {t('manufacturing.bom.activate')}
              </Button>
            </Popconfirm>
          )}
          {canManage && bom.status === 'ACTIVE' && (
            <Popconfirm title={t('manufacturing.bom.deactivateConfirm')} okButtonProps={{ danger: true }} onConfirm={() => deactivate.mutate()}>
              <Button danger disabled={busy} loading={deactivate.isPending}>
                {t('manufacturing.bom.deactivate')}
              </Button>
            </Popconfirm>
          )}
          {canManage && (
            <Button disabled={busy} loading={copy.isPending} onClick={() => copy.mutate()}>
              {t('manufacturing.bom.copy')}
            </Button>
          )}
          <PrintPdfButton path={`/boms/${bom.id}/pdf`} />
        </>
      }
    >
      {bom.status === 'INACTIVE' && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('manufacturing.bom.inactiveBanner')} />
      )}
      <DocFields>
        <DocField label={t('manufacturing.bom.item')}>
          <DocValue>{codeAndName(bom.item)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.bom.version')}>
          <DocValue>{`v${bom.versionNo}`}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.bom.output')}>
          <DocValue>
            {`${formatQty(bom.outputQty)} ${codeAndName(bom.outputItemUnit?.unit ?? bom.item.baseUnit)}`}
          </DocValue>
        </DocField>
        <DocField label={t('manufacturing.bom.outputBase')}>
          <DocValue>{formatQty(bom.outputQtyBase)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.bom.appliedCost')}>
          <DocValue>{formatAmount(bom.appliedCostPerUnit)}</DocValue>
        </DocField>
        <DocField label={t('manufacturing.bom.activatedAt')}>
          <DocValue>{bom.activatedAt ? dayjs(bom.activatedAt).format('YYYY-MM-DD') : '—'}</DocValue>
        </DocField>
        {bom.note && (
          <DocField label={t('manufacturing.note')} wide>
            <DocValue>{bom.note}</DocValue>
          </DocField>
        )}
      </DocFields>
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        {t('manufacturing.bom.lines')}
      </Typography.Title>
      <Table<BomLineDetailDto>
        rowKey="id"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={bom.lines}
        columns={columns}
      />
    </DocLayout>
  );
}
