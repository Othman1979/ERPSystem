// @vitest-environment jsdom
import { act } from 'react';
import { Modal } from 'antd';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { entryDraftStorageKey, useEntryDraft, type EntryDraftScope } from './useEntryDraft';

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

const scope: EntryDraftScope = {
  userId: 'user-a',
  tenantId: 'tenant-a',
  companyId: 'company-a',
  screenKey: 'journal:new',
};

let root: Root | undefined;
let host: HTMLDivElement;
let current: { value: { description: string }; clear: () => void } | undefined;
let restored: unknown;
function Harness({ activeScope = scope }: { activeScope?: EntryDraftScope }) {
  const value = { description: 'changed' };
  const draft = useEntryDraft({
    scope: activeScope,
    value,
    initialValue: { description: '' },
    onRestore: (value) => {
      restored = value;
    },
  });
  current = { value, clear: draft.clear };
  return null;
}
function mount(activeScope = scope) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness activeScope={activeScope} />));
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  localStorage.clear();
  restored = undefined;
  current = undefined;
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  host?.remove();
  document.body.innerHTML = '';
});

describe('entry draft scope', () => {
  it('keys drafts by user, tenant, company and screen', () => {
    expect(entryDraftStorageKey(scope)).toBe('erp:entry-draft:v1:user-a:tenant-a:company-a:journal:new');
    expect(entryDraftStorageKey({ ...scope, userId: 'user-b' })).not.toBe(entryDraftStorageKey(scope));
    expect(entryDraftStorageKey({ ...scope, tenantId: 'tenant-b' })).not.toBe(entryDraftStorageKey(scope));
    expect(entryDraftStorageKey({ ...scope, companyId: 'company-b' })).not.toBe(entryDraftStorageKey(scope));
    expect(entryDraftStorageKey({ ...scope, screenKey: 'receipt:new' })).not.toBe(entryDraftStorageKey(scope));
    expect(entryDraftStorageKey({ ...scope, companyId: null })).toBeNull();
  });
});

describe('useEntryDraft storage', () => {
  it('debounces writes and clears the scoped draft', async () => {
    vi.useFakeTimers();
    mount();
    const key = entryDraftStorageKey(scope)!;
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(localStorage.getItem(key)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(JSON.parse(localStorage.getItem(key)!).data).toEqual({ description: 'changed' });
    act(() => current!.clear());
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('removes expired drafts', () => {
    const key = entryDraftStorageKey(scope)!;
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, data: { x: 1 } }));
    mount();
    act(() => {});
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('removes corrupt JSON', () => {
    const key = entryDraftStorageKey(scope)!;
    localStorage.setItem(key, '{broken');
    mount();
    act(() => {});
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('restores a valid draft after confirmation', () => {
    const key = entryDraftStorageKey(scope)!;
    localStorage.setItem(
      key,
      JSON.stringify({ savedAt: Date.now(), data: { description: 'restored' } }),
    );
    const confirm = vi.spyOn(Modal, 'confirm').mockImplementation((options) => {
      options.onOk?.();
      return { destroy: vi.fn() } as unknown as ReturnType<typeof Modal.confirm>;
    });
    mount();
    expect(confirm).toHaveBeenCalled();
    expect(restored).toEqual({ description: 'restored' });
  });
});
