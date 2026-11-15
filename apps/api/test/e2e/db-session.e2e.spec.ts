/**
 * The pool's session settings on a real server (prisma.service.ts): every
 * pooled connection is utf8mb4 / utf8mb4_unicode_ci, whatever the server's
 * own default (MariaDB 11.2+ may map utf8mb4 to uca1400 by default).
 * Real MariaDB (erp_test), read-only.
 */
import 'dotenv/config';
import mariadb, { type Pool } from 'mariadb';
import { parseDatabaseUrl } from '../../src/prisma/prisma.service.js';
import { testDatabaseUrl } from './support/test-db.js';

let pool: Pool;

beforeAll(() => {
  pool = mariadb.createPool(parseDatabaseUrl(testDatabaseUrl(), { size: 2, acquireTimeoutMs: 10_000 }));
});

afterAll(async () => {
  await pool.end();
});

describe('pooled connections (S4)', () => {
  it('report utf8mb4 / utf8mb4_unicode_ci for the connection, client and results', async () => {
    // Two connections at once: each runs initSql, not only the first.
    const [a, b] = await Promise.all([pool.getConnection(), pool.getConnection()]);
    try {
      for (const conn of [a, b]) {
        const [row] = (await conn.query(
          'SELECT @@collation_connection AS co, @@character_set_connection AS cs, @@character_set_client AS cl, @@character_set_results AS rs',
        )) as { co: string; cs: string; cl: string; rs: string }[];
        expect(row).toEqual({ co: 'utf8mb4_unicode_ci', cs: 'utf8mb4', cl: 'utf8mb4', rs: 'utf8mb4' });
      }
    } finally {
      await Promise.all([a.release(), b.release()]);
    }
  });
});
