import 'dotenv/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import mariadb, { type Pool } from 'mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { parseDatabaseUrl } from '../prisma/prisma.service.js';
import { probeDatabase } from './db-probe.js';
import { testDatabaseUrl } from '../../test/e2e/support/test-db.js';

/** The real test database: the same server as DATABASE_URL, the e2e schema (test/e2e/support/test-db.ts). */
const testUrl = testDatabaseUrl();

function connect(url: string): { client: PrismaClient; pool: Pool } {
  const pool = mariadb.createPool(parseDatabaseUrl(url));
  return { client: new PrismaClient({ adapter: new PrismaMariaDb(pool) }), pool };
}

describe('database probe: can the database write and use its temp directory (PLAT-31)', () => {
  const live = connect(testUrl);
  const deadUrl = (() => {
    const u = new URL(testUrl);
    u.hostname = '127.0.0.1';
    u.port = '3999'; // nothing listens here
    return u.toString();
  })();
  const dead = connect(deadUrl);

  // The probe row is written and rolled back: its fingerprint never survives.
  const probeRows = async (): Promise<number> => {
    const [row] = await live.client.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM error_events WHERE fingerprint LIKE 'health-probe:%'`;
    return Number(row.n);
  };

  afterAll(async () => {
    // The 1 ms probe leaves its transaction to finish in the background: let it
    // end before the pools close, and close every handle even if one fails.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.allSettled([
      dead.client.$disconnect(),
      dead.pool.end(),
      live.client.$disconnect(),
      live.pool.end(),
    ]);
  }, 30000);

  it('succeeds against the live database, with the temp table check run', async () => {
    const result = await probeDatabase(live.client, 5000);

    expect(result).toMatchObject({ ok: true, tmpdir: 'ok' });
  }, 15000);

  it('leaves no probe row behind (the transaction is rolled back)', async () => {
    const before = await probeRows();

    await probeDatabase(live.client, 5000);
    await probeDatabase(live.client, 5000);

    expect(await probeRows()).toBe(before);
  }, 15000);

  it('fails within about 3 seconds when nothing listens on the port', async () => {
    const result = await probeDatabase(dead.client, 2000);

    expect(result.ok).toBe(false);
    expect(result.ms).toBeLessThan(3000);
    if (!result.ok) expect(result.reason).toMatch(/^(errno |timed out)/);
  }, 15000);

  it('a timeout of 1 ms reports a timeout, not a connection', async () => {
    const result = await probeDatabase(live.client, 1);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected a timeout');
    expect(result.reason).toContain('timed out');
  }, 15000);
});
