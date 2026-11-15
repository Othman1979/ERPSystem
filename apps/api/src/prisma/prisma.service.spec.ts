import mariadb from 'mariadb';
import { validateEnv } from '../common/config/env.validation.js';
import { DEFAULT_POOL_LIMITS, parseDatabaseUrl, SESSION_CHARSET_SQL, SESSION_INIT_SQL } from './prisma.service.js';
import { POSTING_TX_OPTIONS } from './transaction-options.js';

describe('database pool settings', () => {
  it('reads DATABASE_URL and runs the session setup on every new connection', () => {
    const config = parseDatabaseUrl('mysql://app%40x:p%40ss@db.example:3307/erp');
    expect(config).toMatchObject({
      host: 'db.example',
      port: 3307,
      user: 'app@x',
      password: 'p@ss',
      database: 'erp',
      initSql: [SESSION_CHARSET_SQL, SESSION_INIT_SQL],
    });
  });

  it('sizes the pool from config, with an explicit acquire timeout (DB-07)', () => {
    const config = parseDatabaseUrl('mysql://u:p@db:3306/erp', { size: 4, acquireTimeoutMs: 2_500 });
    expect(config).toMatchObject({ connectionLimit: 4, acquireTimeout: 2_500 });
  });

  it('gives up connecting after 10 s, and never closes a connection for being idle (PLAT-06)', () => {
    const config = parseDatabaseUrl('mysql://u:p@db:3306/erp');
    expect(config.connectTimeout).toBe(10_000);
    // The driver's socketTimeout is an idle timer: it would kill pooled
    // connections and long job statements. Postings are capped by their transaction instead.
    expect(config.socketTimeout ?? 0).toBe(0);
    expect(POSTING_TX_OPTIONS.timeout).toBe(30_000);
  });

  it('defaults to the config schema defaults: 10 connections, 10 s to get one', () => {
    const env = validateEnv({ DATABASE_URL: 'mysql://u:p@db:3306/erp', JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars' });
    expect({ size: env.DB_POOL_SIZE, acquireTimeoutMs: env.DB_POOL_ACQUIRE_TIMEOUT_MS }).toEqual(DEFAULT_POOL_LIMITS);
    expect(parseDatabaseUrl('mysql://u:p@db:3306/erp')).toMatchObject({ connectionLimit: 10, acquireTimeout: 10_000 });
  });

  it('reads DB_POOL_SIZE as a number and refuses nonsense', () => {
    const base = { DATABASE_URL: 'mysql://u:p@db:3306/erp', JWT_ACCESS_SECRET: 'test-secret-at-least-16-chars' };
    expect(validateEnv({ ...base, DB_POOL_SIZE: '2' }).DB_POOL_SIZE).toBe(2);
    expect(() => validateEnv({ ...base, DB_POOL_SIZE: '0' })).toThrow(/DB_POOL_SIZE/);
    expect(() => validateEnv({ ...base, DB_POOL_ACQUIRE_TIMEOUT_MS: 'soon' })).toThrow(/DB_POOL_ACQUIRE_TIMEOUT_MS/);
  });

  it('connects in utf8mb4 / utf8mb4_unicode_ci explicitly, the collation every table uses', () => {
    const config = parseDatabaseUrl('mysql://u:p@db:3306/erp');
    expect(config).toMatchObject({ collation: 'UTF8MB4_UNICODE_CI' });
    // The driver resolves it to that utf8mb4 collation (it throws RangeError on an unknown one).
    const resolved = mariadb.defaultOptions(config) as { collation: { name: string; index: number; maxLength: number } };
    expect([resolved.collation.name, resolved.collation.index, resolved.collation.maxLength]).toEqual(['UTF8MB4_UNICODE_CI', 224, 4]);
    // No `charset` beside it: mariadb 3.5.4 would then replace the collation with utf8mb4_general_ci.
    expect(config.charset).toBeUndefined();
    const both = mariadb.defaultOptions({ ...config, charset: 'utf8mb4' }) as { collation: { name: string } };
    expect(both.collation.name).toBe('UTF8MB4_GENERAL_CI');
    // And as the first statement of every connection, whatever the server makes of the handshake.
    expect(config.initSql).toEqual(['SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci', SESSION_INIT_SQL]);
  });

  it('turns snapshot isolation off only where MariaDB has it (11.6.2+), harmless elsewhere', () => {
    // A plain SET for older MariaDB / MySQL; the rest only inside a MariaDB version comment.
    expect(SESSION_INIT_SQL.startsWith('SET @erp_si = 0 ')).toBe(true);
    expect(SESSION_INIT_SQL).toContain('/*M!110602 , SESSION innodb_snapshot_isolation = OFF */');
  });
});
