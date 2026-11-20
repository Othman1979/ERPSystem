import { QuestionCircleOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { costCenterOptions, type CostCenterRow } from '../hooks/useCostCenters';
import { GridSelect } from './GridSelect';

/**
 * Label content of the document cost-centre field: the field name followed by
 * an info icon. The icon is focusable, and its hint shows on hover and on
 * keyboard focus (a hover-only tooltip could not be reached from the keyboard).
 */
export function CostCenterLabel() {
  const { t } = useTranslation();
  const hint = t('costCenters.documentHint');
  return (
    <>
      {t('costCenters.documentField')}
      <Tooltip title={hint} trigger={['hover', 'focus']}>
        <span
          role="img"
          tabIndex={0}
          aria-label={hint}
          style={{ marginInlineStart: 4, cursor: 'help' }}
        >
          <QuestionCircleOutlined aria-hidden="true" />
        </span>
      </Tooltip>
    </>
  );
}

/**
 * The document cost-centre select (ADR-024): a GridSelect over the postable
 * centres, plus the saved one. Named for assistive technology by its field name.
 */
export function CostCenterSelect({
  rows,
  value,
  onChange,
}: {
  rows: readonly CostCenterRow[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <GridSelect
      aria-label={t('costCenters.documentField')}
      allowClear
      options={costCenterOptions(rows, [value])}
      value={value}
      onChange={(v: string | undefined) => onChange(v ?? undefined)}
    />
  );
}
