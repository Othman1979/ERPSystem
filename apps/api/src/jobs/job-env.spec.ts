import { validateEnv } from '../common/config/env.validation.js';
import { parseDatabaseUrl } from '../prisma/prisma.service.js';
import { applyJobEnv } from './job-env.js';

const base = { DATABASE_URL: 'mysql://u:p@db:3306/erp', JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars' };

/** The pool a process gets from its environment, as PrismaService builds it. */
function pool(env: Record<string, string | undefined>) {
  const e = validateEnv(env);
  return parseDatabaseUrl(e.DATABASE_URL, { size: e.DB_POOL_SIZE, acquireTimeoutMs: e.DB_POOL_ACQUIRE_TIMEOUT_MS });
}

describe('pool size per process (DB-07)', () => {
  it('the API keeps the configured default of 10 connections', () => {
    expect(pool({ ...base }).connectionLimit).toBe(10);
  });

  it('a Cron command gets 2 unless its own line asks for more', () => {
    const job: NodeJS.ProcessEnv = { ...base };
    applyJobEnv(job);
    expect(pool(job).connectionLimit).toBe(2);

    const empty: NodeJS.ProcessEnv = { ...base, DB_POOL_SIZE: '' };
    applyJobEnv(empty);
    expect(pool(empty).connectionLimit).toBe(2);

    const asked: NodeJS.ProcessEnv = { ...base, DB_POOL_SIZE: '4' };
    applyJobEnv(asked);
    expect(pool(asked).connectionLimit).toBe(4);
  });

  it('neither has an idle socket timer (PLAT-06)', () => {
    const job: NodeJS.ProcessEnv = { ...base };
    applyJobEnv(job);
    for (const config of [pool({ ...base }), pool(job)]) {
      expect(config.socketTimeout ?? 0).toBe(0);
      expect(config.connectTimeout).toBe(10_000);
    }
  });
});
