import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbTarget, optionFileBody, sameDatabase, serverOffersTls, withOptionFile } from './mysql-tools.js';

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
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mysql-tools-'));
    try {
      let seen = '';
      let inDir = '';
      const file = await withOptionFile(
        target,
        async (f) => {
          seen = readFileSync(f, 'utf8');
          return f;
        },
        dir,
        true,
      );
      expect(seen).toContain('[client]');
      // TCP like the app's driver: never the local socket for host=localhost.
      expect(seen).toContain('protocol=TCP');
      expect(seen).toContain('password="a\\\\b\\"c"');
      expect(existsSync(file)).toBe(false);
      // Written into the folder the caller gave, never the system temp folder.
      await withOptionFile(
        target,
        async (f) => {
          inDir = f;
          expect(path.dirname(f)).toBe(dir);
          expect(path.basename(f)).toMatch(/^\.erp-db-[0-9a-f-]+\.cnf$/);
        },
        dir,
        true,
      );
      // Removed even when the work fails.
      let failed = '';
      await expect(
        withOptionFile(
          target,
          async (f) => {
            failed = f;
            throw new Error('boom');
          },
          dir,
          true,
        ),
      ).rejects.toThrow('boom');
      expect(existsSync(failed)).toBe(false);
      expect(existsSync(inDir)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connects in plain only to a server without TLS (11.4+ clients require it by default)', () => {
    const target = dbTarget('mysql://root:pw@db:3306/erp');
    // A 10.11 server without certificates, an 11.x client: TLS off, else the client refuses to connect.
    expect(optionFileBody(target, false)).toContain('\nloose-skip-ssl\n');
    // A server that offers TLS: the client's TLS and certificate check stay on.
    expect(optionFileBody(target, true)).not.toContain('ssl');
  });

  it('asks the server whether it offers TLS, and keeps the client defaults when it cannot tell', async () => {
    // Nothing listens on port 1: no answer, so no change to the tools' defaults.
    await expect(serverOffersTls(dbTarget('mysql://u:p@127.0.0.1:1/erp'))).resolves.toBe(true);
  });
});
