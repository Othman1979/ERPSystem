/**
 * Phase 10.2 — daily backup and restore drill (ADR-010 §10.2, §14-10):
 *  - `backup` writes the database dump, the uploaded files and a checksum
 *    manifest into one folder, and rotates old backups out;
 *  - `backup-verify` restores it into a scratch database and finds the same
 *    data: same rows, balanced books, stock = movements, every file present;
 *  - a damaged backup is refused before loading; bad data, a missing upload
 *    and a refused scratch database are reported; a failed run leaves nothing.
 * Self-contained: its own database (migrated + seeded), its own uploads.
 * Real MariaDB + built API + the client tools (MYSQLDUMP_PATH / MYSQL_PATH).
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3215;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = `erp_bk_${RUN}`;
const SCRATCH = `erp_bk_${RUN}_restore`;
/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let server: ChildProcess | undefined;
let db: Connection;
let tmp = '';
let storageDir = '';
let backupDir = '';
const urlFor = (name: string) => process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `bk-${RUN}-${Math.random().toString(36).slice(2)}` });

/** Runs a command in the API folder; a non-zero exit is returned, not thrown. */
async function run(file: string, args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)(file, args, {
      cwd: API_DIR,
      env: { ...process.env, NODE_ENV: 'test', ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A job against the test's own database, uploads and backup folder. */
const job = (args: string[], env: Record<string, string | undefined> = {}) =>
  run('node', ['dist/jobs/cli.js', ...args], {
    DATABASE_URL: urlFor(SOURCE),
    STORAGE_DIR: storageDir,
    BACKUP_DIR: backupDir,
    BACKUP_VERIFY_DATABASE_URL: urlFor(SCRATCH),
    ...env,
  });

type Check = { name: string; ok: boolean; detail: string };
const tables = async (schema: string) =>
  Number(((await db.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [schema])) as { n: bigint }[])[0].n);
const byName = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.name, c]));

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await api().get('/api/v1/health')).status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function stopServer(): Promise<void> {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  await db.query(`CREATE DATABASE ${SOURCE} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // The scratch database exists beforehand, as one created from a hosting panel:
  // backup-verify only empties it (no CREATE / DROP DATABASE privilege needed).
  await db.query(`CREATE DATABASE ${SCRATCH} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  tmp = await mkdtemp(path.join(os.tmpdir(), 'erp-bk-'));
  storageDir = path.join(tmp, 'storage');
  backupDir = path.join(tmp, 'backups');

  // A fresh installation: migrations, then the seed, as in a first deployment.
  const migrate = await run('node', ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { DATABASE_URL: urlFor(SOURCE) });
  if (migrate.code !== 0) throw new Error(`migrate deploy failed: ${migrate.stderr || migrate.stdout}`);
  // As the deployment guide says: prisma db seed (configured in prisma.config.ts).
  const seed = await run('node', ['node_modules/prisma/build/index.js', 'db', 'seed'], { DATABASE_URL: urlFor(SOURCE) });
  if (seed.code !== 0) throw new Error(`seed failed: ${seed.stderr || seed.stdout}`);

  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: urlFor(SOURCE), API_PORT: String(API_PORT), NODE_ENV: 'test', STORAGE_DIR: storageDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 300_000);

afterAll(async () => {
  await stopServer();
  await db?.query(`DROP DATABASE IF EXISTS ${SOURCE}`);
  await db?.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await db?.end();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('Phase 10.2 — backup and restore', () => {
  let firstBackup = '';

  it('setup: a company with a posted sale, opening stock and a logo', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `BK ${RUN}`, ownerName: 'Owner', email: `bk-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    expect((await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' })).status).toBe(201);
    const acc = Object.fromEntries(
      ((await api().get('/api/v1/accounts').set(auth(token))).body as { id: string; code: string }[]).map((a) => [a.code, a.id]),
    );
    const je = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({ entryDate: '2026-03-01', lines: [{ accountId: acc['1101'], debit: '1000' }, { accountId: acc['4101'], credit: '1000' }] });
    expect((await api().post(`/api/v1/journal-entries/${je.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);

    const warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const pcs = ((await api().get('/api/v1/units').set(auth(token))).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const itemId = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs, itemKind: 'STOCK' })).body.id;
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({ adjustmentDate: '2026-01-01', adjustmentType: 'OPENING', warehouseId, lines: [{ itemId, qty: '10', unitCost: '4.500' }] });
    expect((await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);

    const logo = await api().post('/api/v1/company/logo').set(auth(token)).attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(logo.status).toBe(201);
    // The job reads the database directly: no server needed from here on.
    await stopServer();
  }, 120_000);

  it('backup writes the dump, the uploads and a checksum manifest', async () => {
    const res = await job(['backup']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as { folder: string; storageFiles: number; removed: string[] };
    firstBackup = out.folder;
    expect(path.basename(out.folder)).toMatch(/^backup-\d{8}-\d{6}$/);
    expect(readdirSync(out.folder).sort()).toEqual(['database.sql.gz', 'manifest.json', 'storage.zip']);
    expect(out.storageFiles).toBe(1);
    const manifest = JSON.parse(readFileSync(path.join(out.folder, 'manifest.json'), 'utf8'));
    const migrationFolders = readdirSync(path.join(API_DIR, 'prisma', 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(manifest).toMatchObject({ format: 1, database: { name: SOURCE }, migrations: { count: migrationFolders.length } });
    expect(manifest.files.map((f: { sha256: string }) => f.sha256.length)).toEqual([64, 64]);
    // Every tenant's data: this account only (Windows has no such modes).
    if (process.platform !== 'win32') {
      expect(statSync(out.folder).mode & 0o777).toBe(0o700);
      for (const f of ['database.sql.gz', 'manifest.json', 'storage.zip']) {
        expect(statSync(path.join(out.folder, f)).mode & 0o777).toBe(0o600);
      }
    }
    // Nothing half-written is left behind, and the password is in no file name or output.
    expect(readdirSync(backupDir).filter((n) => n.startsWith('.partial-'))).toEqual([]);
    expect(res.stdout + res.stderr).not.toContain(new URL(process.env.DATABASE_URL!).password || '\u0000');
  }, 120_000);

  it('backup-verify restores it into a scratch database with the same data, then drops it', async () => {
    const res = await job(['backup-verify', 'latest', '--keep']);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as { ok: boolean; restoredInto: string; kept: boolean; checks: Check[] };
    expect([out.ok, out.restoredInto, out.kept]).toEqual([true, SCRATCH, true]);
    const checks = byName(out.checks);
    expect(Object.keys(checks)).toEqual(['files', 'restore', 'migrations', 'journal', 'stock', 'storage', 'rows']);
    expect(checks.journal.detail).toMatch(/2 posted entries, all balanced/);
    expect(checks.storage.detail).toBe('1 referenced, 1 in the zip');

    // Row for row, the restored copy is the source.
    for (const table of ['tenants', 'users', 'journal_entries', 'journal_lines', 'stock_movements', 'stock_balances', 'attachments', '_prisma_migrations']) {
      const [src] = await db.query(`SELECT COUNT(*) AS n FROM ${SOURCE}.${table}`);
      const [dst] = await db.query(`SELECT COUNT(*) AS n FROM ${SCRATCH}.${table}`);
      expect([table, Number(dst.n)]).toEqual([table, Number(src.n)]);
    }
    const sums = async (schema: string) =>
      (await db.query(`SELECT SUM(debit) AS d, SUM(credit) AS c FROM ${schema}.journal_lines`))[0] as { d: string; c: string };
    expect(await sums(SCRATCH)).toEqual(await sums(SOURCE));

    // Without --keep the scratch database is emptied afterwards (it stays, as created from the panel).
    const again = await job(['backup-verify', path.basename(firstBackup)]);
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, kept: false });
    expect(await tables(SCRATCH)).toBe(0);
  }, 180_000);

  it('a damaged backup is refused before anything is loaded', async () => {
    const copy = path.join(tmp, 'damaged');
    await cp(firstBackup, copy, { recursive: true });
    await appendFile(path.join(copy, 'storage.zip'), 'x');
    const res = await job(['backup-verify', copy]);
    expect(res.code).toBe(1);
    const out = JSON.parse(res.stdout) as { ok: boolean; restoredInto: string | null; checks: Check[] };
    expect([out.ok, out.restoredInto]).toEqual([false, null]);
    expect(byName(out.checks).files.detail).toBe('damaged or missing: storage.zip');
  }, 60_000);

  it('refuses a scratch database that is not named as one, or is the live database', async () => {
    const unnamed = await job(['backup-verify', 'latest'], { BACKUP_VERIFY_DATABASE_URL: urlFor(SOURCE) });
    expect(unnamed.code).toBe(1);
    expect(byName(JSON.parse(unnamed.stdout).checks).restore.detail).toMatch(/not named as a scratch database/);

    const live = await job(['backup-verify', 'latest'], { DATABASE_URL: urlFor(SCRATCH), BACKUP_VERIFY_DATABASE_URL: urlFor(SCRATCH) });
    expect(byName(JSON.parse(live.stdout).checks).restore.detail).toMatch(/is the live database/);

    const unset = await job(['backup-verify', 'latest'], { BACKUP_VERIFY_DATABASE_URL: '' });
    expect(byName(JSON.parse(unset.stdout).checks).restore.detail).toMatch(/set BACKUP_VERIFY_DATABASE_URL/);

    // Not created yet: it is made once from the hosting panel, and the check says so.
    const missing = await job(['backup-verify', 'latest'], { BACKUP_VERIFY_DATABASE_URL: urlFor(`erp_bk_${RUN}_none_verify`) });
    expect(missing.code).toBe(1);
    expect(byName(JSON.parse(missing.stdout).checks).restore.detail).toMatch(/create it first, from the hosting panel/);
    // The source was never touched.
    const [t] = await db.query(`SELECT COUNT(*) AS n FROM ${SOURCE}.tenants`);
    expect(Number(t.n)).toBe(1);
  }, 120_000);

  it('reports unbalanced books, stock off its movements and a missing upload', async () => {
    // Corrupt the throwaway source the way a bad import or a lost disk would.
    await db.query(`UPDATE ${SOURCE}.journal_lines SET debit = debit + 1 WHERE debit > 0 LIMIT 1`);
    await db.query(`UPDATE ${SOURCE}.stock_balances SET qty_on_hand = qty_on_hand + 1`);
    const [logo] = await db.query(`SELECT storage_key FROM ${SOURCE}.attachments LIMIT 1`);
    await rm(path.join(storageDir, logo.storage_key));
    await new Promise((r) => setTimeout(r, 1100)); // a new second: a new backup name

    expect((await job(['backup'])).code).toBe(0);
    // --keep holds on failure too: the copy is there to look at.
    const res = await job(['backup-verify', 'latest', '--keep']);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, kept: true });
    expect(await tables(SCRATCH)).toBeGreaterThan(0);
    const checks = byName(JSON.parse(res.stdout).checks);
    expect([checks.files.ok, checks.restore.ok, checks.migrations.ok]).toEqual([true, true, true]);
    expect(checks.journal).toMatchObject({ ok: false, detail: '1 posted entries do not balance' });
    expect(checks.stock).toMatchObject({ ok: false, detail: '1 stock balances differ from their movements' });
    expect(checks.storage).toMatchObject({ ok: false, detail: expect.stringContaining(logo.storage_key) });
  }, 240_000);

  it('a failed run leaves nothing; old backups and crashed runs are rotated out, other folders kept', async () => {
    const before = readdirSync(backupDir).sort();
    const failed = await job(['backup'], { MYSQLDUMP_PATH: path.join(tmp, 'no-such-mysqldump') });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(/Cannot run/);
    expect(readdirSync(backupDir).sort()).toEqual(before);

    for (const name of ['backup-20200101-000000', '.partial-backup-20200102-000000', 'keep-me']) {
      await mkdir(path.join(backupDir, name));
      await writeFile(path.join(backupDir, name, 'x'), 'x');
    }
    await new Promise((r) => setTimeout(r, 1100));
    const res = await job(['backup']);
    expect(res.code).toBe(0);
    expect((JSON.parse(res.stdout).removed as string[]).sort()).toEqual(['.partial-backup-20200102-000000', 'backup-20200101-000000']);
    const left = readdirSync(backupDir);
    expect(left).toContain('keep-me');
    expect(left.filter((n) => /^backup-/.test(n))).toHaveLength(3);
  }, 120_000);

  it('refuses a backup folder inside the uploads (it would back itself up)', async () => {
    const res = await job(['backup'], { BACKUP_DIR: path.join(storageDir, 'backups') });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/overlaps STORAGE_DIR/);
    expect(existsSync(path.join(storageDir, 'backups'))).toBe(false);
    expect(await readFile(path.join(firstBackup, 'manifest.json'), 'utf8')).toContain(SOURCE);
  }, 60_000);
});
