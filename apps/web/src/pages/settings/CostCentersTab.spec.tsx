// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { costCenterTree } from './costCenterTree';
import type { CostCenterDto } from '@erp/api-client';

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

const centre = (over: Partial<CostCenterDto> & Pick<CostCenterDto, 'id' | 'code' | 'nameAr'>): CostCenterDto => ({
  tenantId: '1',
  companyId: '1',
  nameEn: null,
  parentId: null,
  isPostable: true,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: null,
  updatedBy: null,
  ...over,
});

const ROWS: CostCenterDto[] = [
  // Flat list, deliberately out of code order: the tree must sort siblings.
  centre({ id: '2', code: '10-02', nameAr: 'الشحن', nameEn: 'Shipping', parentId: '1' }),
  centre({ id: '1', code: '10', nameAr: 'العمليات', nameEn: 'Operations', isPostable: false }),
  centre({ id: '3', code: '20', nameAr: 'التسويق', nameEn: 'Marketing' }),
  centre({ id: '4', code: '10-01', nameAr: 'المستودع', nameEn: 'Warehouse', parentId: '1' }),
];

let companyEnabled = true;
let canManage = true;
const listCentres = vi.fn();
const createCentre = vi.fn();
const updateCentre = vi.fn();
const removeCentre = vi.fn();

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  companyControllerGet: () =>
    ok({ id: '1', legalNameAr: 'شركة', costCentersEnabled: companyEnabled, logo: null }),
  costCentersControllerList: () => listCentres(),
  costCentersControllerCreate: (...args: unknown[]) => createCentre(...args),
  costCentersControllerUpdate: (...args: unknown[]) => updateCentre(...args),
  costCentersControllerRemove: (...args: unknown[]) => removeCentre(...args),
}));

vi.mock('../../auth/AuthContext', async (original) => ({
  ...(await original<typeof import('../../auth/AuthContext')>()),
  useAuth: () => ({ can: () => canManage }),
}));

const { CostCentersTab } = await import('./CostCentersTab');

let root: Root | undefined;
let host: HTMLDivElement;
let client: QueryClient;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  companyEnabled = true;
  canManage = true;
  listCentres.mockReset();
  listCentres.mockImplementation(() => ok(ROWS));
  createCentre.mockReset();
  createCentre.mockImplementation(() => ok({}));
  updateCentre.mockReset();
  removeCentre.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
  client.clear();
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>
            <CostCentersTab />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const buttonNamed = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

/** The dialog's primary Save button (its label carries a Ctrl+S hint). */
const saveButton = () => document.querySelector<HTMLButtonElement>('.form-dialog-footer button');

/** Sets a controlled antd input the way a user types into it. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('costCenterTree', () => {
  it('nests children under their parent and sorts siblings by code', () => {
    const tree = costCenterTree(ROWS);
    expect(tree.map((n) => n.code)).toEqual(['10', '20']);
    expect(tree[0].children?.map((n) => n.code)).toEqual(['10-01', '10-02']);
    expect(tree[1].children).toBeUndefined();
  });

  it('keeps a centre whose parent is missing from the list as a root', () => {
    const tree = costCenterTree([centre({ id: '9', code: '90', nameAr: 'يتيم', parentId: 'gone' })]);
    expect(tree.map((n) => n.id)).toEqual(['9']);
  });
});

describe('CostCentersTab', () => {
  it('renders the parent and its sub-centre from the flat list', async () => {
    await render();
    const text = host.textContent ?? '';
    expect(text).toContain('Operations');
    expect(text).toContain('Shipping');
    expect(text).toContain('Warehouse');
    expect(text).toContain('Marketing');
    // The parent is a group (it has children); the sub-centres are leaves.
    expect(text).toContain('Group');
    expect(text).toContain('Leaf');
    expect(listCentres).toHaveBeenCalled();
  });

  it('shows the disabled note while the company switch is off, but still lists the tree', async () => {
    companyEnabled = false;
    await render();
    expect(document.body.textContent).toContain(i18n.t('costCenters.disabledNote'));
    expect(host.textContent).toContain('Operations');
  });

  it('hides the disabled note when the switch is on', async () => {
    await render();
    expect(document.body.textContent).not.toContain(i18n.t('costCenters.disabledNote'));
  });

  it('shows the empty state when there are no centres', async () => {
    listCentres.mockImplementation(() => ok([]));
    await render();
    expect(host.textContent).toContain(i18n.t('costCenters.empty'));
  });

  it('creates a root centre with the code and names typed, and no parent', async () => {
    await render();
    act(() => buttonNamed(host, 'New centre')!.click());
    await settle();

    const code = document.querySelector<HTMLInputElement>('#code')!;
    const nameAr = document.querySelector<HTMLInputElement>('#nameAr')!;
    type(code, '30');
    type(nameAr, 'الإدارة');
    act(() => saveButton()?.click());
    await settle();

    expect(createCentre).toHaveBeenCalledTimes(1);
    expect(createCentre.mock.calls[0][0]).toEqual({ code: '30', nameAr: 'الإدارة' });
  });

  it('creates a sub-centre under the chosen row with parentId set', async () => {
    await render();
    const row = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('Marketing'))!;
    act(() => buttonNamed(row, 'Sub-centre')!.click());
    await settle();

    const code = document.querySelector<HTMLInputElement>('#code')!;
    const nameAr = document.querySelector<HTMLInputElement>('#nameAr')!;
    type(code, '20-01');
    type(nameAr, 'الإعلان');
    act(() => saveButton()?.click());
    await settle();

    expect(createCentre.mock.calls[0][0]).toEqual({ code: '20-01', nameAr: 'الإعلان', parentId: '3' });
  });

  it('hides every action without the cost_center.manage permission', async () => {
    canManage = false;
    await render();
    expect(buttonNamed(host, 'New centre')).toBeUndefined();
    expect(buttonNamed(host, 'Delete')).toBeUndefined();
    expect(host.textContent).toContain('Operations');
  });
});
