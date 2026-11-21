// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '@erp/api-client';
import { LOCK_STATUS_MS } from '../liveRefresh';
import { useDocumentLockStatus } from './useDocumentLockStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;
let client: QueryClient | undefined;

function Harness() {
  useDocumentLockStatus('JOURNAL_ENTRY', '42', true);
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  client?.clear();
  window.sessionStorage.removeItem('erp:edit-lock-token');
  vi.restoreAllMocks();
  vi.useRealTimers();
  host?.remove();
  document.body.innerHTML = '';
});

describe('useDocumentLockStatus', () => {
  it('polls the lock status on the configured interval', async () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem('erp:edit-lock-token', 'lock-token-42');
    vi.spyOn(api, 'documentLocksControllerStatus').mockResolvedValue({
      data: { holder: null },
    } as never);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        <QueryClientProvider client={client!}>
          <Harness />
        </QueryClientProvider>,
      );
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(api.documentLocksControllerStatus).toHaveBeenCalledTimes(1);
    expect(api.documentLocksControllerStatus).toHaveBeenCalledWith(
      'JOURNAL_ENTRY',
      '42',
      expect.objectContaining({ headers: { 'X-Edit-Lock': 'lock-token-42' } }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOCK_STATUS_MS);
    });
    expect(api.documentLocksControllerStatus).toHaveBeenCalledTimes(2);
  });
});
