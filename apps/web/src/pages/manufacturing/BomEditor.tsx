import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, InputNumber, Popconfirm, Space, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  bomsControllerActivate,
  bomsControllerCreate,
  bomsControllerDeleteDraft,
  bomsControllerRequirements,
  bomsControllerUpdate,
  type BomDetailDto,
  type BomRequirementLineDto,
  type BomRequirementsDto,
} from '@erp/api-client';
import { DocField, DocFields, DocLayout, useDocShortcuts } from '../../components/DocLayout';
import { apiErrorText } from '../../components/ExportButtons';
import { PrintPdfButton } from '../../components/PrintPdfButton';
import { UnitCell } from '../../components/UnitCell';
import { formatQty } from '../../format/number';
import { idemHeaders } from '../../idempotency';
import { codeAndName } from '../../i18n/displayName';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import {
  bomCreateBody,
  bomFormFromDetail,
  bomProblems,
  bomUpdateBody,
  isPositiveQty,
  type BomForm,
  type BomLineForm,
  type BomProblem,
} from './bomPayload';
import { bomKeys, invalidateManufacturing, useItemDetail } from './manufacturingQueries';
import { ItemUnitSelect } from './ItemUnitSelect';
import { ComponentItemPicker, OwnerItemPicker } from './pickers';

/** How long the requirements preview waits after the last key stroke. */
const PREVIEW_DEBOUNCE_MS = 300;

/**
 * The editor of a DRAFT version, or of a new one (ADR-031 §5). A draft is saved
 * as a whole; activating it saves first, then activates, so the active version
 * is the one on screen. The requirements preview reads the saved draft.
 */
