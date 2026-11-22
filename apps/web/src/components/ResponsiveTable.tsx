import { Empty, Grid, Pagination, Spin, Table } from 'antd';
import type { TablePaginationConfig, TableProps } from 'antd';
import { useState, type Key, type ReactNode } from 'react';

export type MobileCard<T> = {
  title: (row: T) => ReactNode;
  subtitle?: (row: T) => ReactNode;
  amount?: (row: T) => ReactNode;
  status?: (row: T) => ReactNode;
  meta?: (row: T) => ReactNode[];
  actions?: (row: T) => ReactNode;
};

export function ResponsiveTable<T extends object>(props: TableProps<T> & { mobileCard?: MobileCard<T> }) {
  const initialPagination = props.pagination === false ? undefined : props.pagination;
  const [localCurrent, setLocalCurrent] = useState(initialPagination?.defaultCurrent ?? 1);
  const [localPageSize, setLocalPageSize] = useState(initialPagination?.defaultPageSize ?? 10);
  const screens = Grid.useBreakpoint();
  const { mobileCard, ...tableProps } = props;

  if (screens.md !== false) return <Table<T> {...tableProps} />;
  if (!mobileCard) {
    return <Table<T> {...tableProps} scroll={{ x: 'max-content', ...(tableProps.scroll ?? {}) }} />;
  }

  const {
    className,
    rootClassName,
    style,
    dataSource,
    loading,
    locale,
    onRow,
    onChange,
    pagination,
    rowKey,
  } = props;
  const rows = dataSource ?? [];
  const paginationEnabled = pagination !== false;
  const paginationConfig: TablePaginationConfig = paginationEnabled ? pagination ?? {} : {};
  const current = paginationConfig.current ?? localCurrent;
  const pageSize = paginationConfig.pageSize ?? localPageSize;
  const total = paginationConfig.total ?? rows.length;
  const visibleRows = !paginationEnabled || total > rows.length
    ? rows
    : rows.slice((current - 1) * pageSize, current * pageSize);
  const emptyText = typeof locale?.emptyText === 'function' ? locale.emptyText() : locale?.emptyText;
  const spinning = typeof loading === 'object' ? loading.spinning ?? true : Boolean(loading);

  const changePage = (nextCurrent: number, nextPageSize: number) => {
    if (paginationConfig.current === undefined) setLocalCurrent(nextCurrent);
    if (paginationConfig.pageSize === undefined) setLocalPageSize(nextPageSize);
    paginationConfig.onChange?.(nextCurrent, nextPageSize);
    const nextRows = total > rows.length
      ? rows
      : rows.slice((nextCurrent - 1) * nextPageSize, nextCurrent * nextPageSize);
    onChange?.(
      { ...paginationConfig, current: nextCurrent, pageSize: nextPageSize, total },
      {},
      {},
      { currentDataSource: [...nextRows], action: 'paginate' },
    );
  };

  return (
    <Spin {...(typeof loading === 'object' ? loading : {})} spinning={spinning}>
      <div className={['responsive-table', className, rootClassName].filter(Boolean).join(' ')} style={style}>
        {visibleRows.length ? (
          <div className="responsive-table-cards">
            {visibleRows.map((row, index) => {
              const rowProps = onRow?.(row, index) ?? {};
              const cardActions = mobileCard.actions?.(row);
              const {
                className: rowClassName,
                onClick,
                onKeyDown,
                role,
                style: rowStyle,
                tabIndex,
                ...otherRowProps
              } = rowProps;
              const key =
                typeof rowKey === 'function'
                  ? rowKey(row, index)
                  : typeof rowKey === 'string'
                    ? (row as unknown as Record<string, unknown>)[rowKey] as Key | undefined
                    : (row as { key?: Key }).key;

              return (
                <div
                  {...otherRowProps}
                  key={key ?? index}
                  className={['responsive-table-card', rowClassName].filter(Boolean).join(' ')}
                  role={role ?? (onClick ? 'button' : undefined)}
                  style={rowStyle}
                  tabIndex={tabIndex ?? (onClick ? 0 : undefined)}
                  onClick={onClick}
                  onKeyDown={(event) => {
                    onKeyDown?.(event);
                    if (event.defaultPrevented || !onClick || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                >
                  <div className="responsive-table-card-heading">
                    <div className="responsive-table-card-title">{mobileCard.title(row)}</div>
                    {mobileCard.status && <div className="responsive-table-card-status">{mobileCard.status(row)}</div>}
                  </div>
                  {mobileCard.subtitle && (
                    <div className="responsive-table-card-subtitle">{mobileCard.subtitle(row)}</div>
                  )}
                  {mobileCard.amount && (
                    <div className="responsive-table-card-amount">{mobileCard.amount(row)}</div>
                  )}
                  {mobileCard.meta && (
                    <div className="responsive-table-card-meta">
                      {mobileCard.meta(row).map((item, itemIndex) => <span key={itemIndex}>{item}</span>)}
                    </div>
                  )}
                  {cardActions !== undefined && cardActions !== null && cardActions !== false && (
                    <div
                      className="responsive-table-card-actions"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      {cardActions}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="responsive-table-empty">
            {emptyText ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </div>
        )}
        {paginationEnabled && (
          <div className="responsive-table-pagination">
            <Pagination
              {...paginationConfig}
              current={current}
              pageSize={pageSize}
              total={total}
              onChange={changePage}
            />
          </div>
        )}
      </div>
    </Spin>
  );
}
