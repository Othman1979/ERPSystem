import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckOutlined, DeleteOutlined, FileExcelOutlined, PlusOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import { Button, Card, DatePicker, Descriptions, Input, InputNumber, Popconfirm, Select, Space, Table, Tag, Upload, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  bankReconciliationControllerAddLine,
  bankReconciliationControllerAutoMatch,
  bankReconciliationControllerCandidates,
  bankReconciliationControllerCreate,
  bankReconciliationControllerDetail,
  bankReconciliationControllerImportLines,
  bankReconciliationControllerList,
  bankReconciliationControllerMatch,
  bankReconciliationControllerReconcile,
  bankReconciliationControllerRemove,
  bankReconciliationControllerRemoveLine,
  bankReconciliationControllerReopen,
  bankReconciliationControllerUnmatch,
  treasuryControllerListBankAccounts,
  type BankBookLineDto,
  type BankStatementDetailDto,
  type BankStatementLineDto,
  type BankStatementListItemDto,
} from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { tableLocale } from '../../components/QueryState';
import { amountCell } from '../../format/cells';
import { dec } from '../../format/number';
import { idemHeaders } from '../../idempotency';

const DAY = 'YYYY-MM-DD';

/** Phase 20 (ADR-035): bank statements matched against the bank account's posted ledger lines. */
export function BankReconciliationTab() {
  const { t } = useTranslation();
  const [api, holder] = message.useMessage();
  const qc = useQueryClient();
  const [bankAccountId, setBankAccountId] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const onError = (err: unknown) =>
    api.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));

  const banksQuery = useQuery({
    queryKey: ['treasury-bank-accounts'],
    queryFn: ({ signal }) => treasuryControllerListBankAccounts({ signal }).then((r) => r.data),
  });
  const listQuery = useQuery({
    queryKey: ['bank-statements', bankAccountId],
    queryFn: ({ signal }) => bankReconciliationControllerList(bankAccountId ? { bankAccountId } : undefined, { signal }).then((r) => r.data),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['bank-statements'] });

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {holder}
      <Space wrap>
        <Select
          allowClear
          style={{ minWidth: 240 }}
          placeholder={t('bankRec.bankAccount')}
          value={bankAccountId}
          onChange={setBankAccountId}
          options={(banksQuery.data ?? []).map((b) => ({ value: b.id, label: b.bankName }))}
        />
        {bankAccountId && <NewStatement bankAccountId={bankAccountId} onCreated={(id) => { refresh(); setSelected(id); }} onError={onError} />}
      </Space>
      <Table<BankStatementListItemDto>
        rowKey="id"
        size="small"
        loading={listQuery.isLoading}
        locale={tableLocale(listQuery)}
        dataSource={listQuery.data ?? []}
        pagination={false}
        onRow={(r) => ({ onClick: () => setSelected(r.id), style: { cursor: 'pointer' } })}
        rowClassName={(r) => (r.id === selected ? 'ant-table-row-selected' : '')}
        columns={[
          { title: t('bankRec.bankAccount'), dataIndex: 'bankName' },
          { title: t('bankRec.startDate'), dataIndex: 'startDate', width: 110 },
          { title: t('bankRec.endDate'), dataIndex: 'endDate', width: 110 },
          { title: t('bankRec.openingBalance'), dataIndex: 'openingBalance', align: 'right' as const, render: amountCell },
          { title: t('bankRec.closingBalance'), dataIndex: 'closingBalance', align: 'right' as const, render: amountCell },
          { title: t('bankRec.lines'), dataIndex: 'lineCount', width: 70 },
          {
            title: t('bankRec.status'),
            dataIndex: 'status',
            width: 110,
            render: (s: string) => <Tag color={s === 'RECONCILED' ? 'green' : 'gold'}>{t(`bankRec.status_${s}`)}</Tag>,
          },
        ]}
      />
      {selected && <StatementDetail id={selected} onChanged={refresh} onDeleted={() => { setSelected(undefined); refresh(); }} onError={onError} />}
    </Space>
  );
}

