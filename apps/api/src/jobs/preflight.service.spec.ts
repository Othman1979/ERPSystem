import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { schemaHash } from '../prisma/schema-stamp.js';
import {
  apiPoolSize,
  backupAgeLevel,
  charsetProblems,
  compareMigrations,
  connectionsLevel,
  databaseVersionLevel,
  diskLevel,
  environmentLevel,
  EXPECTED_CHARSETS,
  prismaClientLevel,
  probeFolder,
  relativePaths,
  testFlagsLevel,
  timezoneLevel,
} from './preflight.service.js';

describe('preflight: database version (ADR-019)', () => {
  it.each([
    ['10.11.6-MariaDB-log', 'info'],
    ['10.11.0-MariaDB', 'info'],
    ['11.4.3-MariaDB-ubu2404', 'info'],
    ['11.8.2-MariaDB-ubu2404', 'info'],
    ['5.5.5-10.11.9-MariaDB', 'info'],
    ['11.9.1-MariaDB', 'warn'],
    ['12.0.2-MariaDB', 'warn'],
  ])('%s is %s', (version, level) => {
    expect(databaseVersionLevel(version, true).level).toBe(level);
  });

  it('older than 10.11 is an error in production and a warning elsewhere (development runs XAMPP 10.4)', () => {
    for (const version of ['10.6.18-MariaDB', '10.4.32-MariaDB']) {
      expect(databaseVersionLevel(version, true).level).toBe('error');
      expect(databaseVersionLevel(version, false).level).toBe('warn');
    }
    expect(databaseVersionLevel('10.6.18-MariaDB', true).detail).toMatch(/older than 10\.11/);
  });

  it('not MariaDB (MySQL) is always an error: the migrations use MariaDB-only syntax', () => {
    for (const version of ['8.0.36', '8.4.2-log', 'nonsense']) {
      expect(databaseVersionLevel(version, true).level).toBe('error');
      expect(databaseVersionLevel(version, false).level).toBe('error');
    }
    expect(databaseVersionLevel('8.0.36', false).detail).toMatch(/not MariaDB: MySQL is not supported .*MariaDB 10\.11 or newer is required/);
  });
});

describe('preflight: charset', () => {
  it('passes when the database and the session are utf8mb4 / utf8mb4_unicode_ci', () => {
    expect(charsetProblems({ ...EXPECTED_CHARSETS })).toEqual([]);
    expect(charsetProblems({ ...EXPECTED_CHARSETS, collation_connection: 'UTF8MB4_UNICODE_CI' })).toEqual([]);
  });

  it('names each variable that differs, database and session alike', () => {
    expect(
      charsetProblems({
        ...EXPECTED_CHARSETS,
        character_set_database: 'latin1',
        collation_database: 'latin1_swedish_ci',
        collation_connection: 'utf8mb4_uca1400_ai_ci',
        character_set_results: null,
      }),
    ).toEqual([
      'character_set_database=latin1 (expected utf8mb4)',
      'collation_database=latin1_swedish_ci (expected utf8mb4_unicode_ci)',
      'character_set_results=unknown (expected utf8mb4)',
      'collation_connection=utf8mb4_uca1400_ai_ci (expected utf8mb4_unicode_ci)',
    ]);
  });
});

describe('preflight: Prisma client stamp', () => {
  const schema = 'model A {\n  id Int @id\n}\n';

  it('matches the schema it was generated from', () => {
    expect(prismaClientLevel(`${schemaHash(schema)}\n`, schema, true)).toMatchObject({ level: 'info' });
  });

  it('another schema or no stamp is an error in production and a warning elsewhere', () => {
    const older = schemaHash('model A {}\n');
    expect(prismaClientLevel(older, schema, true)).toEqual({
      level: 'error',
      detail: expect.stringMatching(/another prisma\/schema\.prisma: run pnpm --filter api prisma:generate, then pnpm build/),
    });
    expect(prismaClientLevel(older, schema, false).level).toBe('warn');
    expect(prismaClientLevel(null, schema, true)).toEqual({ level: 'error', detail: expect.stringMatching(/no schema\.sha256/) });
    expect(prismaClientLevel(null, schema, false).level).toBe('warn');
  });
});

describe('preflight: time zone', () => {
  it('warns only when Node and the database session have different UTC offsets', () => {
    expect(timezoneLevel(180, 180)).toBe('info');
    expect(timezoneLevel(180, 0)).toBe('warn');
    expect(timezoneLevel(0, -300)).toBe('warn');
  });
});

describe('preflight: environment', () => {
  it('production is fine; another NODE_ENV is a warning locally and an error on a public site', () => {
    expect(environmentLevel('production', 'https://erp.example.jo').level).toBe('info');
    expect(environmentLevel('development', 'http://localhost:5173').level).toBe('warn');
    expect(environmentLevel('test', 'http://127.0.0.1:5173').level).toBe('warn');
    expect(environmentLevel('development', 'not a url').level).toBe('warn');
    expect(environmentLevel('development', 'https://erp.example.jo')).toEqual({
      level: 'error',
      detail: expect.stringMatching(/NODE_ENV=development on a public site .*set NODE_ENV=production/),
    });
  });
});

