// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';

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
window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(Date.now()), 0);
window.cancelAnimationFrame ??= (handle) => window.clearTimeout(handle);

const ok = <T,>(data: T) => Promise.resolve({ data, status: 200, headers: new Headers() });
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  catalogControllerListGroups: () => ok([]),
  settingsControllerListTaxCategories: () => ok([]),
  settingsControllerListUnits: () => ok([]),
  warehousesControllerList: () => ok([]),
}));

const { ItemFormDialog } = await import('./ItemFormDialog');
let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
});

const renderDialog = async (excludeKinds?: ('STOCK' | 'MANUFACTURED' | 'RECIPE' | 'SERVICE')[]) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AntApp>
          <ItemFormDialog
            open
            excludeKinds={excludeKinds}
            onSaved={() => undefined}
            onCancel={() => undefined}
          />
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
};

describe('ItemFormDialog kind exclusions', () => {
  it('omits excluded kinds from the selector', async () => {
    await renderDialog(['RECIPE']);
    const dialog = document.querySelector('.ant-modal')!;
    expect(dialog.textContent).toContain(i18n.t('items.stock'));
    expect(dialog.textContent).toContain(i18n.t('items.manufactured'));
    expect(dialog.textContent).not.toContain(i18n.t('items.recipe'));
  });

  it('keeps every kind when no exclusions are supplied', async () => {
    await renderDialog();
    expect(document.querySelector('.ant-modal')?.textContent).toContain(i18n.t('items.recipe'));
  });
});
