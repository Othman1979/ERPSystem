/**
 * Phase 9.4 — company data export (§13.6, ADR-009 §13):
 *  - GET /export/tenant-data: a ZIP of Excel workbooks (one sheet per
 *    table), the members, the stored logo and a README;
 *  - exact amounts; no secrets (JoFotara settings, idempotency keys,
 *    password hashes, storage keys, submission XML);
 *  - owner only; works in SUSPENDED and CANCELLED (read only);
 *  - tenant isolation: B's file has none of A's rows.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3210;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const STORAGE = mkdtempSync(path.join(os.tmpdir(), 'erp-export-'));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `ex-${RUN}-${Math.random().toString(36).slice(2)}` });

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

/** Downloads the export as a raw buffer. */
const download = (token: string) =>
  api()
    .get('/api/v1/export/tenant-data')
    .set(auth(token))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

/** A sheet as header + rows of plain values. */
async function sheet(files: Record<string, Uint8Array>, file: string, name: string) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(files[file]) as unknown as ArrayBuffer);
  const ws = book.getWorksheet(name);
  if (!ws) return undefined;
  const rows: unknown[][] = [];
  ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  const [header, ...body] = rows;
  return { header: header as string[], rows: body };
}

beforeAll(async () => {
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test', STORAGE_DIR: STORAGE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  const url = new URL(databaseUrl);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
  rmSync(STORAGE, { recursive: true, force: true });
});