export function BomEditor({
  bom,
  initialItemId,
  onBack,
  onSaved,
  onDeleted,
}: {
  /** The saved DRAFT being edited; undefined for a new version. */
  bom?: BomDetailDto;
  /** A new version opened for this manufactured item (from the item page). */
  initialItemId?: string;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const keySeq = useRef(0);
  const nextKey = () => {
    keySeq.current += 1;
    return keySeq.current;
  };
  const [form, setForm] = useState<BomForm>(() =>
    bom
      ? bomFormFromDetail(bom, nextKey)
      : { itemId: initialItemId, outputQty: '1', appliedCostPerUnit: '0', note: '', lines: [{ key: nextKey() }] },
  );
  const [tried, setTried] = useState(false);
  const [previewQty, setPreviewQty] = useState<string>(bom?.outputQty ?? '1');
  const settledPreview = useDebouncedValue(previewQty, PREVIEW_DEBOUNCE_MS);

  const item = useItemDetail(form.itemId);
  // The owner's kind decides the component picker: a recipe may take recipes (ADR-032 §6).
  const ownerKind = item.data?.itemKind;
  const itemOption = form.itemId && item.data ? { value: form.itemId, label: codeAndName(item.data) } : undefined;

  const update = (patch: Partial<BomForm>) => setForm((f) => ({ ...f, ...patch }));
  const setLine = (key: number, patch: Partial<BomLineForm>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key: number) =>
    setForm((f) => ({ ...f, lines: f.lines.length > 1 ? f.lines.filter((l) => l.key !== key) : [{ key: nextKey() }] }));
  const addLine = () => setForm((f) => ({ ...f, lines: [...f.lines, { key: nextKey() }] }));

  const problems = bomProblems(form);
  const problemOf = (p: BomProblem) => tried && problems.includes(p);
  const requiredError = (p: BomProblem) => (problemOf(p) ? t('common.requiredField') : undefined);

  const persist = async (): Promise<string> => {
    if (bom) {
      await bomsControllerUpdate(bom.id, bomUpdateBody(form));
      return bom.id;
    }
    const res = await bomsControllerCreate(bomCreateBody(form));
    return res.data.id;
  };
  const onError = (err: unknown) => apiMessage.error(apiErrorText(t, err));
  const done = (id: string) => {
    void invalidateManufacturing(queryClient);
    onSaved(id);
  };

  const save = useMutation({
    mutationFn: persist,
    onSuccess: (id) => {
      apiMessage.success(t('manufacturing.bom.saved'));
      done(id);
    },
    onError,
  });
  const activate = useMutation({
    mutationFn: async () => {
      const id = await persist();
      await bomsControllerActivate(id, { headers: idemHeaders() });
      return id;
    },
    onSuccess: (id) => {
      apiMessage.success(t('manufacturing.bom.activated'));
      done(id);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => bomsControllerDeleteDraft(bom!.id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      void invalidateManufacturing(queryClient);
      onDeleted();
    },
    onError,
  });
  const busy = save.isPending || activate.isPending || remove.isPending;

  /** True when the form may be sent; otherwise marks what is missing. */
  const checkForm = (): boolean => {
    if (busy) return false;
    if (problems.length > 0) {
      setTried(true);
      apiMessage.warning(t('manufacturing.bom.problemsHint'));
      return false;
    }
    return true;
  };
  const saveDraft = () => {
    if (checkForm()) save.mutate();
  };
  useDocShortcuts({ onSave: saveDraft });

  const preview = useQuery({
    queryKey: bomKeys.requirements(bom?.id ?? '', settledPreview),
    queryFn: ({ signal }) => bomsControllerRequirements(bom!.id, { qty: settledPreview }, { signal }).then((r) => r.data),
    enabled: !!bom && isPositiveQty(settledPreview),
  });

  const columns: ColumnsType<BomLineForm> = [
    {
      title: '#',
      width: 44,
      render: (_: unknown, _line: BomLineForm, index: number) => index + 1,
    },
    {
      title: t('manufacturing.bom.component'),
      minWidth: 220,
      render: (_: unknown, line: BomLineForm) => (
        <ComponentItemPicker
          ownerKind={ownerKind}
          size="small"
          style={{ width: '100%', minWidth: 180 }}
          selected={line.componentItemId && line.componentLabel ? { value: line.componentItemId, label: line.componentLabel } : undefined}
          status={tried && problemOf('component') && !line.componentItemId ? 'error' : undefined}
          value={line.componentItemId}
          onChange={(v, option) => setLine(line.key, { componentItemId: v, componentLabel: option?.label, itemUnitId: undefined })}
        />
      ),
    },
    {
      title: t('manufacturing.bom.unit'),
      width: 130,
      render: (_: unknown, line: BomLineForm) => (
        <UnitCell
          label={t('manufacturing.bom.unit')}
          itemId={line.componentItemId}
          value={line.itemUnitId}
          onChange={(u) => setLine(line.key, { itemUnitId: u })}
        />
      ),
    },
    {
      title: t('manufacturing.bom.qty'),
      width: 130,
      render: (_: unknown, line: BomLineForm) => (
        <InputNumber<string>
          aria-label={t('manufacturing.bom.qty')}
          stringMode
          size="small"
          min="0"
          step="0.000001"
          style={{ width: '100%' }}
          status={tried && problemOf('qty') && !isPositiveQty(line.qty) && !!line.componentItemId ? 'error' : undefined}
          value={line.qty ?? undefined}
          onChange={(v) => setLine(line.key, { qty: v ?? null })}
        />
      ),
    },
    {
      title: t('manufacturing.bom.waste'),
      width: 110,
      render: (_: unknown, line: BomLineForm) => (
        <InputNumber<string>
          aria-label={t('manufacturing.bom.waste')}
          stringMode
          size="small"
          min="0"
          max="100"
          step="0.5"
          style={{ width: '100%' }}
          value={line.wastePct ?? undefined}
          onChange={(v) => setLine(line.key, { wastePct: v ?? null })}
        />
      ),
    },
    {
      title: t('manufacturing.note'),
      minWidth: 140,
      render: (_: unknown, line: BomLineForm) => (
        <Input
          aria-label={t('manufacturing.note')}
          size="small"
          maxLength={500}
          value={line.note ?? ''}
          onChange={(e) => setLine(line.key, { note: e.target.value })}
        />
      ),
    },
    {
      title: '',
      width: 48,
      render: (_: unknown, line: BomLineForm) => (
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          aria-label={t('manufacturing.removeLine')}
          onClick={() => removeLine(line.key)}
        />
      ),
    },
  ];

  const actions = (
    <>
      {contextHolder}
      <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} disabled={busy} onClick={saveDraft}>
        {bom ? t('common.save') : t('common.saveDraft')}
        <span className="doc-kbd">Ctrl+S</span>
      </Button>
      <Popconfirm
        title={t('manufacturing.bom.activateConfirm')}
        disabled={busy}
        onConfirm={() => {
          if (checkForm()) activate.mutate();
        }}
      >
        <Button disabled={busy} loading={activate.isPending}>
          {t('manufacturing.bom.activate')}
        </Button>
      </Popconfirm>
      {bom && (
        <>
          <PrintPdfButton path={`/boms/${bom.id}/pdf`} />
          <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate()}>
            <Button danger icon={<DeleteOutlined />} aria-label={t('common.delete')} disabled={busy} loading={remove.isPending} />
          </Popconfirm>
        </>
      )}
    </>
  );

  return (
    <DocLayout
      title={bom ? t('manufacturing.bom.editTitle') : t('manufacturing.bom.newTitle')}
      docNo={bom ? `${bom.item.code} · v${bom.versionNo}` : undefined}
      onBack={onBack}
      actions={actions}
    >
      {tried && problems.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('manufacturing.bom.problemsHint')} />}
      <DocFields>
        <DocField field="item" label={t('manufacturing.bom.item')} required error={requiredError('item')}>
          <OwnerItemPicker
            disabled={!!bom}
            selected={itemOption}
            status={problemOf('item') ? 'error' : undefined}
            value={form.itemId}
            onChange={(v) => update({ itemId: v, outputItemUnitId: undefined })}
          />
        </DocField>
        <DocField label={t('manufacturing.bom.outputQty')} required error={requiredError('outputQty')}>
          <InputNumber<string>
            stringMode
            min="0"
            step="1"
            style={{ width: '100%' }}
            status={problemOf('outputQty') ? 'error' : undefined}
            value={form.outputQty ?? undefined}
            onChange={(v) => update({ outputQty: v ?? null })}
          />
          {ownerKind === 'RECIPE' && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
              {t('manufacturing.bom.recipeOutputHelp')}
            </Typography.Text>
          )}
        </DocField>
        <DocField label={t('manufacturing.bom.outputUnit')}>
          <ItemUnitSelect
            label={t('manufacturing.bom.outputUnit')}
            itemId={form.itemId}
            value={form.outputItemUnitId}
            onChange={(u) => update({ outputItemUnitId: u })}
          />
        </DocField>
        <DocField label={t('manufacturing.bom.appliedCost')} error={problemOf('cost') ? t('manufacturing.bom.costInvalid') : undefined} wide>
          <>
            <InputNumber<string>
              stringMode
              min="0"
              step="0.001"
              style={{ width: '100%', maxWidth: 260 }}
              status={problemOf('cost') ? 'error' : undefined}
              value={form.appliedCostPerUnit ?? undefined}
              onChange={(v) => update({ appliedCostPerUnit: v ?? null })}
            />
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
              {t('manufacturing.bom.appliedCostHelp')}
            </Typography.Text>
          </>
        </DocField>
        <DocField label={t('manufacturing.note')} wide>
          <Input maxLength={500} value={form.note ?? ''} onChange={(e) => update({ note: e.target.value })} />
        </DocField>
      </DocFields>

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        {t('manufacturing.bom.lines')}
      </Typography.Title>
      <Table<BomLineForm>
        rowKey="key"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={form.lines}
        columns={columns}
      />
      <Space style={{ marginTop: 8 }} wrap>
        <Button icon={<PlusOutlined />} onClick={addLine}>
          {t('manufacturing.addComponent')}
        </Button>
      </Space>

      <RequirementsPreview
        saved={!!bom}
        qty={previewQty}
        onQty={setPreviewQty}
        outputUnitLabel={bom?.outputItemUnit ? codeAndName(bom.outputItemUnit.unit) : bom ? codeAndName(bom.item.baseUnit) : undefined}
        data={preview.data}
        loading={preview.isFetching}
        failed={preview.isError}
      />
    </DocLayout>
  );
}

