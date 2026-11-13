/**
 * Options for every interactive transaction that posts, reverses or approves
 * (CLAUDE.md «الترحيل», BUILD_PLAN §10.1/§10.2). Prisma's defaults (5 s run,
 * 2 s to get a connection) are too short for a large document on shared
 * hosting or one that waits on another posting's row locks; past `timeout`
 * Prisma rolls back and the request fails with P2028.
 *
 * P2028 is deliberately NOT retried by DocumentSupportService.withRetry: the
 * timeout can fire while COMMIT is in flight, so a retry could post twice.
 * test/static/posting-transactions.spec.ts fails if a posting service opens an
 * interactive transaction without these options.
 */
// maxWait: time to get one of the pool's connections (DB_POOL_SIZE, 10 by
// default) while other postings hold theirs (PLAT-05).
export const POSTING_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;
