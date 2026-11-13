import { act, Suspense, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyPage, loadWithReload } from './lazyPage';
import { ALL_ROUTES, PAGE_LOADERS } from './routes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('lazy pages (WEB-10)', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('shows the fallback while the chunk loads, then the page', async () => {
    let resolve!: (c: () => ReactElement) => void;
    const Page = lazyPage(() => new Promise<() => ReactElement>((r) => (resolve = r)));
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Suspense fallback={<span>loading</span>}>
          <Page />
        </Suspense>,
      );
    });
    expect(container.textContent).toBe('loading');
    await act(async () => resolve(() => <h1>sales</h1>));
    expect(container.textContent).toBe('sales');
    act(() => root.unmount());
  });

  it('reloads the page once when a chunk is missing (a new release), then gives up', async () => {
    const reload = vi.fn();
    const missing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    let clock = 1_000_000;
    const now = () => clock;

    // First failure: reload, and never settle while the page goes away.
    let settled = false;
    void loadWithReload(missing, reload, now).finally(() => (settled = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    // The same failure right after the reload is a real error: no reload loop.
    clock += 2_000;
    await expect(loadWithReload(missing, reload, now)).rejects.toThrow('dynamically imported module');
    expect(reload).toHaveBeenCalledTimes(1);

    // Much later (another release), it may reload again.
    clock += 60_000;
    void loadWithReload(missing, reload, now);
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('passes a loaded module straight through', async () => {
    const reload = vi.fn();
    await expect(loadWithReload(() => Promise.resolve('ok'), reload)).resolves.toBe('ok');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('route table', () => {
  afterEach(() => vi.restoreAllMocks());

  it('has a loader for every module route', () => {
    expect(Object.keys(PAGE_LOADERS).sort()).toEqual(ALL_ROUTES.map((r) => r.key).sort());
  });

  // The first import transforms antd and the page; give it time.
  it.each(Object.entries(PAGE_LOADERS))('loads the %s page component from its chunk', { timeout: 60_000 }, async (_key, load) => {
    const component = await load();
    expect(typeof component).toBe('function');
  });
});
