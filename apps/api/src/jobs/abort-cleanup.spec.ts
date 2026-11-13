import { onAbort, runAbortCleanups } from './abort-cleanup.js';

describe('abort cleanups', () => {
  it('runs every registered cleanup in order, then forgets them', async () => {
    const calls: string[] = [];
    onAbort(() => {
      calls.push('a');
    });
    onAbort(async () => {
      await Promise.resolve();
      calls.push('b');
    });
    await runAbortCleanups();
    expect(calls).toEqual(['a', 'b']);
    await runAbortCleanups();
    expect(calls).toEqual(['a', 'b']);
  });

  it('an unregistered cleanup does not run', async () => {
    const calls: string[] = [];
    const unregister = onAbort(() => {
      calls.push('gone');
    });
    onAbort(() => {
      calls.push('kept');
    });
    unregister();
    await runAbortCleanups();
    expect(calls).toEqual(['kept']);
  });

  it('a failing cleanup does not stop the others', async () => {
    const calls: string[] = [];
    onAbort(() => {
      throw new Error('boom');
    });
    onAbort(async () => {
      throw new Error('async boom');
    });
    onAbort(() => {
      calls.push('after');
    });
    await expect(runAbortCleanups()).resolves.toBeUndefined();
    expect(calls).toEqual(['after']);
  });

  it('the same function registered twice runs twice, and unregistering one keeps the other', async () => {
    const calls: number[] = [];
    const fn = () => {
      calls.push(1);
    };
    const first = onAbort(fn);
    onAbort(fn);
    first();
    await runAbortCleanups();
    expect(calls).toEqual([1]);
  });
});
