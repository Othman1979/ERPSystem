import type { Prisma } from '../../generated/prisma/client.js';
import type { PageWindow } from './page-query.dto.js';

/** Response of a numbered list (ADR-022 §3). */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Anything that runs an interactive transaction: a (tenant-scoped) Prisma client. */
export interface TransactionRunner {
  $transaction<R>(fn: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R>;
}

export interface PageReader<T> {
  /** The page's rows, with the list's where/orderBy and the given window. */
  rows: (tx: Prisma.TransactionClient, window: { skip: number; take: number }) => Promise<T[]>;
  /** How many rows match the same where. */
  count: (tx: Prisma.TransactionClient) => Promise<number>;
}

/**
 * One numbered page and its total (ADR-022 §3). Both reads run on one
 * connection in one read transaction, so InnoDB's REPEATABLE READ snapshot
 * makes `total` agree with `items` even if a document is posted in between.
 * The COUNT is skipped when the page itself tells the total: a short,
 * non-empty page is the last one, and an empty first page means none. A page
 * past the end is not an error: it answers `items: []` with the real total.
 */
export async function findPage<T>(db: TransactionRunner, window: PageWindow, read: PageReader<T>): Promise<Page<T>> {
  const { page, pageSize } = window;
  const skip = (page - 1) * pageSize;
  return db.$transaction(async (tx) => {
    const items = await read.rows(tx, { skip, take: pageSize });
    let total: number;
    if (items.length > 0 && items.length < pageSize) total = skip + items.length;
    else if (items.length === 0 && page === 1) total = 0;
    else total = await read.count(tx);
    return { items, page, pageSize, total };
  });
}

/** The same page with each row mapped (e.g. to add computed balances). */
export async function mapPage<T, U>(p: Page<T>, fn: (items: T[]) => U[] | Promise<U[]>): Promise<Page<U>> {
  return { ...p, items: await fn(p.items) };
}
