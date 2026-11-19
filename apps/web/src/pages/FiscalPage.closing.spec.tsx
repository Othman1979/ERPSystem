// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
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

const ok = <T,>(data: T) => Promise.resolve({ data, status: 200, headers: new Headers() });
const state = vi.hoisted(() => ({ role: 'OWNER', closed: false, activeClosing: false }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ me: { currentMembership: { roleCode: state.role } } }),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  fiscalControllerListYears: () =>
    ok([
      {
        id: '1',
        code: '2031',
        startDate: '2031-01-01',
        endDate: '2031-12-31',
        status: state.closed ? 'CLOSED' : 'OPEN',
        _count: { periods: 12 },
        closings: state.closed ? [{ id: '10', journalEntryId: '20', netResult: '5.000', closedAt: '2031-12-31' }] : [],
        activeClosing: state.activeClosing
          ? { id: '10', journalEntryId: '20', netResult: '5.000', closedAt: '2031-12-31T00:00:00.000Z' }
          : null,
      },
    ]),
  fiscalControllerClosingPreview: () =>
    ok({
      fiscalYearId: '1',
      code: '2031',
      startDate: '2031-01-01',
      endDate: '2031-12-31',
      canClose: true,
      netResult: '5.000',
      lines: [],
      drafts: [],
      warnings: [],
    }),
  fiscalControllerCloseYear: vi.fn(() => ok({})),
}));

const { FiscalPage } = await import('./FiscalPage');

let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>
            <FiscalPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  state.role = 'OWNER';
  state.closed = false;
  state.activeClosing = false;
});

describe('FiscalPage year closing', () => {
  it('opens the closing preview dialog before confirming a close', async () => {
    await renderPage();
    const closeButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Close year'),
    );
    expect(closeButton).toBeDefined();
    act(() => closeButton?.click());
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(document.body.textContent).toContain('Preview year closing 2031');
    expect(document.body.textContent).toContain('Year net result');
    expect(document.body.textContent).toContain('Confirm year close');
  });

  it('shows the reopen action to the owner only', async () => {
    state.closed = true;
    state.activeClosing = true;
    state.role = 'CASHIER';
    await renderPage();
    expect(document.body.textContent).not.toContain('Reopen year');

    act(() => root?.unmount());
    root = undefined;
    host?.remove();
    host = undefined;
    state.role = 'OWNER';
    await renderPage();
    expect(document.body.textContent).toContain('Reopen year');
  });

  it('shows close year when every period is closed but there is no active closing', async () => {
    state.closed = true;
    await renderPage();
    expect(document.body.textContent).toContain('Close year');
    expect(document.body.textContent).not.toContain('Reopen year');
  });
});