describe('preflight: test switches', () => {
  it('none set is fine', () => {
    expect(testFlagsLevel(undefined, 'false', true).level).toBe('info');
    expect(testFlagsLevel('', undefined, true).level).toBe('info');
  });

  it('JEST_WORKER_ID or ALLOW_TEST_ENV=true is an error in production and a warning elsewhere', () => {
    expect(testFlagsLevel('1', 'false', true)).toEqual({ level: 'error', detail: expect.stringMatching(/^JEST_WORKER_ID set/) });
    expect(testFlagsLevel(undefined, 'true', true)).toEqual({ level: 'error', detail: expect.stringMatching(/^ALLOW_TEST_ENV=true set/) });
    expect(testFlagsLevel('2', 'true', true).detail).toMatch(/^JEST_WORKER_ID and ALLOW_TEST_ENV=true set/);
    expect(testFlagsLevel('1', 'false', false).level).toBe('warn');
    expect(testFlagsLevel(undefined, 'true', false).level).toBe('warn');
  });
});

describe('preflight: folders', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'erp-preflight-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names STORAGE_DIR or BACKUP_DIR when relative', () => {
    expect(relativePaths({ STORAGE_DIR: 'storage', BACKUP_DIR: path.join(dir, 'backups') })).toEqual(['STORAGE_DIR=storage']);
    expect(relativePaths({ STORAGE_DIR: path.join(dir, 's'), BACKUP_DIR: path.join(dir, 'b') })).toEqual([]);
  });

  it('the error log folder: created when missing, probed, and left empty', async () => {
    const logs = path.join(dir, 'erp-data', 'logs');
    await probeFolder(logs);
    expect(await readdir(logs)).toEqual([]);
  });

  it('the error log folder: fails where it cannot write (a file in the way)', async () => {
    const blocker = path.join(dir, 'a-file');
    await writeFile(blocker, 'x');
    await expect(probeFolder(path.join(blocker, 'logs'))).rejects.toThrow();
  });
});

describe('preflight: database connections (DB-07)', () => {
  it("reads the API's DB_POOL_SIZE from .env, else the default 10", () => {
    expect(apiPoolSize('DATABASE_URL="mysql://u:p@h/db"\nDB_POOL_SIZE=15\n')).toBe(15);
    expect(apiPoolSize('DATABASE_URL="mysql://u:p@h/db"\n')).toBe(10);
    expect(apiPoolSize('DB_POOL_SIZE=\n')).toBe(10);
    expect(apiPoolSize(null)).toBe(10);
  });

  it('warns when the account limit is below the API pool plus three Cron pools of 2', () => {
    expect(connectionsLevel(16, 151, 10)).toMatchObject({ level: 'info', detail: expect.stringContaining('= 16') });
    expect(connectionsLevel(15, 151, 10)).toEqual({
      level: 'warn',
      detail: expect.stringMatching(/max_user_connections=15 is below API pool 10 \+ 3 Cron x 2 = 16/),
    });
    // 0: no per-account limit, the server's max_connections applies.
    expect(connectionsLevel(0, 151, 10).level).toBe('info');
    expect(connectionsLevel(0, 12, 10)).toMatchObject({ level: 'warn', detail: expect.stringContaining('max_connections=12') });
  });
});

describe('preflight: disk space', () => {
  const GIB = 1024 ** 3;

  it('is an error below 1 GiB free, a warning below 5 GiB, and fine above', () => {
    expect(diskLevel(0)).toBe('error');
    expect(diskLevel(GIB - 1)).toBe('error');
    expect(diskLevel(GIB)).toBe('warn');
    expect(diskLevel(5 * GIB - 1)).toBe('warn');
    expect(diskLevel(5 * GIB)).toBe('info');
    expect(diskLevel(120 * GIB)).toBe('info');
  });
});

describe('preflight: backup age (ADR-010 §10.2)', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

  it('no backup at all is a warning, in production too', () => {
    expect(backupAgeLevel(null, now, true)).toMatchObject({ level: 'warn' });
    expect(backupAgeLevel(null, now, false)).toMatchObject({ level: 'warn', detail: expect.stringContaining('job:backup') });
  });

  it('a backup within 26 hours is fine, with its age in hours', () => {
    expect(backupAgeLevel(hoursAgo(3), now, true)).toEqual({ level: 'info', detail: 'newest backup 3.0 h old' });
    expect(backupAgeLevel(hoursAgo(26), now, true).level).toBe('info');
  });

  it('older than 26 hours is an error in production and a warning elsewhere', () => {
    expect(backupAgeLevel(hoursAgo(26.5), now, true).level).toBe('error');
    expect(backupAgeLevel(hoursAgo(26.5), now, false).level).toBe('warn');
  });
});

describe('preflight: migrations (ADR-010 §10.1)', () => {
  const at = new Date('2026-11-11T00:00:00Z');

  it('lists folders not applied, and rows that started but never finished', () => {
    const result = compareMigrations(
      ['20260101_a', '20260201_b', '20260301_c'],
      [
        { migration_name: '20260101_a', finished_at: at, rolled_back_at: null },
        { migration_name: '20260201_b', finished_at: null, rolled_back_at: null },
      ],
    );
    expect(result).toEqual({ pending: ['20260201_b', '20260301_c'], failed: ['20260201_b'] });
  });

  it('a rolled-back attempt is neither applied nor failed', () => {
    const result = compareMigrations(
      ['20260101_a'],
      [
        { migration_name: '20260101_a', finished_at: null, rolled_back_at: at },
        { migration_name: '20260101_a', finished_at: at, rolled_back_at: null },
      ],
    );
    expect(result).toEqual({ pending: [], failed: [] });
  });
});
