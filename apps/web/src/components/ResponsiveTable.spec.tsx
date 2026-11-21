// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TableProps } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const breakpoint = vi.hoisted(() => ({ md: false }));

vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>();
  return {
    ...antd,
    Grid: { ...antd.Grid, useBreakpoint: () => ({ md: breakpoint.md }) },
  };
});

import { ResponsiveTable, type MobileCard } from './ResponsiveTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

type Row = { id: string; name: string };
type Props = TableProps<Row> & { mobileCard?: MobileCard<Row> };
const rows: Row[] = [{ id: '1', name: 'First' }, { id: '2', name: 'Second' }];
const mobileCard = { title: (row: Row) => row.name };
let host: HTMLDivElement | undefined;
let root: Root | undefined;

function renderTable(props: Partial<Props> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ResponsiveTable<Row>
        rowKey="id"
        dataSource={rows}
        columns={[{ dataIndex: 'name' }]}
        mobileCard={mobileCard}
        {...props}
      />,
    );
  });
}

beforeEach(() => {
  breakpoint.md = false;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
});

describe('ResponsiveTable', () => {
  it('renders cards below md and the table at md and up', () => {
    renderTable();
    expect(host!.querySelectorAll('.responsive-table-card')).toHaveLength(2);
    expect(host!.querySelector('table')).toBeNull();

    act(() => root!.unmount());
    host!.remove();
    breakpoint.md = true;
    renderTable();
    expect(host!.querySelector('table')).not.toBeNull();
    expect(host!.querySelector('.responsive-table-card')).toBeNull();
  });

  it('forwards card clicks and keyboard activation to onRow', () => {
    const onClick = vi.fn();
    renderTable({ onRow: (row) => ({ onClick: () => onClick(row.id) }) });
    const card = host!.querySelector<HTMLElement>('.responsive-table-card')!;
    act(() => card.click());
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onClick).toHaveBeenNthCalledWith(1, '1');
    expect(onClick).toHaveBeenNthCalledWith(2, '1');
  });

  it('calls the table onChange shape when mobile pagination changes', () => {
    const onChange = vi.fn();
    renderTable({
      pagination: { current: 1, pageSize: 1, total: 2, showSizeChanger: false },
      onChange,
    });
    const pageTwo = host!.querySelector<HTMLElement>('.ant-pagination-item-2')!;
    act(() => pageTwo.click());
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ current: 2, pageSize: 1 }),
      {},
      {},
      expect.objectContaining({ action: 'paginate' }),
    );
  });

  it('renders the table locale empty text and loading state', () => {
    renderTable({ dataSource: [], locale: { emptyText: <span>Empty list</span> } });
    expect(host!.textContent).toContain('Empty list');

    act(() => root!.unmount());
    host!.remove();
    renderTable({ loading: true });
    expect(host!.querySelector('.ant-spin-spinning')).not.toBeNull();
  });
});