describe('Phase 9.4 — company data export', () => {
  let token = '';
  let tokenB = '';
  let accountant = '';
  let tenantA = '';
  let files: Record<string, Uint8Array> = {};

  it('setup: tenant A with data, a logo and an accountant; tenant B', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `EX ${RUN}`, ownerName: 'Owner', email: `ex-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    tenantA = String((await api().get('/api/v1/me').set(auth(token))).body.currentTenant.tenantId);
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `EX B ${RUN}`, ownerName: 'Owner B', email: `exb-${RUN}@test.dev`, password: PASS });
    tokenB = regB.body.accessToken;

    await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    const party = await api().post('/api/v1/parties').set(auth(token)).send({ code: `C-EXP-${RUN}`, nameAr: 'عميل التصدير', partyType: 'CUSTOMER' });
    expect(party.status).toBe(201);
    const accounts = (await api().get('/api/v1/accounts').set(auth(token))).body as { id: string; code: string }[];
    const acc = (code: string) => accounts.find((a) => a.code === code)!.id;
    const je = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({ entryDate: '2025-02-01', description: 'export check', lines: [{ accountId: acc('5204'), debit: '12.345' }, { accountId: acc('1101'), credit: '12.345' }] });
    expect(je.status).toBe(201);
    expect((await api().post(`/api/v1/journal-entries/${je.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);
    const logo = await api().post('/api/v1/company/logo').set(auth(token)).attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(logo.status).toBe(201);

    accountant = (
      await addMember(BASE, token, { email: `ex-acc-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS })
    ).token;
  });

  it('the owner downloads a ZIP of workbooks, the logo and a README', async () => {
    const res = await download(token);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="tenant-export-\d{4}-\d{2}-\d{2}\.zip"$/);
    files = unzipSync(new Uint8Array(res.body as Buffer));
    const names = Object.keys(files).sort();
    for (const f of ['01-company.xlsx', '02-accounts.xlsx', '03-journal.xlsx', '06-parties.xlsx', '11-audit.xlsx', 'README.txt']) {
      expect(names).toContain(f);
    }
    const logoFile = names.find((n) => n.startsWith('attachments/') && n.endsWith('-logo.png'));
    expect(logoFile).toBeDefined();
    expect(Buffer.from(files[logoFile!]).equals(PNG)).toBe(true);
    expect(strFromU8(files['README.txt'])).toContain(`EX ${RUN}`);
  });

  it('holds every row, with exact amounts', async () => {
    const accounts = (await api().get('/api/v1/accounts').set(auth(token))).body as unknown[];
    expect((await sheet(files, '02-accounts.xlsx', 'Account'))!.rows).toHaveLength(accounts.length);

    const lines = (await sheet(files, '03-journal.xlsx', 'JournalLine'))!;
    const debit = lines.header.indexOf('debit');
    const credit = lines.header.indexOf('credit');
    expect(lines.rows.map((r) => r[debit]).filter((v) => v !== 0)).toEqual([12.345]);
    expect(lines.rows.map((r) => r[credit]).filter((v) => v !== 0)).toEqual([12.345]);

    const parties = (await sheet(files, '06-parties.xlsx', 'Party'))!;
    expect(parties.rows.map((r) => r[parties.header.indexOf('code')])).toContain(`C-EXP-${RUN}`);

    const members = (await sheet(files, '01-company.xlsx', 'Members'))!;
    expect(members.rows.map((r) => r[members.header.indexOf('email')]).sort()).toEqual(
      [`ex-${RUN}@test.dev`, `ex-acc-${RUN}@test.dev`].sort(),
    );
  });

  it('carries no secrets or technical keys', async () => {
    expect(await sheet(files, '01-company.xlsx', 'IdempotencyKey')).toBeUndefined();
    expect(Object.keys(files).some((f) => f.includes('settings'))).toBe(false);
    const attachment = (await sheet(files, '01-company.xlsx', 'Attachment'))!;
    expect(attachment.header).not.toContain('storageKey');
    for (const [file, bytes] of Object.entries(files)) {
      if (!file.endsWith('.xlsx')) continue;
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
      for (const ws of book.worksheets) {
        expect([ws.name, ws.name.toLowerCase().includes('einvoicesettings')]).toEqual([ws.name, false]);
        const header = (ws.getRow(1).values as unknown[]).map(String);
        for (const bad of ['passwordHash', 'secretEncrypted', 'requestXml', 'claimToken', 'storageKey']) {
          expect([ws.name, header.includes(bad)]).toEqual([ws.name, false]);
        }
      }
    }
  });

  it('is for the owner only', async () => {
    const res = await api().get('/api/v1/export/tenant-data').set(auth(accountant));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('still works when the tenant is suspended or cancelled (read only)', async () => {
    for (const status of ['SUSPENDED', 'CANCELLED']) {
      await db.query('UPDATE tenants SET status = ? WHERE id = ?', [status, tenantA]);
      const res = await download(token);
      expect([status, res.status]).toEqual([status, 200]);
      // …while writing stays blocked.
      const write = await api().post('/api/v1/parties').set(auth(token)).send({ code: 'X', nameAr: 'X', partyType: 'CUSTOMER' });
      expect([status, write.status]).toEqual([status, 403]);
    }
    const [audit] = (await db.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'tenant.export' AND tenant_id = ?", [
      tenantA,
    ])) as { n: bigint }[];
    expect(Number(audit.n)).toBe(3);
  });

  it("tenant isolation: B's export has none of A's rows", async () => {
    const res = await download(tokenB);
    expect(res.status).toBe(200);
    const b = unzipSync(new Uint8Array(res.body as Buffer));
    const parties = (await sheet(b, '06-parties.xlsx', 'Party'))!;
    expect(JSON.stringify(parties)).not.toContain(`C-EXP-${RUN}`);
    const lines = await sheet(b, '03-journal.xlsx', 'JournalLine');
    expect(lines!.header).toEqual(['(empty)']);
    const members = (await sheet(b, '01-company.xlsx', 'Members'))!;
    expect(members.rows.map((r) => r[members.header.indexOf('email')])).toEqual([`exb-${RUN}@test.dev`]);
    expect(Object.keys(b).some((f) => f.startsWith('attachments/'))).toBe(false);
    const accountsB = (await api().get('/api/v1/accounts').set(auth(tokenB))).body as unknown[];
    expect((await sheet(b, '02-accounts.xlsx', 'Account'))!.rows).toHaveLength(accountsB.length);
  });
});
