import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, DatePicker, Input, InputNumber, Popconfirm, Select, Space, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import Decimal from 'decimal.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  bomsControllerGet,
  bomsControllerList,
  type BomDetailDto,
  productionVouchersControllerCreate,
  productionVouchersControllerDeleteDraft,
  productionVouchersControllerPost,
  productionVouchersControllerUpdate,
  warehousesControllerList,
  type BomListItemDto,
  type ProductionVoucherDetailDto,
  type ProductionVoucherLineDetailDto,
} from '@erp/api-client';
import { CostCenterLabel, CostCenterSelect } from '../../components/CostCenterField';
import { DocField, DocFields, DocLayout, useDocShortcuts } from '../../components/DocLayout';
import { apiErrorText } from '../../components/ExportButtons';
import { GridSelect } from '../../components/GridSelect';
import { PrintPdfButton } from '../../components/PrintPdfButton';
import { UnitCell } from '../../components/UnitCell';
import { useCostCenters } from '../../hooks/useCostCenters';
import { dec, formatAmount, formatQty, toDecimal } from '../../format/number';
import { idemHeaders } from '../../idempotency';
import { codeAndName } from '../../i18n/displayName';
import { isPositiveQty } from './bomPayload';
import {
  appliedCostPreview,
  productionCreateBody,
  productionProblems,
  productionUpdateBody,
  standardByComponent,
  unitFactor,
  varianceOf,
  withStandard,
  type ProductionForm,
  type ProductionLineForm,
  type ProductionProblem,
} from './productionPayload';
import { bomKeys, invalidateManufacturing, useItemDetail } from './manufacturingQueries';
import { ItemUnitSelect } from './ItemUnitSelect';
import { ManufacturedItemPicker, StockedItemPicker } from './pickers';

/** A produced quantity to start a new voucher with (the shortage panel's «produce it»). */
export interface ProductionPrefill {
  itemId: string;
  /** In the base unit of the product. */
  qty: string;
}

/** The formula's lines, as the standards are computed from them. */
const formulaLinesOf = (bom: BomDetailDto) =>
  bom.lines.map((l) => ({
    componentItemId: l.componentItemId,
    componentLabel: codeAndName(l.componentItem),
    qtyBase: l.qtyBase,
    wastePct: l.wastePct,
  }));

/** Saved lines, as the form holds them. A line that differs from its standard counts as edited. */
function linesFromVoucher(voucher: ProductionVoucherDetailDto, nextKey: () => number): ProductionLineForm[] {
  return voucher.lines.map((l) => ({
    key: nextKey(),
    itemId: l.itemId,
    itemLabel: codeAndName(l.item),
    itemUnitId: l.itemUnitId ?? undefined,
    qty: l.qty,
    standardQtyBase: l.standardQtyBase,
    edited: !dec(l.qtyBase).eq(dec(l.standardQtyBase)),
    note: l.note ?? '',
  }));
}

const STRONG_TONE = {
  over: { color: 'var(--c-danger)', fontWeight: 600 },
  under: { color: 'var(--c-success)', fontWeight: 600 },
  even: undefined,
} as const;

/**
 * The draft of a production voucher (ADR-031 §7): the product and its formula,
 * the quantity and the warehouses, and the materials. The materials start at
 * the formula's standard; each one can be changed, and its difference from the
 * standard shows. Saving and posting run the server's checks again.
 */