function NewStatement({ bankAccountId, onCreated, onError }: { bankAccountId: string; onCreated: (id: string) => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs().endOf('month')]);
  const [opening, setOpening] = useState<string | null>('0');
  const [closing, setClosing] = useState<string | null>('0');
  const create = useMutation({
    mutationFn: () =>
      bankReconciliationControllerCreate({
        bankAccountId,
        startDate: range[0].format(DAY),
        endDate: range[1].format(DAY),
        openingBalance: opening ?? '0',
        closingBalance: closing ?? '0',
      }),
    onSuccess: (r) => onCreated(r.data.id),
    onError,
  });
  return (
    <Space wrap>
      <DatePicker.RangePicker value={range} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
      <InputNumber<string> stringMode addonBefore={t('bankRec.openingBalance')} value={opening} onChange={setOpening} />
      <InputNumber<string> stringMode addonBefore={t('bankRec.closingBalance')} value={closing} onChange={setClosing} />
      <Button type="primary" icon={<PlusOutlined />} loading={create.isPending} onClick={() => create.mutate()}>
        {t('bankRec.newStatement')}
      </Button>
    </Space>
  );
}

function StatementDetail({
  id,
  onChanged,
  onDeleted,
  onError,
}: {
  id: string;
  onChanged: () => void;
  onDeleted: () => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [api, holder] = message.useMessage();
  const [matchLine, setMatchLine] = useState<BankStatementLineDto>();
  const [picked, setPicked] = useState<string[]>([]);
  const detailQuery = useQuery({
    queryKey: ['bank-statements', 'detail', id],
    queryFn: ({ signal }) => bankReconciliationControllerDetail(id, { signal }).then((r) => r.data),
  });
  const candidatesQuery = useQuery({
    queryKey: ['bank-statements', 'candidates', id],
    queryFn: ({ signal }) => bankReconciliationControllerCandidates(id, { signal }).then((r) => r.data),
    enabled: !!matchLine,
  });
  const done = (data?: BankStatementDetailDto) => {
    if (data) qc.setQueryData(['bank-statements', 'detail', id], data);
    void qc.invalidateQueries({ queryKey: ['bank-statements'] });
    onChanged();
  };

  const [line, setLine] = useState<{ date: Dayjs; description: string; reference: string; deposit: string | null; withdrawal: string | null }>({
    date: dayjs(),
    description: '',
    reference: '',
    deposit: null,
    withdrawal: null,
  });
  const addLine = useMutation({
    mutationFn: () =>
      bankReconciliationControllerAddLine(id, {
        lineDate: line.date.format(DAY),
        description: line.description || undefined,
        reference: line.reference || undefined,
        deposit: line.deposit || undefined,
        withdrawal: line.withdrawal || undefined,
      }),
    onSuccess: (r) => {
      setLine({ ...line, description: '', reference: '', deposit: null, withdrawal: null });
      done(r.data);
    },
    onError,
  });
  const removeLine = useMutation({ mutationFn: (lineId: string) => bankReconciliationControllerRemoveLine(id, lineId), onSuccess: (r) => done(r.data), onError });
  const unmatch = useMutation({ mutationFn: (lineId: string) => bankReconciliationControllerUnmatch(id, lineId), onSuccess: (r) => done(r.data), onError });
  const match = useMutation({
    mutationFn: () => bankReconciliationControllerMatch(id, { statementLineId: matchLine!.id, journalLineIds: picked }),
    onSuccess: (r) => {
      setMatchLine(undefined);
      setPicked([]);
      done(r.data);
    },
    onError,
  });
  const autoMatch = useMutation({
    mutationFn: () => bankReconciliationControllerAutoMatch(id),
    onSuccess: (r) => {
      api.info(t('bankRec.autoMatched', { count: r.data.matched }));
      done(r.data.statement);
    },
    onError,
  });
  const reconcile = useMutation({
    mutationFn: () => bankReconciliationControllerReconcile(id, { headers: idemHeaders() }),
    onSuccess: (r) => done(r.data),
    onError,
  });
  const reopen = useMutation({
    mutationFn: () => bankReconciliationControllerReopen(id, { headers: idemHeaders() }),
    onSuccess: (r) => done(r.data),
    onError,
  });
  const remove = useMutation({ mutationFn: () => bankReconciliationControllerRemove(id), onSuccess: onDeleted, onError });
  const importSheet = useMutation({
    mutationFn: (file: File) => bankReconciliationControllerImportLines(id, { file }),
    onSuccess: (r) => done(r.data),
    onError,
  });

  const data = detailQuery.data;
  if (!data) return null;
  const draft = data.status === 'DRAFT';
  const s = data.summary;
  const bookColumns = [
    { title: t('bankRec.date'), dataIndex: 'entryDate', width: 110 },
    { title: t('bankRec.entryNo'), dataIndex: 'entryNo', width: 120 },
    { title: t('bankRec.reference'), dataIndex: 'reference', width: 120 },
    { title: t('bankRec.description'), dataIndex: 'description' },
    { title: t('bankRec.amount'), dataIndex: 'amount', align: 'right' as const, width: 130, render: amountCell },
  ];
  const pickedTotal = (candidatesQuery.data ?? [])
    .filter((c) => picked.includes(c.id))
    .reduce((sum, c) => sum.plus(dec(c.amount)), dec(0));
  const lineTotal = matchLine ? dec(matchLine.deposit).minus(dec(matchLine.withdrawal)) : dec(0);

  return (
    <Card size="small" title={`${data.bankName} — ${data.startDate} / ${data.endDate}`}>
      {holder}
      <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered>
        <Descriptions.Item label={t('bankRec.openingBalance')}>{amountCell(data.openingBalance)}</Descriptions.Item>
        <Descriptions.Item label={t('bankRec.closingBalance')}>{amountCell(data.closingBalance)}</Descriptions.Item>
        <Descriptions.Item label={t('bankRec.computedClosing')}>{amountCell(s.computedClosingBalance)}</Descriptions.Item>
        <Descriptions.Item label={t('bankRec.bookBalance')}>{amountCell(s.bookBalance)}</Descriptions.Item>
        <Descriptions.Item label={t('bankRec.outstandingDeposits')}>{amountCell(s.outstandingDeposits)}</Descriptions.Item>
        <Descriptions.Item label={t('bankRec.outstandingPayments')}>{amountCell(s.outstandingPayments)}</Descriptions.Item>
        <Descriptions.Item label={t('bankRec.adjustedBookBalance')}>{amountCell(s.adjustedBookBalance)}</Descriptions.Item>
        <Descriptions.Item label={t('bankRec.difference')}>
          <Tag color={s.difference === '0.000' ? 'green' : 'red'}>{amountCell(s.difference)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('bankRec.unmatchedLines')}>{s.unmatchedLines}</Descriptions.Item>
      </Descriptions>

      <Space wrap style={{ margin: '12px 0' }}>
        {draft ? (
          <>
            <Button icon={<ThunderboltOutlined />} loading={autoMatch.isPending} onClick={() => autoMatch.mutate()}>
              {t('bankRec.autoMatch')}
            </Button>
            <Upload accept=".xlsx" showUploadList={false} beforeUpload={(file) => { importSheet.mutate(file); return false; }}>
              <Button icon={<FileExcelOutlined />} loading={importSheet.isPending}>{t('bankRec.import')}</Button>
            </Upload>
            <Button type="primary" icon={<CheckOutlined />} loading={reconcile.isPending} onClick={() => reconcile.mutate()}>
              {t('bankRec.reconcile')}
            </Button>
            <Popconfirm title={t('bankRec.deleteConfirm')} onConfirm={() => remove.mutate()}>
              <Button danger icon={<DeleteOutlined />}>{t('bankRec.delete')}</Button>
            </Popconfirm>
          </>
        ) : (
          <Popconfirm title={t('bankRec.reopenConfirm')} onConfirm={() => reopen.mutate()}>
            <Button icon={<UndoOutlined />} loading={reopen.isPending}>{t('bankRec.reopen')}</Button>
          </Popconfirm>
        )}
        <ExportButtons path={`/bank-statements/${id}/report`} />
      </Space>

      {draft && (
        <Space wrap style={{ marginBottom: 12 }}>
          <DatePicker value={line.date} onChange={(d) => d && setLine({ ...line, date: d })} />
          <Input placeholder={t('bankRec.description')} value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} />
          <Input placeholder={t('bankRec.reference')} style={{ width: 140 }} value={line.reference} onChange={(e) => setLine({ ...line, reference: e.target.value })} />
          <InputNumber<string> stringMode min="0" placeholder={t('bankRec.deposit')} value={line.deposit} onChange={(v) => setLine({ ...line, deposit: v, withdrawal: null })} />
          <InputNumber<string> stringMode min="0" placeholder={t('bankRec.withdrawal')} value={line.withdrawal} onChange={(v) => setLine({ ...line, withdrawal: v, deposit: null })} />
          <Button icon={<PlusOutlined />} loading={addLine.isPending} onClick={() => addLine.mutate()}>{t('bankRec.addLine')}</Button>
        </Space>
      )}

      <Table<BankStatementLineDto>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={data.lines}
        expandable={{
          rowExpandable: (r) => r.matches.length > 0,
          expandedRowRender: (r) => <Table<BankBookLineDto> rowKey="id" size="small" pagination={false} dataSource={r.matches} columns={bookColumns} />,
        }}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          { title: t('bankRec.date'), dataIndex: 'lineDate', width: 110 },
          { title: t('bankRec.description'), dataIndex: 'description' },
          { title: t('bankRec.reference'), dataIndex: 'reference', width: 120 },
          { title: t('bankRec.deposit'), dataIndex: 'deposit', align: 'right' as const, width: 120, render: amountCell },
          { title: t('bankRec.withdrawal'), dataIndex: 'withdrawal', align: 'right' as const, width: 120, render: amountCell },
          {
            title: t('bankRec.status'),
            width: 100,
            render: (_: unknown, r) => <Tag color={r.matched ? 'green' : 'default'}>{t(r.matched ? 'bankRec.matched' : 'bankRec.unmatched')}</Tag>,
          },
          {
            title: '',
            width: 200,
            render: (_: unknown, r) =>
              draft && (
                <Space size="small">
                  {r.matched ? (
                    <Button size="small" onClick={() => unmatch.mutate(r.id)}>{t('bankRec.unmatch')}</Button>
                  ) : (
                    <Button size="small" type={matchLine?.id === r.id ? 'primary' : 'default'} onClick={() => { setMatchLine(r); setPicked([]); }}>
                      {t('bankRec.match')}
                    </Button>
                  )}
                  <Popconfirm title={t('bankRec.deleteLineConfirm')} onConfirm={() => removeLine.mutate(r.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />

      {draft && matchLine && (
        <Card size="small" style={{ marginTop: 12 }} title={t('bankRec.matchTitle', { lineNo: matchLine.lineNo })}>
          <Table<BankBookLineDto>
            rowKey="id"
            size="small"
            pagination={false}
            loading={candidatesQuery.isLoading}
            locale={tableLocale(candidatesQuery)}
            dataSource={candidatesQuery.data ?? []}
            rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setPicked(keys.map(String)) }}
            columns={bookColumns}
          />
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" disabled={picked.length === 0 || !pickedTotal.equals(lineTotal)} loading={match.isPending} onClick={() => match.mutate()}>
              {t('bankRec.confirmMatch')}
            </Button>
            <Button onClick={() => setMatchLine(undefined)}>{t('common.cancel')}</Button>
          </Space>
        </Card>
      )}

      {(data.outstandingDeposits.length > 0 || data.outstandingPayments.length > 0) && (
        <Table<BankBookLineDto>
          style={{ marginTop: 12 }}
          title={() => t('bankRec.outstandingItems')}
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={[...data.outstandingDeposits, ...data.outstandingPayments]}
          columns={bookColumns}
        />
      )}
    </Card>
  );
}
