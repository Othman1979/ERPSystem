import { validateEnv } from '../common/config/env.validation.js';
import { DEFAULT_POOL_LIMITS, parseDatabaseUrl, SESSION_INIT_SQL } from './prisma.service.js';

describe('database pool settings', () => {
  it('reads DATABASE_URL and runs the session setup on every new connection', () => {
    const config = parseDatabaseUrl('mysql://app%40x:p%40ss@db.example:3307/erp');
    expect(config).toMatchObject({
      host: 'db.example',
      port: 3307,
      user: 'app@x',
      password: 'p@ss',
      database: 'erp',
      initSql: SESSION_INIT_SQL,
    });
  });

  it('sizes the pool from config, with an explicit acquire timeout (DB-07)', () => {
    const config = parseDatabaseUrl('mysql://u:p@db:3306/erp', { size: 4, acquireTimeoutMs: 2_500 });
    expect(config).toMatchObject({ connectionLimit: 4, acquireTimeout: 2_500 });
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

  it('turns snapshot isolation off only where MariaDB has it (11.6.2+), harmless elsewhere', () => {
    // A plain SET for older MariaDB / MySQL; the rest only inside a MariaDB version comment.
    expect(SESSION_INIT_SQL.startsWith('SET @erp_si = 0 ')).toBe(true);
    expect(SESSION_INIT_SQL).toContain('/*M!110602 , SESSION innodb_snapshot_isolation = OFF */');
  });
});
