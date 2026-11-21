import { EyeInvisibleOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Popconfirm, Select, Space, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  stockDocumentsControllerDeleteCount,
  stockDocumentsControllerListCounts,
  type StockCountListItemDto,
  type StockDocumentsControllerListCountsSort,
} from '@erp/api-client';
import { ListToolbar } from '../../components/ListToolbar';
import { tableLocale } from '../../components/QueryState';
import { usePagedQuery } from '../../hooks/usePagedQuery';
import { codeAndName } from '../../i18n/displayName';
import { palette } from '../../theme';
import { CountDocument } from './CountDocument';
import { CountNewDialog } from './CountNewDialog';
import { useApiMessage } from './stockHooks';

type CountRow = StockCountListItemDto;

/** Status tag of a count: draft (neutral), submitted (info), posted (success). */
export function CountStatusTag({ status }: { status: string }) {
  const { t } = useTranslation();
  if (status === 'POSTED') return <Tag color="green">{t('stock.posted')}</Tag>;
  if (status === 'SUBMITTED') {
    return (
      <Tag style={{ background: palette.infoBg, color: palette.info, borderColor: palette.infoBorder }}>
        {t('stockCount.statusSubmitted')}
      </Tag>
    );
  }
  return <Tag>{t('stock.draft')}</Tag>;
}

/** The counts list (ADR-030 §5): status filter, blind and scope tags, and the sheet of the chosen count. */
export function CountsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show, ok } = useApiMessage();
  const [newOpen, setNewOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | undefined>();

  // Server-paged (ADR-022): search, sort and page go to the API.
  const list = usePagedQuery<CountRow, Record<string, string | undefined>, StockDocumentsControllerListCountsSort>({
    key: ['stock-counts', 'list'],
    filters: { status },
    defaultSort: '-date',
    fetch: (params, signal) =>
      stockDocumentsControllerListCounts(
        { ...params, status: params.status as StockCountListItemDto['status'] | undefined },
        { signal },
      ).then((r) => r.data),
    enabled: openId === null,
  });
  const listQuery = list.query;
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['stock-counts'] });

  const del = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerDeleteCount(id),
    onSuccess: invalidate,
    onError: show,
  });

  if (openId !== null) {
    return <CountDocument id={openId} onBack={() => setOpenId(null)} />;
  }

  return (
    <>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        count={list.total}
        filters={
          <Select
            allowClear
            placeholder={t('common.status')}
            aria-label={t('common.status')}
            value={status}
            onChange={setStatus}
            style={{ minWidth: 160 }}
            options={[
              { value: 'DRAFT', label: t('stock.draft') },
              { value: 'SUBMITTED', label: t('stockCount.statusSubmitted') },
              { value: 'POSTED', label: t('stock.posted') },
            ]}
          />
        }
        actions={
          <Button type="primary" onClick={() => setNewOpen(true)}>
            {t('stock.newCount')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={listQuery.isLoading}
        dataSource={list.rows}
        locale={tableLocale(listQuery)}
        pagination={list.pagination}
        onChange={list.onTableChange}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('stock.docNo'),
            dataIndex: 'docNo',
            key: 'docNo',
            sorter: true,
            sortOrder: list.sortOrderOf('docNo'),
            width: 150,
            className: 'nowrap',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: t('stock.date'),
            dataIndex: 'countDate',
            key: 'date',
            sorter: true,
            sortOrder: list.sortOrderOf('date'),
            width: 110,
            render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
          },
          {
            title: t('stock.warehouse'),
            width: 170,
            render: (_: unknown, r: CountRow) => codeAndName(r.warehouse),
          },
          {
            title: t('stockCount.scopeLabel'),
            width: 200,
            render: (_: unknown, r: CountRow) => (
              <Space size={4} wrap>
                <Tag>{t(`stockCount.scope.${r.scope}`)}</Tag>
                {r.blind && (
                  <Tag icon={<EyeInvisibleOutlined />} style={{ background: palette.infoBg, color: palette.info, borderColor: palette.infoBorder }}>
                    {t('stockCount.blindTag')}
                  </Tag>
                )}
              </Space>
            ),
          },
          { title: t('stock.lines'), width: 80, align: 'right' as const, render: (_: unknown, r: CountRow) => r._count?.lines ?? '—' },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 120,
            render: (v: string) => <CountStatusTag status={v} />,
          },
          {
            title: t('common.actions'), key: 'actions',
            width: 200,
            render: (_: unknown, row: CountRow) => (
              <Space>
                <Button size="small" onClick={() => setOpenId(row.id)}>
                  {t('stock.countLines')}
                </Button>
                {row.status === 'DRAFT' && (
                  <Popconfirm title={t('common.confirmDelete')} onConfirm={() => del.mutate(row.id)}>
                    <Button size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <CountNewDialog
        open={newOpen}
        show={show}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => {
          setNewOpen(false);
          ok('common.saved');
          setOpenId(id);
        }}
      />
    </>
  );
}
