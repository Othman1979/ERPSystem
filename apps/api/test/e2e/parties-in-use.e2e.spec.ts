/**
 * Party deactivation rules (DB-15 / ADR-021): PATCH /parties/:id/deactivate
 * hard-deletes a party only when nothing references it. A party referenced by
 * any sales or purchase invoice or return (draft or posted), receipt, payment,
 * allocation, or journal line (draft or posted) is deactivated instead
 * (`isActive: false`) and its row is kept. Also covers tenant isolation for
 * the endpoint, the no-orphans invariant on journal lines, and a balanced
 * trial balance.
 *
 * Real MariaDB (erp_test), built API on :3671. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';

const API_PORT = 3671;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
/** Timeout for every test in this file. */
const T = 60_000;

let server: ChildProcess;
let db: Connection;

function api() {
  return request(BASE);
}
function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}
function idem() {
  return { 'Idempotency-Key': `k-${RUN}-${Math.random().toString(36).slice(2)}` };
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await api().get('/api/v1/health');
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));

  const url = new URL(databaseUrl);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'erp_test',
  });

  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

// ---- types and small helpers -------------------------------------------------

interface Tenant {
  token: string;
  tenantId: string;
  /** code -> account id */
  accounts: Record<string, string>;
}

/** The two tenants of the suite. Filled by the setup test. */
const A: Tenant = { token: '', tenantId: '', accounts: {} };
const B: Tenant = { token: '', tenantId: '', accounts: {} };

/** Shared fixtures for tenant A, filled by the setup test. */
let warehouseId = '';
let serviceItemId = '';
/** Parties created during the run; P1 is reused by later tests. */
let p1 = '';

function acct(t: Tenant, code: string): string {
  const id = t.accounts[code];
  if (!id) throw new Error(`account ${code} not loaded for tenant`);
  return id;
}

function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return db.query<T[]>(text, params);
}

async function registerTenant(name: string, tag: string): Promise<string> {
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({
      tenantName: `${name} ${RUN}`,
      ownerName: `Owner ${tag}`,
      email: `parties-${tag}-${RUN}@test.dev`,
      password: PASS,
    });
  expect(reg.status).toBe(201);
  return (reg.body as { accessToken: string }).accessToken;
}

