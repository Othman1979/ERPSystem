import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Modal, Popconfirm, Space, Spin, Tag, Tooltip } from 'antd';
import { formatDate } from '../../format/date';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  stockDocumentsControllerApproveCount,
  stockDocumentsControllerCountVariance,
  stockDocumentsControllerDeleteCount,
  stockDocumentsControllerGetCount,
  stockDocumentsControllerRefreshCount,
  stockDocumentsControllerReopenCount,
  stockDocumentsControllerSubmitCount,
  type StockCountDetailDto,
} from '@erp/api-client';
import { useAuth } from '../../auth/AuthContext';
import { DocField, DocFields, DocLayout, DocValue } from '../../components/DocLayout';
import { apiErrorText } from '../../components/ExportButtons';
import { idemHeaders } from '../../idempotency';
import { codeAndName } from '../../i18n/displayName';
import { invalidateStock } from '../../stockQueries';
import { approveBlock, countDetailKey } from './countPayload';
import { CountDraftSheet } from './CountDraftSheet';
import { CountReadonlySheet } from './CountReadonlySheet';
import { CountVariancePanel } from './CountVariancePanel';
import { useApiMessage } from './stockHooks';

const STAGES = ['DRAFT', 'SUBMITTED', 'POSTED'] as const;

/**
 * One count as a document (ADR-030): the counting sheet while it is a draft,
 * then the read-only sheet with the difference report. Submit, reopen,
 * approve and delete are here; the API checks each one again.
 */
