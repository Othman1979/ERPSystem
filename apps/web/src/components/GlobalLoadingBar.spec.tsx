import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalLoadingBar } from './GlobalLoadingBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function PendingQuery() {
  useQuery({ queryKey: ['pending'], queryFn: () => new Promise<never>(() => {}) });
  return <GlobalLoadingBar />;
}

function CachedQuery() {
  const { refetch } = useQuery({
    queryKey: ['cached'],
    queryFn: () => new Promise<{ ok: boolean }>(() => {}),
    staleTime: Infinity,
  });
  return (
    <>
      <button type="button" onClick={() => void refetch()}>refetch</button>
      <GlobalLoadingBar />
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

function render(node: ReactNode, client: QueryClient) {
  act(() => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('GlobalLoadingBar', () => {
  it('stays hidden until a first-load query has been pending for 200 ms', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<PendingQuery />, client);
    await act(async () => {});
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('does not show for a refetch whose query already has data', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['cached'], { ok: true });
    render(<CachedQuery />, client);
    await act(async () => {
      container.querySelector('button')?.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(201);
    });
    expect(client.getQueryState(['cached'])?.fetchStatus).toBe('fetching');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });
});
