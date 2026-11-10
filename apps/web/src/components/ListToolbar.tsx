import { SearchOutlined } from '@ant-design/icons';
import { Input } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Standard bar above a list table: search, filters and result count on the
 * start side, actions (e.g. "New") on the end. Sits flush on the table frame.
 */
export function ListToolbar({
  search,
  onSearch,
  searchPlaceholder,
  filters,
  count,
  actions,
}: {
  search?: string;
  /** Omit to hide the search box. */
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  /** Rows shown after search and filters; omit to hide the count. */
  count?: number;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="list-toolbar">
      {onSearch && (
        <Input
          className="list-toolbar-search"
          allowClear
          prefix={<SearchOutlined />}
          placeholder={searchPlaceholder ?? t('common.search')}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      )}
      {filters}
      {count !== undefined && (
        <span className="list-toolbar-count">{t('common.resultCount', { count })}</span>
      )}
      {actions && <div className="list-toolbar-actions">{actions}</div>}
    </div>
  );
}

/** Case-insensitive "contains" match of a search text against any of the values. */
export function matchesSearch(query: string, ...values: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((v) => v != null && v.toLowerCase().includes(q));
}