export function CountDocument({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show, ok } = useApiMessage();
  const { me } = useAuth();
  const userId = me?.user.id;
  const isOwner = me?.currentMembership?.roleCode === 'OWNER';
  const [submitOpen, setSubmitOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: countDetailKey(id),
    queryFn: ({ signal }) => stockDocumentsControllerGetCount(id, { signal }).then((r) => r.data),
  });
  const detail = detailQuery.data;
  const status = detail?.status;

  const varianceQuery = useQuery({
    queryKey: ['stock-counts', 'variance', id, status],
    queryFn: ({ signal }) => stockDocumentsControllerCountVariance(id, undefined, { signal }).then((r) => r.data),
    enabled: status === 'SUBMITTED' || status === 'POSTED',
  });

  const putDetail = (d: StockCountDetailDto) => queryClient.setQueryData(countDetailKey(id), d);
  const invalidateCounts = () => void queryClient.invalidateQueries({ queryKey: ['stock-counts'] });

  const refresh = useMutation({
    mutationFn: () => stockDocumentsControllerRefreshCount(id),
    onSuccess: (res) => {
      putDetail(res.data);
      ok('stockCount.bookRefreshed');
    },
    onError: show,
  });
  const submit = useMutation({
    mutationFn: () => stockDocumentsControllerSubmitCount(id, { headers: idemHeaders() }),
    onSuccess: (res) => {
      putDetail(res.data);
      setSubmitOpen(false);
      ok('stockCount.submitted');
      invalidateCounts();
    },
    onError: show,
  });
  const reopen = useMutation({
    mutationFn: () => stockDocumentsControllerReopenCount(id, { headers: idemHeaders() }),
    onSuccess: (res) => {
      putDetail(res.data);
      ok('stockCount.reopened');
      invalidateCounts();
    },
    onError: show,
  });
  const approve = useMutation({
    mutationFn: () => stockDocumentsControllerApproveCount(id, { headers: idemHeaders() }),
    onSuccess: (res) => {
      putDetail(res.data);
      ok('stockCount.approved');
      invalidateCounts();
      invalidateStock(queryClient);
    },
    onError: show,
  });
  const remove = useMutation({
    mutationFn: () => stockDocumentsControllerDeleteCount(id),
    onSuccess: () => {
      invalidateCounts();
      onBack();
    },
    onError: show,
  });

  if (!detail) {
    return (
      <>
        {contextHolder}
        <DocLayout title={t('stock.countLines')} onBack={onBack}>
          {detailQuery.isError ? (
            <Alert type="error" showIcon message={apiErrorText(t, detailQuery.error)} />
          ) : (
            <Spin />
          )}
        </DocLayout>
      </>
    );
  }

  // Who may not approve: the creator and anyone who counted a line (ADR-030 §3). The owner always may.
  const block = approveBlock(detail, { userId, isOwner });
  const uncounted = detail.lines.filter((l) => l.countedQty == null).length;

  const actions =
    status === 'DRAFT' ? (
      <Space wrap>
        <Popconfirm
          title={t('stockCount.deleteConfirm')}
          okButtonProps={{ danger: true }}
          onConfirm={() => remove.mutate()}
        >
          <Button danger loading={remove.isPending}>
            {t('stockCount.deleteDraft')}
          </Button>
        </Popconfirm>
        <Button type="primary" onClick={() => setSubmitOpen(true)}>
          {t('stockCount.submit')}
        </Button>
      </Space>
    ) : status === 'SUBMITTED' ? (
      <Space wrap>
        <Popconfirm title={t('stockCount.reopenConfirm')} onConfirm={() => reopen.mutate()}>
          <Button loading={reopen.isPending}>{t('stockCount.reopen')}</Button>
        </Popconfirm>
        <Tooltip
          title={
            block === 'CREATOR'
              ? t('stockCount.approveBlockedCreator')
              : block === 'COUNTER'
                ? t('stockCount.approveBlockedCounter')
                : undefined
          }
        >
          <span>
            <Popconfirm
              title={t('stock.confirmApprove')}
              disabled={block !== null}
              onConfirm={() => approve.mutate()}
            >
              <Button type="primary" disabled={block !== null} loading={approve.isPending}>
                {t('stock.approve')}
              </Button>
            </Popconfirm>
          </span>
        </Tooltip>
      </Space>
    ) : undefined;

  return (
    <>
      {contextHolder}
      <DocLayout
        title={t('stock.countLines')}
        docNo={detail.docNo}
        status={detail.status}
        statusStages={STAGES}
        onBack={onBack}
        actions={actions}
      >
        <DocFields>
          <DocField label={t('stock.date')}>
            <DocValue>{formatDate(detail.countDate)}</DocValue>
          </DocField>
          <DocField label={t('stock.warehouse')}>
            <DocValue>{codeAndName(detail.warehouse)}</DocValue>
          </DocField>
          <DocField label={t('stockCount.scopeLabel')}>
            <DocValue>{t(`stockCount.scope.${detail.scope}`)}</DocValue>
          </DocField>
          <DocField label={t('stockCount.blind')}>
            <DocValue>
              {detail.blind ? (
                <Tag>{t('stockCount.blindOn')}</Tag>
              ) : (
                t('stockCount.blindOff')
              )}
            </DocValue>
          </DocField>
          {detail.description && (
            <DocField label={t('common.description')} wide>
              <DocValue>{detail.description}</DocValue>
            </DocField>
          )}
          {detail.status === 'POSTED' && detail.docNo && (
            <DocField label={t('stockCount.adjustment')} wide>
              <DocValue>
                {detail.docNo} · {t('stockCount.adjustmentNote')}
              </DocValue>
            </DocField>
          )}
        </DocFields>

        {detail.status === 'DRAFT' ? (
          <>
            {detail.blind && (
              <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('stockCount.blindBanner')} />
            )}
            <CountDraftSheet detail={detail} onRefresh={() => refresh.mutate()} refreshing={refresh.isPending} />
          </>
        ) : (
          <>
            <CountVariancePanel
              id={id}
              variance={varianceQuery.data}
              loading={varianceQuery.isLoading}
              failed={varianceQuery.isError}
            />
            <CountReadonlySheet detail={detail} variance={varianceQuery.data} />
          </>
        )}

        <Modal
          open={submitOpen}
          title={t('stockCount.submitConfirm')}
          okText={t('stockCount.submit')}
          cancelText={t('common.cancel')}
          onOk={() => submit.mutate()}
          onCancel={() => setSubmitOpen(false)}
          confirmLoading={submit.isPending}
        >
          <p>{uncounted > 0 ? t('stockCount.submitWarn', { count: uncounted }) : t('stockCount.submitWarnNone')}</p>
          <p>{t('stockCount.submitNote')}</p>
        </Modal>
      </DocLayout>
    </>
  );
}
