// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no matchMedia; antd's responsive hooks ask for it.
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

const COMPANY = {
  id: '1',
  legalNameAr: 'شركة أ',
  legalNameEn: null,
  taxNumber: null,
  commercialRegistration: null,
  address: null,
  phone: null,
  pricesIncludeTax: false,
  costCentersEnabled: false,
  procurementLevel: 'SIMPLE',
  salesOrderRequired: false,
  salesReservation: 'SOFT',
  salesOrderApproval: 'OVER_CREDIT_LIMIT',
  salesPriceLocked: false,
  quoteValidityDays: 30,
  directSalesDraftCount: 4,
  onboardingCompletedAt: null,
  logo: null,
};

const update = vi.fn();
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  companyControllerGet: () => ok(COMPANY),
  companyControllerUpdate: (...args: unknown[]) => update(...args),
}));

const { SalesSettingsForm } = await import('./SalesSettingsForm');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  update.mockReset();
  update.mockImplementation(() => ok(COMPANY));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <SalesSettingsForm />
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const switchOf = (id: string) => document.getElementById(id) as HTMLButtonElement;

async function submit() {
  act(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await settle();
}

describe('sales settings (ADR-027 §1)', () => {
  it('shows the company values, with the validity in days', async () => {
    await mount();
    expect(host.querySelector<HTMLInputElement>('#quoteValidityDays')!.value).toBe('30');
    expect(switchOf('salesOrderRequired').getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain(i18n.t('salesCycle.settings.reservationOptions.SOFT'));
  });

  it('warns with the number of direct draft invoices when the order requirement is turned on', async () => {
    await mount();
    expect(host.textContent).not.toContain(i18n.t('salesCycle.settings.orderRequiredWarning', { count: 4 }));
    act(() => switchOf('salesOrderRequired').click());
    await settle(50);
    expect(host.textContent).toContain(i18n.t('salesCycle.settings.orderRequiredWarning', { count: 4 }));
  });

  it('saves the five settings together', async () => {
    await mount();
    act(() => switchOf('salesPriceLocked').click());
    await settle(50);
    await submit();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toEqual({
      salesOrderRequired: false,
      salesReservation: 'SOFT',
      salesOrderApproval: 'OVER_CREDIT_LIMIT',
      salesPriceLocked: true,
      quoteValidityDays: 30,
    });
  });
});
