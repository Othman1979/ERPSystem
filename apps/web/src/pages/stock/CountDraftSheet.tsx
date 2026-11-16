import { BarcodeOutlined, DownloadOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Input,
  InputNumber,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Typography,
  Upload,
  type InputRef,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  apiFetchBlob,
  catalogControllerListItems,
  stockDocumentsControllerAddCountLine,
  stockDocumentsControllerImportCount,
  stockDocumentsControllerScanCount,
  stockDocumentsControllerUpdateCountLine,
  type StockCountDetailDto,
  type StockCountLineDto,
} from '@erp/api-client';
import { useAuth } from '../../auth/AuthContext';
import { apiErrorText, apiLang, queryString, saveBlob } from '../../components/ExportButtons';
import { Num } from '../../components/Num';
import { RemoteSelect } from '../../components/RemoteSelect';
import { qtyCell } from '../../format/cells';
import { formatQty } from '../../format/number';
import { idemHeaders } from '../../idempotency';
import { PICKER_PAGE_SIZE } from '../../hooks/useRemoteOptions';
import { codeAndName, displayName } from '../../i18n/displayName';
import {
  bookHidden,
  countDetailKey,
  countProgress,
  diffTone,
  qtyText,
  lineBody,
  sheetFileProblem,
  sheetRowErrors,
  withLine,
  type DiffTone,
  type SheetRowError,
} from './countPayload';
import { CountImportErrors } from './CountImportErrors';
import { useItemUnits } from './stockHooks';

/** How long the scan feedback stays on screen. */
const FEEDBACK_MS = 4000;

const toneStyle = (tone: DiffTone): CSSProperties => ({
  color: tone === 'shortage' ? 'var(--c-danger)' : tone === 'surplus' ? 'var(--c-success)' : undefined,
  fontWeight: tone === 'shortage' || tone === 'surplus' ? 600 : undefined,
});

/**
 * The counting sheet of a DRAFT count (ADR-030 §6 to §11): a barcode input
 * that scans into the sheet, the counted quantities with their units, adding
 * an item found on the shelf, the Excel sheet down and up, and the book
 * columns, which a blind count does not show.
 *
 * A quantity stays on screen as the counter types it and is saved when the
 * field loses focus. Enter moves to the next line.
 */
