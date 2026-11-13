import { act, Suspense, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appIsServed, lazyPage, loadWithReload } from './lazyPage';
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
    const served = () => Promise.resolve(true);

    // First failure: reload, and never settle while the page goes away.
    let settled = false;
    void loadWithReload(missing, reload, now, served).finally(() => (settled = true));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    // The same failure right after the reload is a real error: no reload loop.
    clock += 2_000;
    await expect(loadWithReload(missing, reload, now, served)).rejects.toThrow('dynamically imported module');
    expect(reload).toHaveBeenCalledTimes(1);

    // Much later (another release), it may reload again.
    clock += 60_000;
    void loadWithReload(missing, reload, now, served);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it('does not reload when the app is not being served (offline, proxy 502 during a restart)', async () => {
    const reload = vi.fn();
    const missing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
    await expect(loadWithReload(missing, reload, () => 1_000_000, () => Promise.resolve(false))).rejects.toThrow(
      'dynamically imported module',
    );
    expect(reload).not.toHaveBeenCalled();
    // The one reload is still available once the server is back.
    void loadWithReload(missing, reload, () => 1_001_000, () => Promise.resolve(true));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  describe('appIsServed', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('is false offline, without asking the server', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      expect(await appIsServed()).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('is false when the proxy answers 502, or answers with another page', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>502 Bad Gateway</h1>', { status: 502 })));
      expect(await appIsServed()).toBe(false);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>Maintenance</h1>', { status: 200 })));
      expect(await appIsServed()).toBe(false);
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
      expect(await appIsServed()).toBe(false);
    });

    it("is true when the server hands out the app's index.html", async () => {
      const fetchSpy = vi.fn(async () => new Response('<div id="root"></div>', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      expect(await appIsServed()).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith('/', expect.objectContaining({ cache: 'no-store' }));
    });
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
