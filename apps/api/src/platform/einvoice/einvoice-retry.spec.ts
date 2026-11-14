import { retryWrite, WRITE_ATTEMPTS } from './einvoice-retry.js';

const noWait = () => Promise.resolve();
const deadlock = () =>
  Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), {
    code: 'P2034',
  });

/** A write that fails with each of `failures` in turn, then returns 'ok'; `calls` counts the tries. */
function writeFailing(failures: Error[]) {
  const state = { calls: 0 };
  const write = async () => {
    state.calls += 1;
    const err = failures[state.calls - 1];
    if (err) throw err;
    return 'ok';
  };
  return { state, write };
}

describe('retryWrite', () => {
  it('returns at once when the write works', async () => {
    const { state, write } = writeFailing([]);
    await expect(retryWrite(write, noWait)).resolves.toBe('ok');
    expect(state.calls).toBe(1);
  });

  it('runs a deadlock victim again until it works, with a growing random wait', async () => {
    const { state, write } = writeFailing([deadlock(), deadlock()]);
    const waits: number[] = [];
    await expect(retryWrite(write, async (ms) => void waits.push(ms))).resolves.toBe('ok');
    expect(state.calls).toBe(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(20);
    expect(waits[0]).toBeLessThan(100);
    expect(waits[1]).toBeGreaterThanOrEqual(40);
    expect(waits[1]).toBeLessThan(200);
  });

  it.each([
    ['a MariaDB deadlock message', new Error('Deadlock found when trying to get lock; try restarting transaction (1213)')],
    ['a lock wait timeout', new Error('Lock wait timeout exceeded; try restarting transaction')],
  ])('also retries %s', async (_name, err) => {
    const { state, write } = writeFailing([err]);
    await expect(retryWrite(write, noWait)).resolves.toBe('ok');
    expect(state.calls).toBe(2);
  });

  it('gives up after a bounded number of tries and throws the original error', async () => {
    const err = deadlock();
    const { state, write } = writeFailing(Array(WRITE_ATTEMPTS + 3).fill(err));
    await expect(retryWrite(write, noWait)).rejects.toBe(err);
    expect(state.calls).toBe(WRITE_ATTEMPTS);
  });

  it('does not retry any other error', async () => {
    const err = new Error('Unique constraint failed');
    const { state, write } = writeFailing([err]);
    await expect(retryWrite(write, noWait)).rejects.toBe(err);
    expect(state.calls).toBe(1);
  });
});