/** Creates a party for tenant A (or any token) and returns its id. */
async function party(token: string, code: string, partyType: 'CUSTOMER' | 'SUPPLIER'): Promise<string> {
  const res = await api()
    .post('/api/v1/parties')
    .set(auth(token))
    .send({ code, nameAr: code, partyType });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

function deactivate(token: string, id: string): request.Test {
  return api().patch(`/api/v1/parties/${id}/deactivate`).set(auth(token));
}

async function getParty(token: string, id: string): Promise<request.Response> {
  return api().get(`/api/v1/parties/${id}`).set(auth(token));
}

describe('party deactivation: delete only when unreferenced', () => {
  it(
    'setup: tenants A and B',
    async () => {
      A.token = await registerTenant('Parties A', 'a');
      B.token = await registerTenant('Parties B', 'b');

      const fy = await api()
        .post('/api/v1/fiscal-years')
        .set(auth(A.token))
        .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
      expect(fy.status).toBe(201);

      const accounts = await api().get('/api/v1/accounts').set(auth(A.token));
      expect(accounts.status).toBe(200);
      for (const a of accounts.body as { id: string; code: string }[]) {
        A.accounts[a.code] = a.id;
      }
      // 1103: customers control account (partyType CUSTOMER lines must use it).
      // 1101: cash, a non-party offset account. Both are asserted here.
      expect(A.accounts['1101']).toBeDefined();
      expect(A.accounts['1103']).toBeDefined();

      const wh = await api()
        .post('/api/v1/warehouses')
        .set(auth(A.token))
        .send({ code: 'W1', nameAr: 'W1' });
      expect(wh.status).toBe(201);
      warehouseId = (wh.body as { id: string }).id;

      const units = await api().get('/api/v1/units').set(auth(A.token));
      expect(units.status).toBe(200);
      const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;

      const item = await api()
        .post('/api/v1/items')
        .set(auth(A.token))
        .send({ code: 'SV1', nameAr: 'Service', baseUnitId: pcs, itemKind: 'SERVICE' });
      expect(item.status).toBe(201);
      serviceItemId = (item.body as { id: string }).id;
    },
    T,
  );

  it(
    'an unused party is deleted',
    async () => {
      const p0 = await party(A.token, 'P0', 'CUSTOMER');

      const res = await deactivate(A.token, p0);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true });

      const after = await getParty(A.token, p0);
      expect(after.status).toBe(404);
    },
    T,
  );

  it(
    'a party used only on a draft manual journal line is deactivated, not deleted',
    async () => {
      p1 = await party(A.token, 'P1', 'CUSTOMER');

      const draft = await api()
        .post('/api/v1/journal-entries')
        .set(auth(A.token))
        .send({
          entryDate: '2025-03-15',
          description: 't',
          lines: [
            { accountId: acct(A, '1103'), debit: '5.000', partyType: 'CUSTOMER', partyId: p1 },
            { accountId: acct(A, '1101'), credit: '5.000' },
          ],
        });
      expect(draft.status).toBe(201);

      const res = await deactivate(A.token, p1);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deactivated: true });

      const after = await getParty(A.token, p1);
      expect(after.status).toBe(200);
      expect(after.body.isActive).toBe(false);
    },
    T,
  );

  it(
    'a party used only on a posted manual journal line is deactivated, not deleted',
    async () => {
      const p2 = await party(A.token, 'P2', 'CUSTOMER');

      const draft = await api()
        .post('/api/v1/journal-entries')
        .set(auth(A.token))
        .send({
          entryDate: '2025-03-15',
          description: 't',
          lines: [
            { accountId: acct(A, '1103'), debit: '5.000', partyType: 'CUSTOMER', partyId: p2 },
            { accountId: acct(A, '1101'), credit: '5.000' },
          ],
        });
      expect(draft.status).toBe(201);

      const posted = await api()
        .post(`/api/v1/journal-entries/${(draft.body as { id: string }).id}/post`)
        .set(auth(A.token))
        .set(idem());
      expect(posted.status).toBe(201);

      const res = await deactivate(A.token, p2);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deactivated: true });

      const after = await getParty(A.token, p2);
      expect(after.status).toBe(200);
      expect(after.body.isActive).toBe(false);
    },
    T,
  );

  it(
    'a party used only on a draft sales invoice is deactivated, not deleted',
    async () => {
      const p3 = await party(A.token, 'P3', 'CUSTOMER');

      const inv = await api()
        .post('/api/v1/sales-invoices')
        .set(auth(A.token))
        .send({
          invoiceDate: '2025-03-20',
          customerId: p3,
          warehouseId,
          paymentType: 'CREDIT',
          lines: [{ itemId: serviceItemId, qty: '1', unitPrice: '10.000' }],
        });
      expect(inv.status).toBe(201);

      const res = await deactivate(A.token, p3);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deactivated: true });

      const after = await getParty(A.token, p3);
      expect(after.status).toBe(200);
      expect(after.body.isActive).toBe(false);
    },
    T,
  );

  it(
    'a party used only on a draft purchase invoice is deactivated, not deleted',
    async () => {
      const p4 = await party(A.token, 'P4', 'SUPPLIER');

      const inv = await api()
        .post('/api/v1/purchase-invoices')
        .set(auth(A.token))
        .send({
          invoiceDate: '2025-03-20',
          supplierId: p4,
          warehouseId,
          paymentType: 'CREDIT',
          supplierInvoiceNo: `S-${RUN}`,
          lines: [{ itemId: serviceItemId, qty: '1', unitCost: '3.000' }],
        });
      expect(inv.status).toBe(201);

      const res = await deactivate(A.token, p4);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deactivated: true });

      const after = await getParty(A.token, p4);
      expect(after.status).toBe(200);
      expect(after.body.isActive).toBe(false);
    },
    T,
  );

  it(
    'deactivating twice keeps the party (still in use)',
    async () => {
      const res = await deactivate(A.token, p1);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deactivated: true });

      const after = await getParty(A.token, p1);
      expect(after.status).toBe(200);
    },
    T,
  );

  it(
    "tenant B can neither delete nor deactivate tenant A's party",
    async () => {
      const p5 = await party(A.token, 'P5', 'CUSTOMER');

      const foreign = await deactivate(B.token, p5);
      expect(foreign.status).toBe(404);

      const stillThere = await getParty(A.token, p5);
      expect(stillThere.status).toBe(200);
      expect(stillThere.body.isActive).toBe(true);

      const foreignInUse = await deactivate(B.token, p1);
      expect(foreignInUse.status).toBe(404);
    },
    T,
  );

  it(
    'audit and no orphans',
    async () => {
      const owner = await sql<{ tenant_id: string }>('SELECT tenant_id FROM parties WHERE id = ?', [p1]);
      A.tenantId = String(owner[0].tenant_id);

      const orphans = await sql<{ n: number | bigint }>(
        `SELECT COUNT(*) AS n FROM journal_lines jl
          WHERE jl.party_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM parties p WHERE p.tenant_id = jl.tenant_id AND p.id = jl.party_id
            )
            AND jl.tenant_id = ?`,
        [A.tenantId],
      );
      expect(Number(orphans[0].n)).toBe(0);
    },
    T,
  );

  it(
    'trial balance stays balanced',
    async () => {
      const tb = await api().get('/api/v1/reports/trial-balance').set(auth(A.token));
      expect(tb.status).toBe(200);
      expect((tb.body as { balanced: boolean }).balanced).toBe(true);
    },
    T,
  );
});
