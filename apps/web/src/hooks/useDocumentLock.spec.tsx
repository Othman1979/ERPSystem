// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@erp/api-client';
import { useDocumentLock, type DocumentLockState } from './useDocumentLock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;
let current: { state: DocumentLockState; headers: Record<string, string> } | undefined;

function Harness({ enabled = true }: { enabled?: boolean }) {
  const lock = useDocumentLock('JOURNAL_ENTRY', '42', enabled);
  current = { state: lock.state, headers: lock.headers };
  return null;
}

function mount(enabled = true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness enabled={enabled} />));
}

beforeEach(() => {
  sessionStorage.clear();
  current = undefined;
  vi.spyOn(api, 'documentLocksControllerAcquire').mockResolvedValue({} as never);
  vi.spyOn(api, 'documentLocksControllerHeartbeat').mockResolvedValue({} as never);
  vi.spyOn(api, 'documentLocksControllerRelease').mockResolvedValue({} as never);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  host?.remove();
  document.body.innerHTML = '';
});

describe('useDocumentLock', () => {
  it('acquires with the tab token and heartbeats every 30 seconds', async () => {
    vi.useFakeTimers();
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    expect(current?.state.status).toBe('held');
    const token = sessionStorage.getItem('erp:edit-lock-token');
    expect(token).toBeTruthy();
    expect(api.documentLocksControllerAcquire).toHaveBeenCalledWith(
      'JOURNAL_ENTRY',
      '42',
      { headers: { 'X-Edit-Lock': token } },
    );
    expect(current?.headers).toEqual({ 'X-Edit-Lock': token });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.documentLocksControllerHeartbeat).toHaveBeenCalledWith(
      'JOURNAL_ENTRY',
      '42',
      { headers: { 'X-Edit-Lock': token } },
    );
  });

  it('moves to lost when a heartbeat returns 409', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'documentLocksControllerHeartbeat').mockRejectedValue(
      new api.ApiError(409, 'DOCUMENT_LOCK_REQUIRED', 'lock expired'),
    );
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(current?.state.status).toBe('lost');
  });

  it('reconnects after a transient heartbeat error', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'documentLocksControllerHeartbeat')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({} as never);
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    expect(current?.state.status).toBe('held');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(current?.state.status).toBe('reconnecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(current?.state.status).toBe('held');
    expect(api.documentLocksControllerHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('releases on unmount and sends keepalive on pagehide', async () => {
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    const token = sessionStorage.getItem('erp:edit-lock-token');
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(api.documentLocksControllerRelease).toHaveBeenCalledWith(
      'JOURNAL_ENTRY',
      '42',
      { headers: { 'X-Edit-Lock': token }, keepalive: true },
    );

    act(() => root?.unmount());
    root = undefined;
    expect(api.documentLocksControllerRelease).toHaveBeenCalledTimes(1);
  });

  it('releases the current holder when unmounted', async () => {
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    act(() => root?.unmount());
    root = undefined;
    expect(api.documentLocksControllerRelease).toHaveBeenCalledWith(
      'JOURNAL_ENTRY',
      '42',
      { headers: { 'X-Edit-Lock': sessionStorage.getItem('erp:edit-lock-token') } },
    );
  });
});
