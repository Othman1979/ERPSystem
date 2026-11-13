import { existsSync, readFileSync } from 'node:fs';
import { dbTarget, sameDatabase, withOptionFile } from './mysql-tools.js';

describe('database client helpers (ADR-010 §10.2)', () => {
  it('reads a DATABASE_URL, decoding the credentials', () => {
    expect(dbTarget('mysql://app%40x:p%40ss%22w@db.example:3307/erp_prod')).toEqual({
      host: 'db.example',
      port: 3307,
      user: 'app@x',
      password: 'p@ss"w',
      database: 'erp_prod',
    });
    expect(dbTarget('mysql://root@localhost/erp').port).toBe(3306);
  });

  it('refuses a database name that is not a plain identifier', () => {
    expect(() => dbTarget('mysql://root@localhost/erp`; DROP')).toThrow(/Unsupported database name/);
  });

  it('knows the same database on the same server', () => {
    const a = dbTarget('mysql://root@localhost:3306/ERP');
    expect(sameDatabase(a, dbTarget('mysql://other@127.0.0.1:3306/erp'))).toBe(true);
    expect(sameDatabase(a, dbTarget('mysql://root@localhost:3307/erp'))).toBe(false);
    expect(sameDatabase(a, dbTarget('mysql://root@localhost:3306/erp_restore'))).toBe(false);
  });

  it('keeps the password in a private option file, quoted, removed afterwards', async () => {
    const target = dbTarget('mysql://root:a%5Cb%22c@localhost:3306/erp');
    let seen = '';
    const file = await withOptionFile(target, async (f) => {
      seen = readFileSync(f, 'utf8');
      return f;
    });
    expect(seen).toContain('[client]');
    // TCP like the app's driver: never the local socket for host=localhost.
    expect(seen).toContain('protocol=TCP');
    expect(seen).toContain('password="a\\\\b\\"c"');
    expect(existsSync(file)).toBe(false);
    // Removed even when the work fails.
    let failed = '';
    await expect(
      withOptionFile(target, async (f) => {
        failed = f;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(failed)).toBe(false);
  });
});
