// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { useDocShortcuts } from './DocLayout';
import { PartyFormDialog } from './PartyFormDialog';
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

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

function DocumentWithPartyDialog({ onSave }: { onSave: () => void }) {
  useDocShortcuts({ onSave });
  return <PartyFormDialog open onSaved={vi.fn()} onCancel={vi.fn()} />;
}

describe('document shortcuts in modal dialogs', () => {
  it('does not run the document save shortcut inside an open PartyFormDialog', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onDocumentSave = vi.fn();
    act(() =>
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <DocumentWithPartyDialog onSave={onDocumentSave} />
        </QueryClientProvider>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    const input = document.querySelector<HTMLInputElement>('.ant-modal-root input')!;
    expect(input).toBeTruthy();
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          code: 'KeyS',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );

    expect(onDocumentSave).not.toHaveBeenCalled();
  });
});
