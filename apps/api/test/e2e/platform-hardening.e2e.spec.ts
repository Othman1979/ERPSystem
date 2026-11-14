/**
 * Platform hardening (review PLAT-12, PLAT-17, PLAT-20, PLAT-25, PLAT-29 and the
 * id, body-size and health fixes around them):
 *  - a malformed id answers 400 VALIDATION, not 500 (an unknown id stays 404); so does a malformed tenantId;
 *  - x-request-id is kept only when short and plain, otherwise a UUID is issued;
 *  - a JSON body over 2 MB is refused with 413 PAYLOAD_TOO_LARGE; a 300 KB one is not;
 *  - a document with more than 500 lines is refused with DOCUMENT_TOO_MANY_LINES;
 *  - health answers with the database state;
 *  - an Idempotency-Key over 128 characters is refused with VALIDATION;
 *  - a trial past its end is read-only at once, while reads and other tenants still work;
 *  - tenant B never reaches tenant A's rows.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3641;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

beforeAll(async () => {
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' },
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
});

interface Tenant {
  label: string;
  token: string;
  tenantId: bigint;
}

async function register(label: string): Promise<Tenant> {
  const name = `Hardening ${label} ${RUN}`;
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: name, ownerName: 'Owner', email: `hardening-${label}-${RUN}@test.dev`, password: PASS });
  expect(res.status).toBe(201);
  const [row] = (await db.query('SELECT id FROM tenants WHERE name = ?', [name])) as { id: bigint }[];
  return { label, token: res.body.accessToken as string, tenantId: row.id };
}

/** Chart account ids by code (the default chart of each new tenant). */
async function accountIds(token: string): Promise<Record<string, string>> {
  const tree = await api().get('/api/v1/accounts').set(auth(token));
  const ids: Record<string, string> = {};
  const walk = (nodes: { id: string; code: string; children?: unknown[] }[]) => {
    for (const n of nodes) {
      ids[n.code] = n.id;
      if (n.children) walk(n.children as typeof nodes);
    }
  };
  walk(tree.body as never[]);
  return ids;
}

describe('Platform hardening', () => {
  let a: Tenant;
  let b: Tenant;
  let partyA: string;
  let draftA: string;

  beforeAll(async () => {
    a = await register('a');
    b = await register('b');
    const party = await api()
      .post('/api/v1/parties')
      .set(auth(a.token))
      .send({ code: `HA-${RUN}`, nameAr: 'عميل A', partyType: 'CUSTOMER' });
    expect(party.status).toBe(201);
    partyA = party.body.id as string;
  });

  describe('ids and tenant ids', () => {
    it('answers 400 VALIDATION for a non-numeric party id, not 500; an unknown id is 404', async () => {
      const res = await api().get('/api/v1/parties/abc').set(auth(a.token));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect((await api().get('/api/v1/parties/999999999').set(auth(a.token))).status).toBe(404);
    });

    it('answers 400 VALIDATION for an id beyond the 64-bit range', async () => {
      const res = await api().get('/api/v1/parties/99999999999999999999').set(auth(a.token));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('refuses a non-numeric tenantId on switch-tenant with VALIDATION', async () => {
      const res = await api().post('/api/v1/me/switch-tenant').set(auth(a.token)).send({ tenantId: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });
  });

  describe('x-request-id', () => {
    it('replaces an overlong request id with a UUID in the error body', async () => {
      const res = await api()
        .get('/api/v1/parties/abc')
        .set(auth(a.token))
        .set('x-request-id', 'x'.repeat(3000));
      expect(res.status).toBe(400);
      expect(res.body.error.requestId).not.toBe('x'.repeat(3000));
      expect(res.body.error.requestId).toMatch(UUID);
    });

    it('echoes a short plain request id', async () => {
      const res = await api().get('/api/v1/parties/abc').set(auth(a.token)).set('x-request-id', 'abc-123');
      expect(res.status).toBe(400);
      expect(res.body.error.requestId).toBe('abc-123');
    });
  });

  describe('body size', () => {
    it('refuses a 2.5 MB JSON body with 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await api()
        .post('/api/v1/parties')
        .set(auth(a.token))
        .send({ code: `BIG-${RUN}`, nameAr: 'x'.repeat(2.5 * 1024 * 1024), partyType: 'CUSTOMER' });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('does not refuse a 300 KB JSON body with 413', async () => {
      const res = await api()
        .post('/api/v1/parties')
        .set(auth(a.token))
        .send({ code: `MID-${RUN}`, nameAr: 'Mid', partyType: 'CUSTOMER', notes: 'x'.repeat(300 * 1024) });
      expect(res.status).not.toBe(413);
    });

    it('refuses a journal entry with 501 lines with DOCUMENT_TOO_MANY_LINES', async () => {
      const lines = Array.from({ length: 501 }, () => ({ accountId: '1', debit: '1.000' }));
      const res = await api()
        .post('/api/v1/journal-entries')
        .set(auth(a.token))
        .send({ entryDate: '2025-03-01', description: 'too many', lines });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_TOO_MANY_LINES');
    });
  });

  describe('health', () => {
    it('reports the database as up and writable', async () => {
      const res = await api().get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.db).toBe('up');
      expect(res.body.checks.write).toBe('ok');
    });

    it('answers liveness', async () => {
      expect((await api().get('/api/v1/health/live')).status).toBe(200);
    });
  });

  describe('Idempotency-Key', () => {
    beforeAll(async () => {
      const ids = await accountIds(a.token);
      const res = await api()
        .post('/api/v1/journal-entries')
        .set(auth(a.token))
        .send({
          entryDate: '2025-03-01',
          description: 'draft for key test',
          lines: [
            { accountId: ids['5204'], debit: '5.000' },
            { accountId: ids['1101'], credit: '5.000' },
          ],
        });
      expect(res.status).toBe(201);
      draftA = res.body.id as string;
    });

    it('refuses a 200-character key on a posting route with VALIDATION', async () => {
      const res = await api()
        .post(`/api/v1/journal-entries/${draftA}/post`)
        .set(auth(a.token))
        .set('Idempotency-Key', 'k'.repeat(200));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
      expect(res.body.error.message).toBe('Idempotency-Key must be 1 to 128 visible ASCII characters');
    });
  });

  describe('isolation', () => {
    it("tenant B's token on tenant A's party id answers 404", async () => {
      const res = await api().get(`/api/v1/parties/${partyA}`).set(auth(b.token));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('expired trial', () => {
    it('makes writes of tenant A read-only at once, reads still work, B is unaffected', async () => {
      await db.query('UPDATE tenants SET trial_ends_at = ? WHERE id = ?', [new Date(Date.now() - DAY), a.tenantId]);

      const write = await api()
        .post('/api/v1/parties')
        .set(auth(a.token))
        .send({ code: `EXP-${RUN}`, nameAr: 'Expired', partyType: 'CUSTOMER' });
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe('TENANT_READ_ONLY');

      const read = await api().get('/api/v1/parties').set(auth(a.token));
      expect(read.status).toBe(200);

      const other = await api()
        .post('/api/v1/parties')
        .set(auth(b.token))
        .send({ code: `OK-${RUN}`, nameAr: 'Still open', partyType: 'CUSTOMER' });
      expect(other.status).toBe(201);
    });
  });
});
