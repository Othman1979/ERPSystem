import type { Prisma } from '../../generated/prisma/client.js';
import { findPage, mapPage, type Page, type PageReader, type TransactionRunner } from './find-page.js';

/** A stand-in for the interactive transaction client; compared by identity. */
const tx = { marker: 'tx' } as unknown as Prisma.TransactionClient;

/** A runner whose $transaction hands the same tx to the callback. */
const db: TransactionRunner = {
  $transaction: (fn) => fn(tx),
};

/** A function that records the arguments of each call (a counter, as jest.fn would). */
function counted<A extends unknown[], R>(impl: (...args: A) => Promise<R>) {
  const calls: A[] = [];
  const fn = (...args: A): Promise<R> => {
    calls.push(args);
    return impl(...args);
  };
  return { fn, calls };
}

/** Reader with counters: `rows` returns the given items, `count` the given total. */
function reader(items: number[], total: number) {
  const rows = counted((_tx: Prisma.TransactionClient, _window: { skip: number; take: number }) =>
    Promise.resolve(items),
  );
  const count = counted((_tx: Prisma.TransactionClient) => Promise.resolve(total));
  const read: PageReader<number> = { rows: rows.fn, count: count.fn };
  return { rows, count, read };
}

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('findPage', () => {
  it('counts the total when the page is full', async () => {
    const { count, read } = reader(rowsOf(20), 57);
    const page = await findPage(db, { page: 1, pageSize: 20 }, read);
    expect(count.calls).toHaveLength(1);
    expect(page.total).toBe(57);
  });

  it('skips the count on a short, non-empty page and derives the total', async () => {
    const { count, read } = reader(rowsOf(3), 999);
    const page = await findPage(db, { page: 2, pageSize: 20 }, read);
    expect(count.calls).toHaveLength(0);
    expect(page).toEqual({ items: [0, 1, 2], page: 2, pageSize: 20, total: 23 });
  });

  it('answers total 0 on an empty first page without counting', async () => {
    const { count, read } = reader([], 5);
    const page = await findPage(db, { page: 1, pageSize: 20 }, read);
    expect(count.calls).toHaveLength(0);
    expect(page).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
  });

  it('answers an empty page past the end with the real total, not an error', async () => {
    const { count, read } = reader([], 42);
    const page = await findPage(db, { page: 5, pageSize: 20 }, read);
    expect(count.calls).toHaveLength(1);
    expect(page).toEqual({ items: [], page: 5, pageSize: 20, total: 42 });
  });

  it('asks the rows for the window: skip (page - 1) * pageSize, take pageSize', async () => {
    const { rows, read } = reader(rowsOf(10), 100);
    await findPage(db, { page: 3, pageSize: 10 }, read);
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0][1]).toEqual({ skip: 20, take: 10 });
  });

  it('runs rows and count on the transaction client that $transaction passed', async () => {
    const { rows, count, read } = reader(rowsOf(20), 57);
    await findPage(db, { page: 1, pageSize: 20 }, read);
    expect(rows.calls[0][0]).toBe(tx);
    expect(count.calls[0][0]).toBe(tx);
  });
});

describe('mapPage', () => {
  const p: Page<number> = { items: [1, 2, 3], page: 2, pageSize: 3, total: 9 };

  it('maps the items and keeps page, pageSize and total', async () => {
    const mapped = await mapPage(p, (xs) => xs.map((x) => `#${x}`));
    expect(mapped).toEqual({ items: ['#1', '#2', '#3'], page: 2, pageSize: 3, total: 9 });
  });

  it('awaits an asynchronous mapper', async () => {
    const mapped = await mapPage(p, async (xs) => xs.map((x) => x * 10));
    expect(mapped).toEqual({ items: [10, 20, 30], page: 2, pageSize: 3, total: 9 });
  });
});
