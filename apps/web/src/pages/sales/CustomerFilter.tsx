import { useTranslation } from 'react-i18next';
import { partiesControllerList } from '@erp/api-client';
import { RemoteSelect, PICKER_PAGE_SIZE } from '../../components/RemoteSelect';
import { codeAndName } from '../../i18n/displayName';

/** The customer filter of the sales lists; customers are searched on the server (ADR-022 §8). */
export function CustomerFilter({ value, onChange }: { value?: string; onChange: (value?: string) => void }) {
  const { t } = useTranslation();
  return (
    <RemoteSelect
      allowClear
      style={{ minWidth: 200 }}
      placeholder={t('sales.customer')}
      queryKey={['parties', 'pick', 'CUSTOMER']}
      fetchOptions={(q, signal) =>
        partiesControllerList({ partyType: 'CUSTOMER', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) }, { signal }).then(
          (r) => r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) })),
        )
      }
      value={value}
      onChange={(v) => onChange(v)}
    />
  );
}