export function CountDraftSheet({
  detail,
  onRefresh,
  refreshing,
}: {
  detail: StockCountDetailDto;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { message: toast } = App.useApp();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const userId = me?.user.id;
  const id = detail.id;
  const lines = detail.lines;
  const hideBook = bookHidden(lines);

  // Edits not saved yet. A line shows the server's values once it is saved.
  const [pendingQty, setPendingQty] = useState<Record<string, string | null>>({});
  const [pendingUnit, setPendingUnit] = useState<Record<string, string | null>>({});
  const [onlyUncounted, setOnlyUncounted] = useState(false);
  const [barcode, setBarcode] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<StockCountLineDto | null>(null);
  const [importErrors, setImportErrors] = useState<SheetRowError[] | null>(null);
  const barcodeRef = useRef<InputRef>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lastScan) return;
    const timer = window.setTimeout(() => setLastScan(null), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [lastScan]);

  const qtyOf = (l: StockCountLineDto): string | null =>
    l.id in pendingQty ? (pendingQty[l.id] ?? null) : qtyText(l.countedUnitQty);
  const unitOf = (l: StockCountLineDto): string | null =>
    l.id in pendingUnit ? (pendingUnit[l.id] ?? null) : (l.itemUnitId ?? null);

  const putLine = (line: StockCountLineDto) =>
    queryClient.setQueryData<StockCountDetailDto>(countDetailKey(id), (d) => (d ? withLine(d, line) : d));
  const forget = (lineId: string) => {
    setPendingQty(({ [lineId]: _q, ...rest }) => rest);
    setPendingUnit(({ [lineId]: _u, ...rest }) => rest);
  };

  const save = useMutation({
    mutationFn: (v: { lineId: string; qty: string | null; unit: string | null }) =>
      stockDocumentsControllerUpdateCountLine(id, v.lineId, lineBody(v.qty, v.unit)),
    onSuccess: (res, v) => {
      putLine(res.data);
      forget(v.lineId);
    },
    onError: (err) => toast.error(apiErrorText(t, err)),
  });

  /**
   * Saves a line whose quantity or unit differs from the server's. A blank
   * quantity on a line that was never counted saves nothing, so a unit picked
   * first stays on screen until a quantity is typed.
   */
  const commit = (line: StockCountLineDto, qty: string | null, unit: string | null) => {
    const serverQty = qtyText(line.countedUnitQty);
    const serverUnit = line.itemUnitId ?? null;
    if (qty === null) {
      if (serverQty !== null) save.mutate({ lineId: line.id, qty: null, unit: null });
      return;
    }
    if (qty === serverQty && unit === serverUnit) {
      forget(line.id);
      return;
    }
    save.mutate({ lineId: line.id, qty, unit });
  };

  // Changing the unit keeps the number typed: it is the same quantity in the new unit.
  const onUnitChange = (line: StockCountLineDto, value: string) => {
    const unit = value || null;
    setPendingUnit((p) => ({ ...p, [line.id]: unit }));
    const qty = qtyOf(line);
    if (qty !== null) commit(line, qty, unit);
  };

  // Enter in a quantity saves it (by blur) and moves to the next line's quantity.
  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const inputs = Array.from(gridRef.current?.querySelectorAll<HTMLInputElement>('.count-qty input') ?? []);
    const idx = inputs.indexOf(e.target as HTMLInputElement);
    if (idx === -1) return;
    e.preventDefault();
    const next = inputs[idx + 1];
    (e.target as HTMLInputElement).blur();
    next?.focus();
  };

  const scan = useMutation({
    // Each scan is its own action with a fresh key: the API adds one unit per key, so a replay adds once (ADR-030 §9).
    mutationFn: (code: string) => stockDocumentsControllerScanCount(id, { barcode: code }, { headers: idemHeaders() }),
    onSuccess: (res) => {
      putLine(res.data);
      forget(res.data.id);
      setLastScan(res.data);
      setScanError(null);
      setBarcode('');
    },
    onError: (err) => setScanError(apiErrorText(t, err)),
    onSettled: () => barcodeRef.current?.focus(),
  });
  const submitBarcode = () => {
    const code = barcode.trim();
    if (code && !scan.isPending) scan.mutate(code);
  };

  const addItem = useMutation({
    mutationFn: (itemId: string) => stockDocumentsControllerAddCountLine(id, { itemId }),
    onSuccess: (res) => {
      putLine(res.data);
      toast.success(t('stockCount.itemAdded'));
    },
    onError: (err) => toast.error(apiErrorText(t, err)),
  });

  const importSheet = useMutation({
    mutationFn: (file: File) => stockDocumentsControllerImportCount(id, { file }),
    onSuccess: (res) => {
      queryClient.setQueryData(countDetailKey(id), res.data);
      setPendingQty({});
      setPendingUnit({});
      toast.success(t('stockCount.importDone'));
    },
    onError: (err) => {
      const rows = sheetRowErrors(err);
      if (rows.length > 0) setImportErrors(rows);
      else toast.error(apiErrorText(t, err));
    },
  });
  const pickSheet = (file: File) => {
    const problem = sheetFileProblem(file);
    if (problem === 'TYPE') toast.error(t('stockCount.fileNotXlsx'));
    else if (problem === 'SIZE') toast.error(t('stockCount.fileTooLarge'));
    else importSheet.mutate(file);
  };

  const download = async () => {
    try {
      const { blob, filename } = await apiFetchBlob(
        `/stock-counts/${id}/sheet${queryString({ format: 'xlsx', lang: apiLang(i18n.language) })}`,
      );
      saveBlob(blob, filename ?? `count-${detail.docNo ?? id}.xlsx`);
    } catch (err) {
      toast.error(apiErrorText(t, err));
    }
  };

  const { counted, total } = countProgress(lines.map(qtyOf));
  const shown = onlyUncounted ? lines.filter((l) => qtyOf(l) === null) : lines;

  const columns: ColumnsType<StockCountLineDto> = [
    {
      title: t('items.code'),
      width: 110,
      responsive: ['sm'],
      render: (_: unknown, l: StockCountLineDto) => <span className="count-code">{l.item.code}</span>,
    },
    {
      title: t('common.name'),
      minWidth: 140,
      render: (_: unknown, l: StockCountLineDto) => displayName(l.item) ?? l.item.code,
    },
    {
      title: t('items.unit'),
      width: 130,
      render: (_: unknown, l: StockCountLineDto) => (
        <CountUnitSelect line={l} value={unitOf(l)} onChange={(u) => onUnitChange(l, u)} />
      ),
    },
    {
      title: t('stock.countedQty'),
      width: 150,
      align: 'right',
      render: (_: unknown, l: StockCountLineDto) => (
        <InputNumber<string>
          className="count-qty"
          stringMode
          min="0"
          controls={false}
          inputMode="decimal"
          value={qtyOf(l)}
          aria-label={`${t('stock.countedQty')}: ${displayName(l.item) ?? l.item.code}`}
          onChange={(v) => setPendingQty((p) => ({ ...p, [l.id]: v }))}
          onBlur={() => commit(l, qtyOf(l), unitOf(l))}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: t('stockCount.countedAt'),
      width: 150,
      responsive: ['md'],
      render: (_: unknown, l: StockCountLineDto) =>
        l.countedAt ? (
          <span className="count-meta">
            {dayjs(l.countedAt).format('YYYY-MM-DD HH:mm')}
            {userId && l.countedBy === userId ? ` · ${t('stockCount.you')}` : ''}
          </span>
        ) : (
          '—'
        ),
    },
    ...(hideBook
      ? []
      : ([
          { title: t('stock.systemQty'), dataIndex: 'systemQty', width: 110, align: 'right', render: qtyCell },
          {
            title: t('stock.diff'),
            width: 110,
            align: 'right',
            render: (_: unknown, l: StockCountLineDto) => {
              const tone = diffTone(l.differenceQty);
              const sign = tone === 'surplus' ? '+' : '';
              return (
                <Num style={toneStyle(tone)}>{l.differenceQty ? `${sign}${formatQty(l.differenceQty)}` : '—'}</Num>
              );
            },
          },
        ] as ColumnsType<StockCountLineDto>)),
  ];

  return (
    <>
      {/* Scanning is the first thing a storekeeper does, so the barcode input sits on top. */}
      <div className="count-toolbar count-scan-panel">
        <Input
          ref={barcodeRef}
          className="count-scan-input"
          size="large"
          autoFocus
          allowClear
          prefix={<BarcodeOutlined />}
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          onPressEnter={submitBarcode}
          placeholder={t('stockCount.barcodePlaceholder')}
          aria-label={t('stockCount.barcode')}
          autoComplete="off"
          enterKeyHint="send"
          status={scanError ? 'error' : undefined}
        />
        {scanError && (
          <Typography.Text type="danger" role="alert" className="count-scan-error">
            {scanError}
          </Typography.Text>
        )}
        {lastScan && <ScanFeedback line={lastScan} />}
      </div>

      <div className="count-toolbar">
        <div className="count-progress">
          <Typography.Text>{t('stockCount.progress', { counted, total })}</Typography.Text>
          <Progress
            percent={total ? Math.round((counted / total) * 100) : 0}
            size="small"
            showInfo={false}
          />
        </div>
        <label className="count-filter">
          <Switch size="small" checked={onlyUncounted} onChange={setOnlyUncounted} />
          <span>{t('stockCount.uncountedOnly')}</span>
        </label>
        <Space wrap className="count-actions">
          <RemoteSelect
            queryKey={['items', 'pick', { itemKind: 'STOCK' }]}
            fetchOptions={(q, signal) =>
              catalogControllerListItems(
                { pageSize: PICKER_PAGE_SIZE, itemKind: 'STOCK', ...(q ? { q } : {}) },
                { signal },
              ).then((r) => r.data.items.map((i) => ({ value: i.id, label: codeAndName(i) })))
            }
            value={undefined}
            onChange={(v) => {
              if (v) addItem.mutate(v);
            }}
            placeholder={t('stockCount.addItem')}
            aria-label={t('stockCount.addItem')}
            disabled={addItem.isPending}
            style={{ minWidth: 220 }}
          />
          <Button icon={<DownloadOutlined />} onClick={() => void download()}>
            {t('stockCount.downloadSheet')}
          </Button>
          <Upload
            accept=".xlsx"
            showUploadList={false}
            beforeUpload={(file) => {
              pickSheet(file);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={importSheet.isPending} title={t('stockCount.uploadHint')}>
              {t('stockCount.uploadSheet')}
            </Button>
          </Upload>
          {!detail.blind && (
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh} title={t('stockCount.refreshHint')}>
              {t('stockCount.refreshBook')}
            </Button>
          )}
        </Space>
      </div>

      <div ref={gridRef} onKeyDown={onGridKeyDown} className="count-grid">
        <Table<StockCountLineDto>
          rowKey="id"
          size="small"
          dataSource={shown}
          columns={columns}
          pagination={{ pageSize: 25, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: onlyUncounted && lines.length > 0 ? t('stockCount.allCounted') : t('stockCount.noLines') }}
        />
      </div>

      {importErrors && <CountImportErrors rows={importErrors} onClose={() => setImportErrors(null)} />}
    </>
  );
}

/** A line's unit: the base unit (empty value) or one of the item's units (ADR-030 §8). */
function CountUnitSelect({
  line,
  value,
  onChange,
}: {
  line: StockCountLineDto;
  value: string | null;
  onChange: (unitId: string) => void;
}) {
  const { t } = useTranslation();
  const item = useItemUnits(line.itemId);
  const options = [
    { value: '', label: item.data?.baseUnit.code ?? '—' },
    ...(item.data?.units ?? [])
      .filter((u) => u.isActive)
      .map((u) => ({ value: u.id, label: `${u.unit.code} · ×${formatQty(u.factorToBase)}` })),
  ];
  return (
    <Select
      aria-label={t('items.unit')}
      value={value ?? ''}
      onChange={onChange}
      options={options}
      loading={item.isLoading}
      style={{ width: '100%' }}
    />
  );
}

/** Confirms the last scan: the item and its new quantity, in the scanned unit. */
function ScanFeedback({ line }: { line: StockCountLineDto }) {
  const { t } = useTranslation();
  const item = useItemUnits(line.itemId);
  const unit = line.itemUnit?.unit.code ?? item.data?.baseUnit.code ?? '';
  return (
    <div className="count-scan-feedback" role="status">
      {t('stockCount.scanned', {
        name: displayName(line.item) ?? line.item.code,
        qty: formatQty(line.countedUnitQty),
        unit,
      })}
    </div>
  );
}
