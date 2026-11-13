import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { retryDelay, ServerUnreachable } from './ServerUnreachable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ServerUnreachable (WEB-04)', () => {
  let root: Root;
  let container: HTMLDivElement;
  // The server stays down: each retry finishes and the screen stays.
  const onRetry = vi.fn(async () => {});
  const onSignOut = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    onRetry.mockClear();
    onSignOut.mockClear();
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root.render(<ServerUnreachable onRetry={onRetry} onSignOut={onSignOut} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  // One act per second: each tick re-renders, and the next timer is set by the effect that follows.
  async function tick(seconds: number) {
    for (let i = 0; i < seconds; i += 1) await act(() => vi.advanceTimersByTimeAsync(1000));
  }

  it('says the server is unreachable, not that the session ended', () => {
    expect(container.textContent).toContain(i18n.t('connection.title'));
    expect(container.textContent).toContain(i18n.t('connection.autoRetry', { seconds: 2 }));
  });

  it('retries on its own with a growing delay', async () => {
    await tick(1);
    expect(onRetry).toHaveBeenCalledTimes(0);
    await tick(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(i18n.t('connection.autoRetry', { seconds: 4 }));
    await tick(4);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('retries at once when the browser comes back online, and on the button', async () => {
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelectorAll('button')[0].click());
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('offers a way out to the sign-in screen', async () => {
    await act(async () => container.querySelectorAll('button')[1].click());
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(i18n.t('auth.logout'));
  });

  it('caps the delay', () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelay)).toEqual([2, 4, 8, 15, 30, 30]);
  });
});
