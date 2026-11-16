import { Select } from 'antd';
import { useTranslation } from 'react-i18next';
import { codeAndName } from '../../i18n/displayName';
import { useItemDetail } from './manufacturingQueries';
import { BASE_UNIT } from '../../components/UnitCell';

/**
 * The unit of an item in a form header: its base unit or one of its active
 * units. Sends no unit id for the base unit, as the API expects. Disabled
 * until the item is chosen.
 */
export function ItemUnitSelect({
  itemId,
  value,
  onChange,
  disabled,
  status,
  label,
}: {
  itemId?: string;
  value?: string;
  onChange: (itemUnitId: string | undefined) => void;
  disabled?: boolean;
  status?: 'error';
  label: string;
}) {
  const { t } = useTranslation();
  const item = useItemDetail(itemId);
  const options = item.data
    ? [
        { value: BASE_UNIT, label: codeAndName(item.data.baseUnit) },
        ...item.data.units.filter((u) => u.isActive).map((u) => ({ value: u.id, label: codeAndName(u.unit) })),
      ]
    : [];
  return (
    <Select
      aria-label={label}
      placeholder={t('procurement.unit')}
      disabled={disabled || !itemId}
      status={status}
      options={options}
      value={itemId ? (value ?? BASE_UNIT) : undefined}
      onChange={(v: string) => onChange(v === BASE_UNIT ? undefined : v)}
      style={{ width: '100%' }}
    />
  );
}