export function ProductionEditor({
  voucher,
  prefill,
  onBack,
  onSaved,
  onDeleted,
  onProduce,
}: {
  /** The saved DRAFT being edited; undefined for a new voucher. */
  voucher?: ProductionVoucherDetailDto;
  prefill?: ProductionPrefill;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  /** A shortage's «produce it»: opens a new voucher for that component (ADR-031 §6). */
  onProduce: (itemId: string, qtyBase: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const costCenters = useCostCenters();
  // Line keys are unique for the life of the editor (a ref, so the effects below need no dependency on it).
  const keySeq = useRef(0);
  const nextKey = () => {
    keySeq.current += 1;
    return keySeq.current;
  };

  const [itemId, setItemId] = useState<string | undefined>(voucher?.itemId ?? prefill?.itemId);
  const [bomId, setBomId] = useState<string | undefined>(voucher?.bomId);
  const [qty, setQty] = useState<string | null>(voucher?.qty ?? prefill?.qty ?? null);
  const [itemUnitId, setItemUnitId] = useState<string | undefined>(voucher?.itemUnitId ?? undefined);
  const [materialsWh, setMaterialsWh] = useState<string | undefined>(voucher?.materialsWarehouseId);
  // The output follows the materials warehouse until the user picks another one.
  const [outputWh, setOutputWh] = useState<string | undefined>(
    voucher && voucher.outputWarehouseId !== voucher.materialsWarehouseId ? voucher.outputWarehouseId : undefined,
  );
  const [voucherDate, setVoucherDate] = useState<Dayjs>(voucher ? dayjs(voucher.voucherDate) : dayjs());
  const [costCenterId, setCostCenterId] = useState<string | undefined>(voucher?.costCenterId ?? undefined);
  const [description, setDescription] = useState(voucher?.description ?? '');
  const [lines, setLines] = useState<ProductionLineForm[]>(() => (voucher ? linesFromVoucher(voucher, nextKey) : []));
  const [tried, setTried] = useState(false);

  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const warehouseOptions = (warehouses.data ?? []).filter((w) => w.isActive).map((w) => ({ value: w.id, label: codeAndName(w) }));

  const item = useItemDetail(itemId);
  const productOption = itemId && item.data ? { value: itemId, label: codeAndName(item.data) } : undefined;

  // The formula versions of the product; a draft is not one of them.
  // Its own key: the item page caches every version under bomKeys.ofItem, drafts included.
  const versions = useQuery({
    queryKey: ['boms', 'versions', itemId],
    queryFn: ({ signal }) =>
      bomsControllerList({ itemId, pageSize: 100 }, { signal }).then((r) => r.data.items.filter((b: BomListItemDto) => b.status !== 'DRAFT')),
    enabled: !!itemId,
  });
  const activeVersion = versions.data?.find((b) => b.status === 'ACTIVE');
  // A new voucher takes the active version; a product without one shows the warning.
  useEffect(() => {
    if (!voucher && !bomId && activeVersion) setBomId(activeVersion.id);
  }, [voucher, bomId, activeVersion]);

  const bom = useQuery({
    queryKey: bomKeys.detail(bomId),
    queryFn: ({ signal }) => bomsControllerGet(bomId!, { signal }).then((r) => r.data),
    enabled: !!bomId,
  });

  // Quantity in the base unit: what the formula scales to (ADR-031 §10).
  const factor = unitFactor(itemUnitId, item.data?.units);
  const qtyDec = toDecimal(qty);
  const producedBase = qtyDec && factor && isPositiveQty(qty ?? undefined) ? qtyDec.times(factor).toFixed(6) : undefined;

  // Standards per component for the formula and the quantity; undefined until both are known.
  const standards =
    bom.data && producedBase ? standardByComponent(formulaLinesOf(bom.data), producedBase, bom.data.outputQtyBase) : undefined;

  // Lines follow the formula and the quantity. A saved draft keeps its lines until the formula or quantity changes.
  const appliedSig = useRef('');
  useEffect(() => {
    if (!bom.data || !producedBase) return;
    const sig = `${bom.data.id}|${producedBase}`;
    if (sig === appliedSig.current) return;
    const savedFirstLoad = appliedSig.current === '' && !!voucher;
    appliedSig.current = sig;
    if (savedFirstLoad) return;
    const newKey = () => {
      keySeq.current += 1;
      return keySeq.current;
    };
    setLines((prev) => withStandard(prev, formulaLinesOf(bom.data!), producedBase, bom.data!.outputQtyBase, newKey, { keepEdited: true }));
  }, [bom.data, producedBase, voucher]);

  /** «Reset to formula»: every formula material back to its standard, edits dropped. */
  const applyStandard = () => {
    if (!bom.data || !producedBase) return;
    const newKey = () => {
      keySeq.current += 1;
      return keySeq.current;
    };
    setLines((prev) => withStandard(prev, formulaLinesOf(bom.data!), producedBase, bom.data!.outputQtyBase, newKey, { keepEdited: false }));
  };

  const setLine = (key: number, patch: Partial<ProductionLineForm>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: number) => setLines((ls) => ls.filter((l) => l.key !== key));
  const addLine = () => setLines((ls) => [...ls, { key: nextKey() }]);

  const form: ProductionForm = {
    itemId,
    bomId,
    qty,
    itemUnitId,
    materialsWarehouseId: materialsWh,
    outputWarehouseId: outputWh,
    voucherDate: voucherDate.format('YYYY-MM-DD'),
    costCenterId,
    description,
    lines,
  };
  const problems = productionProblems(form);
  const problemOf = (p: ProductionProblem) => tried && problems.includes(p);

  const persist = async (): Promise<string> => {
    if (voucher) {
      await productionVouchersControllerUpdate(voucher.id, productionUpdateBody(form));
      return voucher.id;
    }
    const res = await productionVouchersControllerCreate(productionCreateBody(form));
    return res.data.id;
  };
  const onError = (err: unknown) => apiMessage.error(apiErrorText(t, err));

  const save = useMutation({
    mutationFn: persist,
    onSuccess: (id) => {
      apiMessage.success(t('manufacturing.prod.saved'));
      void invalidateManufacturing(queryClient);
      onSaved(id);
    },
    onError,
  });
  const post = useMutation({
    mutationFn: async () => {
      const id = await persist();
      const res = await productionVouchersControllerPost(id, { headers: idemHeaders() });
      return res.data;
    },
    onSuccess: (posted) => {
      apiMessage.success(t('manufacturing.prod.posted'));
      void invalidateManufacturing(queryClient, { stock: true });
      onSaved(posted.id);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => productionVouchersControllerDeleteDraft(voucher!.id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      void invalidateManufacturing(queryClient);
      onDeleted();
    },
    onError,
  });
  const busy = save.isPending || post.isPending || remove.isPending;

  /** True when the form may be sent; otherwise marks what is missing. */
  const checkForm = (): boolean => {
    if (busy) return false;
    if (problems.length > 0) {
      setTried(true);
      apiMessage.warning(t('manufacturing.prod.problemsHint'));
      return false;
    }
    return true;
  };
  const saveDraft = () => {
    if (checkForm()) save.mutate();
  };
  useDocShortcuts({ onSave: saveDraft });

  const requiredError = (p: ProductionProblem) => (problemOf(p) ? t('common.requiredField') : undefined);
  const appliedPreview = appliedCostPreview(bom.data?.appliedCostPerUnit, producedBase);
  const shortages = voucher?.lines.filter((l) => l.shortage && dec(l.shortage.shortageQtyBase).gt(0)) ?? [];

  const columns: ColumnsType<ProductionLineForm> = [
    { title: '#', width: 44, render: (_: unknown, _l: ProductionLineForm, index: number) => index + 1 },
    {
      title: t('manufacturing.prod.material'),
      minWidth: 200,
      render: (_: unknown, line: ProductionLineForm) => (
        <StockedItemPicker
          size="small"
          style={{ width: '100%', minWidth: 170 }}
          selected={line.itemId && line.itemLabel ? { value: line.itemId, label: line.itemLabel } : undefined}
          status={tried && problemOf('line') && !line.itemId ? 'error' : undefined}
          value={line.itemId}
          onChange={(v, option) => {
            if (!v) {
              setLine(line.key, { itemId: undefined, itemLabel: undefined, qty: null, standardQtyBase: undefined, edited: false });
              return;
            }
            // A formula material takes its standard; any other starts empty.
            const standard = standards?.get(v);
            setLine(line.key, {
              itemId: v,
              itemLabel: option?.label,
              itemUnitId: undefined,
              standardQtyBase: standard ? standard.toFixed(6) : '0',
              qty: standard ? standard.toFixed(6) : null,
              edited: false,
            });
          }}
        />
      ),
    },
    {
      title: t('manufacturing.prod.unit'),
      width: 120,
      render: (_: unknown, line: ProductionLineForm) => (
        <UnitCell
          label={t('manufacturing.prod.unit')}
          itemId={line.itemId}
          value={line.itemUnitId}
          onChange={(u) => setLine(line.key, { itemUnitId: u, edited: true })}
        />
      ),
    },
    {
      title: t('manufacturing.prod.standardQty'),
      align: 'right',
      width: 150,
      render: (_: unknown, line: ProductionLineForm) => <StandardCell itemId={line.itemId} value={line.standardQtyBase} />,
    },
    {
      title: t('manufacturing.prod.actualQty'),
      width: 130,
      render: (_: unknown, line: ProductionLineForm) => (
        <InputNumber<string>
          size="small"
          stringMode
          min="0"
          step="0.000001"
          style={{ width: '100%' }}
          value={line.qty ?? undefined}
          status={tried && problemOf('line') && !!line.itemId && !isPositiveQty(line.qty) ? 'error' : undefined}
          onChange={(v) => setLine(line.key, { qty: v ?? null, edited: true })}
        />
      ),
    },
    {
      title: t('manufacturing.prod.difference'),
      width: 170,
      render: (_: unknown, line: ProductionLineForm) => <VarianceCell line={line} />,
    },
    {
      title: '',
      width: 48,
      render: (_: unknown, line: ProductionLineForm) => (
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
        {voucher ? t('common.save') : t('common.saveDraft')}
        <span className="doc-kbd">Ctrl+S</span>
      </Button>
      <Popconfirm
        title={t('manufacturing.prod.postConfirm')}
        disabled={busy}
        onConfirm={() => {
          if (checkForm()) post.mutate();
        }}
      >
        <Button disabled={busy} loading={post.isPending}>
          {t('manufacturing.prod.post')}
        </Button>
      </Popconfirm>
      {voucher && (
        <>
          <PrintPdfButton path={`/production-vouchers/${voucher.id}/pdf`} />
          <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate()}>
            <Button danger icon={<DeleteOutlined />} aria-label={t('common.delete')} disabled={busy} loading={remove.isPending} />
          </Popconfirm>
        </>
      )}
    </>
  );

  const outputValue = outputWh ?? materialsWh;

  return (
    <DocLayout
      title={voucher ? t('manufacturing.prod.draftTitle') : t('manufacturing.prod.newTitle')}
      docNo={voucher ? (voucher.docNo ?? t('procurement.draftNo')) : undefined}
      status={voucher?.status}
      onBack={onBack}
      actions={actions}
    >
      {tried && problems.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('manufacturing.prod.problemsHint')} />}
      <DocFields>
        <DocField field="product" label={t('manufacturing.prod.product')} required error={requiredError('item')}>
          <ManufacturedItemPicker
            disabled={!!voucher}
            selected={productOption}
            status={problemOf('item') ? 'error' : undefined}
            value={itemId}
            onChange={(v) => {
              setItemId(v);
              setBomId(undefined);
              setItemUnitId(undefined);
              if (!voucher) setLines([]);
            }}
          />
        </DocField>
        <DocField label={t('manufacturing.prod.formula')} required error={requiredError('bom')}>
          <Select
            disabled={!!voucher || !itemId}
            status={problemOf('bom') ? 'error' : undefined}
            value={bomId}
            onChange={(v: string) => setBomId(v)}
            placeholder={t('manufacturing.prod.formulaPick')}
            options={(versions.data ?? []).map((b) => ({
              value: b.id,
              label: `v${b.versionNo} · ${t(`manufacturing.status.${b.status}`)}`,
            }))}
            notFoundContent={t('manufacturing.prod.noFormula')}
          />
        </DocField>
        <DocField label={t('manufacturing.prod.qty')} required error={requiredError('qty')}>
          <InputNumber<string>
            stringMode
            min="0"
            step="1"
            style={{ width: '100%' }}
            disabled={!!voucher}
            status={problemOf('qty') ? 'error' : undefined}
            value={qty ?? undefined}
            onChange={(v) => setQty(v ?? null)}
          />
        </DocField>
        <DocField label={t('manufacturing.prod.unit')}>
          <ItemUnitSelect
            label={t('manufacturing.prod.unit')}
            itemId={itemId}
            disabled={!!voucher}
            value={itemUnitId}
            onChange={(u) => setItemUnitId(u)}
          />
        </DocField>
        <DocField field="materialsWarehouse" label={t('manufacturing.prod.materialsWarehouse')} required error={requiredError('materialsWarehouse')}>
          <GridSelect
            enterOpens
            disabled={!!voucher}
            status={problemOf('materialsWarehouse') ? 'error' : undefined}
            options={warehouseOptions}
            value={materialsWh}
            onChange={(v: string | undefined) => setMaterialsWh(v)}
          />
        </DocField>
        <DocField label={t('manufacturing.prod.outputWarehouse')}>
          <GridSelect
            enterOpens
            disabled={!!voucher}
            options={warehouseOptions}
            value={outputValue}
            onChange={(v: string | undefined) => setOutputWh(v)}
          />
        </DocField>
        <DocField label={t('manufacturing.prod.date')} required>
          <DatePicker value={voucherDate} allowClear={false} onChange={(d) => d && setVoucherDate(d)} />
        </DocField>
        {costCenters.enabled && (
          <DocField field="costCenter" label={<CostCenterLabel />} wide>
            <>
              <CostCenterSelect enterOpens rows={costCenters.rows} value={costCenterId} onChange={setCostCenterId} />
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                {t('manufacturing.prod.costCentreHelp')}
              </Typography.Text>
            </>
          </DocField>
        )}
        <DocField label={t('manufacturing.prod.description')} wide>
          <Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </DocField>
      </DocFields>

      {itemId && versions.isSuccess && !activeVersion && !voucher && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message={
            <Space wrap>
              {t('manufacturing.prod.noActiveFormula')}
              <Link to={`/boms?new=1&itemId=${itemId}`}>{t('manufacturing.prod.newFormula')}</Link>
            </Space>
          }
        />
      )}

      <Typography.Title level={5} style={{ marginTop: 16 }}>
        {t('manufacturing.prod.lines')}
      </Typography.Title>
      <Table<ProductionLineForm> rowKey="key" size="small" pagination={false} scroll={{ x: 'max-content' }} dataSource={lines} columns={columns} />
      <Space style={{ marginTop: 8 }} wrap>
        <Button icon={<PlusOutlined />} onClick={addLine}>
          {t('manufacturing.prod.addMaterial')}
        </Button>
        {bom.data && producedBase && (
          <Button onClick={applyStandard}>{t('manufacturing.prod.resetFormula')}</Button>
        )}
      </Space>
      {tried && problemOf('lines') && (
        <Typography.Text type="danger" style={{ display: 'block', marginTop: 4 }}>
          {t('manufacturing.prod.linesRequired')}
        </Typography.Text>
      )}

      <div style={{ marginTop: 16 }}>
        <Typography.Text>
          {t('manufacturing.prod.appliedPreview')}: <strong>{appliedPreview ? formatAmount(appliedPreview) : '—'}</strong>
        </Typography.Text>
        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          {t('manufacturing.prod.totalsAtPost')}
        </Typography.Text>
      </div>

      {voucher && <ShortagePanel shortages={shortages} onProduce={onProduce} />}
    </DocLayout>
  );
}

/** The formula's standard of a line, in the base unit of its item. */
function StandardCell({ itemId, value }: { itemId?: string; value?: string | null }) {
  const item = useItemDetail(itemId);
  if (value == null || !itemId) return <span>—</span>;
  const unit = item.data ? codeAndName(item.data.baseUnit) : '';
  return <span>{`${formatQty(value)} ${unit}`.trim()}</span>;
}

/** The actual quantity against the standard, both in the base unit (ADR-031 §3); over is danger, under success, and the words say which. */
function VarianceCell({ line }: { line: ProductionLineForm }) {
  const { t } = useTranslation();
  const item = useItemDetail(line.itemId);
  const variance = varianceOf(line.standardQtyBase, line.qty, unitFactor(line.itemUnitId, item.data?.units)?.toString());
  if (!variance.diffBase) return <span>—</span>;
  const d: Decimal = variance.diffBase;
  const label = variance.tone === 'over' ? t('manufacturing.prod.varianceOver') : variance.tone === 'under' ? t('manufacturing.prod.varianceUnder') : t('manufacturing.prod.varianceEven');
  return (
    <span style={STRONG_TONE[variance.tone]}>
      {`${d.gt(0) ? '+' : ''}${formatQty(d)}`} <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{label}</Typography.Text>
    </span>
  );
}

/**
 * Per line, what is missing from the materials warehouse (ADR-031 §6): the
 * server's figures as of the last save. A manufactured component can be produced.
 */
function ShortagePanel({
  shortages,
  onProduce,
}: {
  shortages: ProductionVoucherLineDetailDto[];
  onProduce: (itemId: string, qtyBase: string) => void;
}) {
  const { t } = useTranslation();
  if (shortages.length === 0) {
    return (
      <Alert type="success" showIcon style={{ marginTop: 16 }} message={t('manufacturing.prod.shortageNone')} />
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      <Typography.Title level={5}>{t('manufacturing.prod.shortagePanel')}</Typography.Title>
      <Table<ProductionVoucherLineDetailDto>
        rowKey="id"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={shortages}
        columns={[
          { title: t('manufacturing.prod.material'), render: (_: unknown, l: ProductionVoucherLineDetailDto) => codeAndName(l.item) },
          {
            title: t('manufacturing.prod.available'),
            align: 'right',
            render: (_: unknown, l: ProductionVoucherLineDetailDto) => formatQty(l.shortage?.availableQtyBase),
          },
          {
            title: t('manufacturing.prod.needed'),
            align: 'right',
            render: (_: unknown, l: ProductionVoucherLineDetailDto) => formatQty(l.qtyBase),
          },
          {
            title: t('manufacturing.prod.missing'),
            align: 'right',
            render: (_: unknown, l: ProductionVoucherLineDetailDto) => (
              <span style={{ color: 'var(--c-danger)', fontWeight: 600 }}>{formatQty(l.shortage?.shortageQtyBase)}</span>
            ),
          },
          {
            title: '',
            width: 170,
            render: (_: unknown, l: ProductionVoucherLineDetailDto) =>
              l.shortage?.canProduce ? (
                <Button size="small" onClick={() => onProduce(l.itemId, l.shortage!.shortageQtyBase)}>
                  {t('manufacturing.prod.produceIt')}
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
