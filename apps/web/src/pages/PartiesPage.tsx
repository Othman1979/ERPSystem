import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Popconfirm,
  Select,
  Space,
  Tag,
  message,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  partiesControllerDeactivate,
  partiesControllerList,
  type PartiesControllerListPartyType,
  type PartiesControllerListSort,
  type PartyDto,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { tableLocale } from '../components/QueryState';
import { ListToolbar } from '../components/ListToolbar';
import { PartyFormDialog } from '../components/PartyFormDialog';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { displayName, type Named } from '../i18n/displayName';
import { amountCell } from '../format/cells';

type Party = PartyDto;

/** The party form's values (antd gives them untyped). Code is set on create only. */
const TYPE_COLORS: Record<string, string> = {
  CUSTOMER: 'blue',
  SUPPLIER: 'orange',
  BOTH: 'green',
};

export function PartiesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<PartiesControllerListPartyType | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();

  // Server-paged (ADR-022): search, sort and page go to the API.
  const list = usePagedQuery<Party, { partyType?: PartiesControllerListPartyType }, PartiesControllerListSort>({
    key: ['parties', 'list'],
    filters: { partyType: typeFilter },
    defaultSort: 'code',
    fetch: (params, signal) => partiesControllerList(params, { signal }).then((r) => r.data),
  });
  const partiesQuery = list.query;
  const { isLoading } = partiesQuery;

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['parties'] });
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (p: Party) => {
    setEditing(p);
    setModalOpen(true);
  };

  const deactivate = useMutation({
    mutationFn: (id: string) => partiesControllerDeactivate(id),
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      invalidate();
    },
    onError,
  });

  const actions = (party: Party) => (
    <Space>
      <Button size="small" onClick={() => openEdit(party)}>{t('common.edit')}</Button>
      {party.isActive && (
        <Popconfirm
          title={t('parties.deactivateConfirm')}
          onConfirm={() => deactivate.mutate(party.id)}
        >
          <Button size="small" danger>{t('common.deactivate')}</Button>
        </Popconfirm>
      )}
    </Space>
  );

  const columns = [
    {
      title: t('parties.code'),
      dataIndex: 'code',
      key: 'code',
      sorter: true,
      sortOrder: list.sortOrderOf('code'),
      width: 110,
    },
    {
      title: t('common.name'),
      key: 'nameAr',
      sorter: true,
      sortOrder: list.sortOrderOf('nameAr'),
      render: (_: unknown, r: Named) => displayName(r),
    },
    {
      title: t('parties.type'),
      dataIndex: 'partyType',
      width: 120,
      render: (v: string) => <Tag color={TYPE_COLORS[v]}>{t(`parties.type_${v}`)}</Tag>,
    },
    { title: t('parties.taxNumber'), dataIndex: 'taxNumber', width: 140, render: (v?: string | null) => v ?? '—' },
    { title: t('parties.phone'), dataIndex: 'phone', width: 130, render: (v?: string | null) => v ?? '—' },
    {
      title: t('parties.creditLimit'),
      dataIndex: 'creditLimit',
      width: 120,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('common.status'),
      dataIndex: 'isActive',
      width: 100,
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? t('common.active') : t('common.inactive')}</Tag>,
    },
    {
      title: '',
      width: 170,
      render: (_: unknown, p: Party) => actions(p),
    },
  ];

  return (
    <div>
      {contextHolder}
      <PageHeader title={t('nav.parties')} />
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        filters={
          <Select
            allowClear
            placeholder={t('parties.type')}
            value={typeFilter}
            onChange={setTypeFilter}
            options={[
              { value: 'CUSTOMER', label: t('parties.type_CUSTOMER') },
              { value: 'SUPPLIER', label: t('parties.type_SUPPLIER') },
              { value: 'BOTH', label: t('parties.type_BOTH') },
            ]}
          />
        }
        count={list.total}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('parties.new')}
          </Button>
        }
      />

      <ResponsiveTable<Party>
        rowKey="id"
        loading={isLoading}
        dataSource={list.rows}
        locale={tableLocale(partiesQuery)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
        mobileCard={{
          title: (party) => displayName(party),
          subtitle: (party) => `${t('parties.code')}: ${party.code}`,
          amount: (party) => amountCell(party.creditLimit),
          status: (party) => (
            <Tag color={party.isActive ? 'green' : 'default'}>
              {party.isActive ? t('common.active') : t('common.inactive')}
            </Tag>
          ),
          meta: (party) => [
            <span>{t('parties.type')}: {t(`parties.type_${party.partyType}`)}</span>,
            ...(party.phone ? [<span>{t('parties.phone')}: {party.phone}</span>] : []),
            ...(party.taxNumber ? [<span>{t('parties.taxNumber')}: {party.taxNumber}</span>] : []),
          ],
          actions,
        }}
      />

      <PartyFormDialog
        open={modalOpen}
        editing={editing}
        enableSaveAndNew
        onCancel={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          setEditing(null);
        }}
      />
    </div>
  );
}
