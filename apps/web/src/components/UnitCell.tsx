import { useQuery } from '@tanstack/react-query';
import { catalogControllerGetItem } from '@erp/api-client';
import { useTranslation } from 'react-i18next';
import { codeAndName } from '../i18n/displayName';
import { GridSelect } from './GridSelect';

/** Unit choice of a line meaning the item's base unit (sent as no unit id). */
export const BASE_UNIT = 'base';


/** Unit of a line: the item's base unit, or one of its own units. Needs the item, so it loads it. */
export function UnitCell({
  itemId,
  value,
  label,
  onChange,
}: {
  itemId?: string;
  value?: string;
  label: string;
  onChange: (itemUnitId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const item = useQuery({
    queryKey: ['items', 'detail', itemId],
    queryFn: ({ signal }) => catalogControllerGetItem(itemId!, { signal }).then((r) => r.data),
    enabled: !!itemId,
  });
  const options = item.data
    ? [
        { value: BASE_UNIT, label: codeAndName(item.data.baseUnit) },
        ...item.data.units
          .filter((u) => u.isActive)
          .map((u) => ({ value: u.id, label: codeAndName(u.unit) })),
      ]
    : [];
  return (
    <GridSelect
      aria-label={label}
      variant="borderless"
      placeholder={t('procurement.unit')}
      disabled={!itemId}
      options={options}
      value={itemId ? (value ?? BASE_UNIT) : undefined}
      onChange={(v: string) => onChange(v === BASE_UNIT ? undefined : v)}
      style={{ width: '100%' }}
      size="small"
    />
  );
}
