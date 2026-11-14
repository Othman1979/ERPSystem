// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@erp/api-client';
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
  legalNameEn: 'A Co',
  taxNumber: null,
  commercialRegistration: null,
  address: null,
  phone: null,
  pricesIncludeTax: false,
  procurementLevel: 'MEDIUM',
  onboardingCompletedAt: null,
  logo: null,
};

const session = vi.hoisted(() => ({ permissions: ['company.manage', 'settings.manage'] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: (p: string) => session.permissions.includes(p) }),
}));
const update = vi.fn();
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  companyControllerGet: () => ok(COMPANY),
  companyControllerUpdate: (...args: unknown[]) => update(...args),
}));

const { CompanyProfileForm } = await import('./CompanyProfileForm');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  update.mockReset();
  update.mockImplementation(() => ok(COMPANY));
  session.permissions = ['company.manage', 'settings.manage'];
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function mount(withProcurement: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <CompanyProfileForm withTax withProcurement={withProcurement} />
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const levelItem = () =>
  [...host.querySelectorAll('.ant-form-item')].find((el) => el.textContent?.includes(i18n.t('company.procurementLevel')));
const select = () => levelItem()!.querySelector('.ant-select')!;
async function choose(level: string) {
  const selector = select().querySelector<HTMLElement>('.ant-select-selector') ?? select();
  act(() => selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await settle(50);
  const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
    (o) => o.textContent === i18n.t(`company.procurementLevels.${level}`),
  )!;
  act(() => option.click());
  await settle(50);
}
async function submit() {
  act(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await settle();
}

describe('CompanyProfileForm procurement level (ADR-024 §2)', () => {
  it('shows the saved level with its explanation', async () => {
    await mount(true);
    expect(levelItem()!.textContent).toContain(i18n.t('company.procurementLevelHint'));
    expect(select().textContent).toContain(i18n.t('company.procurementLevels.MEDIUM'));
  });

  it('saves a new level with the profile', async () => {
    await mount(true);
    await choose('FULL');
    await submit();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({ procurementLevel: 'FULL', legalNameAr: 'شركة أ' });
  });

  it('puts the saved level back when the API refuses a lowering', async () => {
    update.mockImplementation(() =>
      Promise.reject(new ApiError(409, 'PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS', 'open', { openDocuments: { x: 1 } })),
    );
    await mount(true);
    await choose('SIMPLE');
    await submit();
    expect(update.mock.calls[0]![0]).toMatchObject({ procurementLevel: 'SIMPLE' });
    expect(select().textContent).toContain(i18n.t('company.procurementLevels.MEDIUM'));
    expect(document.body.textContent).toContain(i18n.t('errors.PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS'));
  });

  it('is read-only without company.manage', async () => {
    session.permissions = ['settings.manage'];
    await mount(true);
    expect(select().className).toContain('ant-select-disabled');
  });

  it('is not part of the setup wizard form', async () => {
    await mount(false);
    expect(levelItem()).toBeUndefined();
  });
});
