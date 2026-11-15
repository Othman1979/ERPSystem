// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type PurchaseDirectGapDto } from '@erp/api-client';
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
const saved = vi.hoisted(() => ({ level: 'MEDIUM' }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: (p: string) => session.permissions.includes(p) }),
}));
const update = vi.fn();
const directGaps = vi.fn();
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  companyControllerGet: () => ok({ ...COMPANY, procurementLevel: saved.level }),
  companyControllerUpdate: (...args: unknown[]) => update(...args),
  usersControllerPurchaseDirectGaps: (...args: unknown[]) => directGaps(...args),
}));

const GAPS: PurchaseDirectGapDto[] = [
  {
    fullName: 'سارة أحمد',
    email: 'sara@example.com',
    role: { code: 'ACCOUNTANT', nameAr: 'محاسب', nameEn: 'Accountant' },
  },
  {
    fullName: 'Omar Ali',
    email: 'omar@example.com',
    role: { code: 'CASHIER', nameAr: 'أمين صندوق', nameEn: 'Cashier' },
  },
];

const { CompanyProfileForm } = await import('./CompanyProfileForm');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  update.mockReset();
  update.mockImplementation(() => ok(COMPANY));
  directGaps.mockReset();
  directGaps.mockImplementation(() => ok([]));
  saved.level = 'MEDIUM';
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

describe('CompanyProfileForm direct-purchase gaps before raising from SIMPLE (ADR-025 §4)', () => {
  const dialog = () => document.querySelector<HTMLElement>('.ant-modal');
  const dialogButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.ant-modal button')].find((b) => b.textContent === label)!;

  beforeEach(() => {
    session.permissions = ['company.manage', 'settings.manage', 'user.manage'];
    saved.level = 'SIMPLE';
  });

  it('asks before raising SIMPLE to MEDIUM when members lack direct purchase, and saves only once confirmed', async () => {
    directGaps.mockImplementation(() => ok(GAPS));
    await mount(true);
    await choose('MEDIUM');
    await submit();

    expect(directGaps).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(document.body.textContent).toContain(i18n.t('procurement.directGapsTitle'));
    expect(document.body.textContent).toContain(i18n.t('procurement.directGapsBody'));
    expect(document.body.textContent).toContain('سارة أحمد');
    expect(document.body.textContent).toContain('sara@example.com');
    expect(document.body.textContent).toContain('Omar Ali');
    expect(document.body.textContent).toContain('omar@example.com');
    expect(document.body.textContent).toContain('Accountant');

    act(() => dialogButton(i18n.t('procurement.directGapsConfirm')).click());
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({ procurementLevel: 'MEDIUM' });
  });

  it('asks with company.manage alone (no user.manage), since the gaps list needs that permission', async () => {
    session.permissions = ['company.manage', 'settings.manage'];
    directGaps.mockImplementation(() => ok(GAPS));
    await mount(true);
    await choose('MEDIUM');
    await submit();

    expect(directGaps).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('sara@example.com');
  });

  it('keeps the list scrollable so long lists do not push the buttons off screen', async () => {
    directGaps.mockImplementation(() => ok(GAPS));
    await mount(true);
    await choose('MEDIUM');
    await submit();

    const scroller = [...document.querySelectorAll<HTMLElement>('.ant-modal div')].find(
      (el) => el.style.overflowY === 'auto',
    );
    expect(scroller).toBeDefined();
    expect(scroller!.style.maxHeight).toBe('240px');
    expect(scroller!.querySelectorAll('li')).toHaveLength(2);
  });

  it('keeps the form unsaved when the owner cancels the dialog', async () => {
    directGaps.mockImplementation(() => ok(GAPS));
    await mount(true);
    await choose('MEDIUM');
    await submit();

    act(() => dialogButton(i18n.t('common.cancel')).click());
    await settle();
    expect(update).not.toHaveBeenCalled();
  });

  it('saves directly when no member lacks direct purchase', async () => {
    await mount(true);
    await choose('MEDIUM');
    await submit();

    expect(directGaps).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ant-modal')).toBeNull();
  });

  it('does not ask when the level goes from MEDIUM to FULL', async () => {
    saved.level = 'MEDIUM';
    directGaps.mockImplementation(() => ok(GAPS));
    await mount(true);
    await choose('FULL');
    await submit();

    expect(directGaps).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ant-modal')).toBeNull();
  });
});
