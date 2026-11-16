import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, InputNumber, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { GridHint } from '../../components/GridHint';
import { GridSelect } from '../../components/GridSelect';
import { cellLabel } from '../../components/gridA11y';
import { UnitCell } from '../../components/UnitCell';
import type { SalesFormLine } from './salesLines';

/** A line of a sales form, keyed while it is on screen. */
export interface SalesLineDraft extends SalesFormLine {
  key: number;
}

/**
 * Lines of a sales quote or order: item, unit, qty, unit price and discount %
 * as inputs. Tax and totals come from the server (ADR-017).
 */
export function SalesLinesGrid({
  lines,
  onChange,
  itemOptions,
  onItemSearch,
  priceOf,
  nextKey,
  lineError,
  priceGaps,
}: {
  lines: SalesLineDraft[];
  onChange: (lines: SalesLineDraft[]) => void;
  itemOptions: { value: string; label: string }[];
  onItemSearch: (text: string) => void;
  /** Default unit price of an item, used when the line has none yet. */
  priceOf: (itemId: string) => string | undefined;
  nextKey: () => number;
  lineError?: string;
  /** Row indexes whose unit price is missing; marked as errors. */
  priceGaps: ReadonlySet<number>;
}) {
  const { t } = useTranslation();

  const update = (key: number, patch: Partial<SalesLineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickItem = (line: SalesLineDraft, itemId: string) =>
    update(line.key, {
      itemId,
      // A unit belongs to one item: a new item starts on its base unit.
      itemUnitId: undefined,
      unitPrice: line.unitPrice?.trim() ? line.unitPrice : (priceOf(itemId) ?? null),
    });

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length >= 1 ? next : [{ key: nextKey() }]);
  };

  return (
    <div className="entry-grid-frame">
      <div className="entry-grid-scroll">
        <table className="entry-grid">
          <thead>
            <tr>
              <th className="row-no">#</th>
              <th>{t('procurement.item')}</th>
              <th style={{ width: 120 }}>{t('procurement.unit')}</th>
              <th className="num-cell" style={{ width: 110 }}>{t('procurement.qty')}</th>
              <th className="num-cell" style={{ width: 120 }}>{t('procurement.unitPrice')}</th>
              <th className="num-cell" style={{ width: 100 }}>{t('procurement.discountPct')}</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, row) => (
              <tr key={l.key}>
                <td className="row-no">{row + 1}</td>
                <td>
                  <GridSelect
                    aria-label={cellLabel(t, t('procurement.item'), row)}
                    variant="borderless"
                    placeholder={t('procurement.item')}
                    options={itemOptions}
                    onRemoteSearch={onItemSearch}
                    value={l.itemId}
                    onChange={(v: string) => pickItem(l, v)}
                    style={{ width: '100%' }}
                    size="small"
                  />
                </td>
                <td>
                  <UnitCell
                    itemId={l.itemId}
                    value={l.itemUnitId}
                    label={cellLabel(t, t('procurement.unit'), row)}
                    onChange={(itemUnitId) => update(l.key, { itemUnitId })}
                  />
                </td>
                <td className="num-cell">
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.qty'), row)}
                    variant="borderless"
                    stringMode
                    min="0.000001"
                    placeholder={t('procurement.qty')}
                    value={l.qty}
                    onChange={(v) => update(l.key, { qty: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td className="num-cell">
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.unitPrice'), row)}
                    variant="borderless"
                    stringMode
                    min="0"
                    status={priceGaps.has(row) ? 'error' : undefined}
                    placeholder={t('procurement.unitPrice')}
                    value={l.unitPrice}
                    onChange={(v) => update(l.key, { unitPrice: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td className="num-cell">
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.discountPct'), row)}
                    variant="borderless"
                    stringMode
                    min="0"
                    max="100"
                    placeholder={t('procurement.discountPct')}
                    value={l.discountPct}
                    onChange={(v) => update(l.key, { discountPct: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <Button
                    className="row-del"
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={t('common.delete')}
                    onClick={() => remove(l.key)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="entry-grid-footer">
        <Button type="link" icon={<PlusOutlined />} onClick={() => onChange([...lines, { key: nextKey() }])}>
          {t('common.add')}
        </Button>
        {lineError && <Typography.Text type="danger">{lineError}</Typography.Text>}
        <GridHint lineCount={lines.filter((l) => l.itemId).length} />
      </div>
    </div>
  );
}
