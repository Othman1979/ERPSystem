// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import '../i18n';
import { usePagedQuery, type Page, type PageParams } from './usePagedQuery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof usePagedQuery<{ id: string }, { status?: string }>>;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** Renders the hook; `answer` decides the server's reply to each request. */
async function mount(answer: (p: PageParams) => Page<{ id: string }> = (p) => ({ items: [{ id: '1' }], page: p.page, pageSize: p.pageSize, total: 95 })) {
  const calls: (PageParams & { status?: string })[] = [];
  const current: { hook?: Hook; setStatus?: (s: string | undefined) => void } = {};
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ status }: { status?: string }) {
    current.hook = usePagedQuery<{ id: string }, { status?: string }>({
      key: ['things'],
      filters: { status },
      defaultSort: '-date',
      fetch: async (params) => {
        calls.push(params);
        return answer(params);
      },
    });
    return null;
  }
  const container = document.createElement('div');
  root = createRoot(container);
  const render = (status?: string) =>
    act(() =>
      root!.render(
        <QueryClientProvider client={client}>
          <Harness status={status} />
        </QueryClientProvider>,
      ),
    );
  await render();
  await settle();
  return { calls, current, render, last: () => calls[calls.length - 1] };
}

describe('usePagedQuery (ADR-022 §8)', () => {
  it('asks for page 1 of 20, then the page the table picks', async () => {
    const { current, last } = await mount();
    expect(last()).toEqual({ page: 1, pageSize: 20 });
    expect(current.hook!.pagination).toMatchObject({ current: 1, pageSize: 20, total: 95 });
    await act(async () => current.hook!.onTableChange({ current: 3, pageSize: 20 }, {}, {}));
    await settle();
    expect(last()).toEqual({ page: 3, pageSize: 20 });
  });

  it('a filter change goes back to page 1 without asking for the old page again', async () => {
    const { current, render, calls, last } = await mount();
    await act(async () => current.hook!.onTableChange({ current: 4, pageSize: 20 }, {}, {}));
    await settle();
    const before = calls.length;
    await render('POSTED');
    await settle();
    expect(calls.slice(before)).toEqual([{ page: 1, pageSize: 20, status: 'POSTED' }]);
    expect(last()).toEqual({ page: 1, pageSize: 20, status: 'POSTED' });
  });

  it('a column sort is sent as key / -key; the default sort shown on a column does not reset the page', async () => {
    const { current, last } = await mount();
    await act(async () => current.hook!.onTableChange({ current: 2, pageSize: 20 }, {}, { columnKey: 'date', order: 'descend' }));
    await settle();
    expect(last()).toEqual({ page: 2, pageSize: 20 });
    expect(current.hook!.sortOrderOf('date')).toBe('descend');
    await act(async () => current.hook!.onTableChange({ current: 2, pageSize: 20 }, {}, { columnKey: 'total', order: 'ascend' }));
    await settle();
    expect(last()).toEqual({ page: 1, pageSize: 20, sort: 'total' });
    expect(current.hook!.sortOrderOf('total')).toBe('ascend');
    expect(current.hook!.sortOrderOf('date')).toBeNull();
  });

  it('a page size change goes back to page 1', async () => {
    const { current, last } = await mount();
    await act(async () => current.hook!.onTableChange({ current: 3, pageSize: 20 }, {}, {}));
    await settle();
    await act(async () => current.hook!.onTableChange({ current: 3, pageSize: 50 }, {}, {}));
    await settle();
    expect(last()).toEqual({ page: 1, pageSize: 50 });
  });

  it('a page past the end moves to the last page that has rows', async () => {
    const { current, last } = await mount((p) =>
      p.page > 2 ? { items: [], page: p.page, pageSize: p.pageSize, total: 25 } : { items: [{ id: '1' }], page: p.page, pageSize: p.pageSize, total: 25 },
    );
    await act(async () => current.hook!.onTableChange({ current: 5, pageSize: 20 }, {}, {}));
    await settle();
    await settle();
    expect(last()).toEqual({ page: 2, pageSize: 20 });
  });

  it('search is trimmed and sent after typing stops', async () => {
    const { current, last } = await mount();
    await act(async () => current.hook!.setSearch('  inv-7 '));
    expect(last()).toEqual({ page: 1, pageSize: 20 });
    await act(() => new Promise((r) => setTimeout(r, 350)));
    await settle();
    expect(last()).toEqual({ page: 1, pageSize: 20, q: 'inv-7' });
  });

  it('clearing a search returns to page 1, not to the page before the search', async () => {
    const { current, last } = await mount();
    await act(async () => current.hook!.onTableChange({ current: 3, pageSize: 20 }, {}, {}));
    await settle();
    await act(async () => current.hook!.setSearch('abc'));
    await act(() => new Promise((r) => setTimeout(r, 350)));
    await settle();
    await act(async () => current.hook!.setSearch(''));
    await act(() => new Promise((r) => setTimeout(r, 350)));
    await settle();
    expect(last()).toEqual({ page: 1, pageSize: 20 });
  });
});
