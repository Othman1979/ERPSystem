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

const { createAccount, accounts } = vi.hoisted(() => ({
  createAccount: vi.fn(),
  accounts: [
    {
      id: '1',
      code: '1102',
      nameAr: 'البنوك',
      nameEn: 'Banks',
      parentId: null,
      level: 1,
      accountType: 'ASSET',
      normalBalance: 'DEBIT',
      isActive: true,
      isPostable: true,
      isControl: false,
      controlType: 'BANK',
      costCenterRequired: false,
      cashFlowActivity: null,
    },
  ],
}));

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  accountingControllerCreateAccount: createAccount,
  accountingControllerUpdateAccount: vi.fn(),
}));
vi.mock('../hooks/useAccounts', () => ({
  ACCOUNTS_QUERY_KEY: ['accounts'],
  useAccounts: () => ({ data: accounts }),
}));
vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: false }),
}));

const { AccountFormDialog, isValidChildAccountCode } = await import('./AccountFormDialog');
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
  createAccount.mockReset();
});

const settle = (ms = 60) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

async function renderDialog() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AntApp>
          <AccountFormDialog
            open
            initialValues={{ parentId: '1', accountType: 'ASSET', nameAr: 'Child account' }}
            onSaved={() => undefined}
            onCancel={() => undefined}
          />
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function childCodeInput(): HTMLInputElement {
  return [...document.querySelectorAll<HTMLInputElement>('.ant-modal input')].find(
    (input) => input.value.length > 0 && input.value.startsWith('1102'),
  )!;
}

describe('AccountFormDialog child codes', () => {
  it('prefills the automatic child code and validates its parent prefix', async () => {
    await renderDialog();
    const input = childCodeInput();
    expect(input.value).toBe('1102-01');
    expect(isValidChildAccountCode(input.value, '1102')).toBe(true);
    expect(isValidChildAccountCode('1102', '1102')).toBe(false);
    expect(isValidChildAccountCode('999', '1102')).toBe(false);
  });

  it('lets the server allocate the code when the suggestion is unchanged', async () => {
    createAccount.mockResolvedValue({
      data: {
        id: '2',
        code: '1102-01',
        movedLinks: { mappings: 0, cashBoxes: 0, bankAccounts: 0, payElements: 0 },
      },
      status: 201,
      headers: new Headers(),
    });
    await renderDialog();
    const save = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal button')].find((button) =>
      button.textContent?.includes(i18n.t('common.save')),
    )!;
    act(() => save.click());
    await settle();

    expect(createAccount).toHaveBeenCalled();
    const body = createAccount.mock.calls[0][0] as { code?: string; parentId?: string };
    expect(body).toMatchObject({ code: undefined, parentId: '1' });
  });
});