/**
 * "Requirements for N units" (ADR-031 §6): the standard quantity of each
 * component in its base unit, from the saved draft through GET boms/:id/requirements.
 */
function RequirementsPreview({
  saved,
  qty,
  onQty,
  outputUnitLabel,
  data,
  loading,
  failed,
}: {
  saved: boolean;
  qty: string;
  onQty: (v: string) => void;
  outputUnitLabel?: string;
  data?: BomRequirementsDto;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const requirementColumns: ColumnsType<BomRequirementLineDto> = [
    { title: t('manufacturing.bom.component'), render: (_: unknown, l: BomRequirementLineDto) => codeAndName(l.componentItem) },
    {
      title: t('manufacturing.bom.requiredBase'),
      align: 'right',
      render: (_: unknown, l: BomRequirementLineDto) => `${formatQty(l.requiredQtyBase)} ${l.componentItem.baseUnit.code}`,
    },
    { title: t('manufacturing.bom.waste'), align: 'right', render: (_: unknown, l: BomRequirementLineDto) => `${l.wastePct}%` },
  ];
  return (
    <div style={{ marginTop: 24 }}>
      <Typography.Title level={5}>{t('manufacturing.bom.preview')}</Typography.Title>
      {!saved ? (
        <Typography.Text type="secondary">{t('manufacturing.bom.previewSaveFirst')}</Typography.Text>
      ) : (
        <>
          <Space wrap align="center" style={{ marginBottom: 8 }}>
            <Typography.Text>{t('manufacturing.bom.previewFor')}</Typography.Text>
            <InputNumber<string>
              aria-label={t('manufacturing.bom.previewFor')}
              stringMode
              min="0"
              step="1"
              value={qty}
              onChange={(v) => onQty(v ?? '')}
            />
            {outputUnitLabel && <Typography.Text>{outputUnitLabel}</Typography.Text>}
          </Space>
          {failed && <Alert type="error" showIcon message={t('common.loadFailed')} />}
          {!failed && data && (
            <Table
              rowKey="lineNo"
              size="small"
              pagination={false}
              loading={loading}
              scroll={{ x: 'max-content' }}
              dataSource={data.lines}
              columns={requirementColumns}
            />
          )}
        </>
      )}
    </div>
  );
}
