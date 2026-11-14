/**
 * Party deactivation rules (DB-15 / ADR-021): PATCH /parties/:id/deactivate
 * hard-deletes a party only when nothing references it. A party referenced by
 * any sales or purchase invoice or return (draft or posted), receipt, payment,
 * allocation, or journal line (draft or posted) is deactivated instead
 * (`isActive: false`) and its row is kept. Each referencing document type has
 * its own case: manual journal lines, sales and purchase invoices, receipts,
 * payments, allocations and sales returns. Allocations and returns are inserted
 * with SQL, because the API cannot create them without a voucher of the same
 * party, which would already count as a reference. A race case checks that a
 * delete running against a manual journal draft never leaves an orphan line.
 * Also covers tenant isolation for the endpoint, the no-orphans invariant on
 * journal lines, and a balanced trial balance.
 *
 * Real MariaDB (erp_test), built API on :3671. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

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
  const databaseUrl = testDatabaseUrl();
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
    database: TEST_DB_NAME,
  });

  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

// ---- types and small helpers -------------------------------------------------

/** Result of a raw INSERT run through `db.query` (mariadb 3.5 exports no OkPacket type). */
interface InsertResult {
  insertId: bigint | number;
}

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
/** Cash account and cash box created by the receipt case, reused by the payment case. */
let cashAccountId = '';
/** Receipt created by the receipt case, reused as the allocation's receipt. */
let receiptId = '';
/** Sales invoice used as the allocation target and as the origin of the return. */
let invoiceId = '';

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

/** First account with controlType CASH in the GET /accounts tree. */
async function findCashAccountId(token: string): Promise<string> {
  const accounts = await api().get('/api/v1/accounts').set(auth(token));
  expect(accounts.status).toBe(200);
  const flat: { id: string; controlType?: string | null }[] = [];
  const walk = (ns: { id: string; controlType?: string | null; children?: unknown[] }[]) => {
    for (const n of ns) {
      flat.push(n);
      if (n.children) walk(n.children as typeof ns);
    }
  };
  walk(accounts.body as never[]);
  return flat.find((a) => a.controlType === 'CASH')!.id;
}

/** Tenant and company of a party, read by SQL. Ids are returned as strings for query params. */
async function partyScope(partyId: string): Promise<{ tenantId: string; companyId: string }> {
  const rows = await sql<{ tenant_id: bigint | number | string; company_id: bigint | number | string }>(
    'SELECT tenant_id, company_id FROM parties WHERE id = ?',
    [partyId],
  );
  return { tenantId: String(rows[0].tenant_id), companyId: String(rows[0].company_id) };
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
    'a party used only on a receipt is deactivated, not deleted',
    async () => {
      cashAccountId = await findCashAccountId(A.token);
      const box = await api()
        .post('/api/v1/cash-boxes')
        .set(auth(A.token))
        .send({ code: 'CB1', name: 'Main box', accountId: cashAccountId });
      expect(box.status).toBe(201);

      const p6 = await party(A.token, 'P6', 'CUSTOMER');

      const rec = await api()
        .post('/api/v1/receipts')
        .set(auth(A.token))
        .set(idem())
        .send({
          receiptDate: '2025-03-21',
          partyType: 'CUSTOMER',
          partyId: p6,
          cashAccountId,
          amount: '2.000',
        });
      expect(rec.status).toBe(201);
      receiptId = (rec.body as { id: string }).id;

      const res = await deactivate(A.token, p6);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deactivated: true });

      const after = await getParty(A.token, p6);
      expect(after.status).toBe(200);
      expect(after.body.isActive).toBe(false);
    },
    T,
  );

  it(
    'a party used only on a payment is deactivated, not deleted',
    async () => {
      const p7 = await party(A.token, 'P7', 'SUPPLIER');

      const pay = await api()
        .post('/api/v1/payments')
        .set(auth(A.token))
        .set(idem())
        .send({
          paymentDate: '2025-03-21',
          partyType: 'SUPPLIER',
          partyId: p7,
          cashAccountId,
          amount: '2.000',
        });
      expect(pay.status).toBe(201);

      const res = await deactivate(A.token, p7);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deactivated: true });

      const after = await getParty(A.token, p7);
      expect(after.status).toBe(200);
      expect(after.body.isActive).toBe(false);
    },
    T,
  );

  it(
    'a party used only on an allocation is deactivated, not deleted',
    async () => {
      const p8 = await party(A.token, 'P8', 'CUSTOMER');
      const { tenantId, companyId } = await partyScope(p8);

      // SQL on purpose: the API cannot allocate a voucher to a party without a
      // voucher of that same party, which would already count as a reference.
      // Inserting the row directly isolates the allocation check.
      const [inv] = await sql<{ id: bigint | number | string }>(
        'SELECT id FROM sales_invoices WHERE tenant_id = ? LIMIT 1',
        [tenantId],
      );
      invoiceId = String(inv.id);

      const ins = await db.query<InsertResult>(
        `INSERT INTO allocations
           (tenant_id, company_id, receipt_id, party_type, party_id, document_type, document_id, amount, created_at)
         VALUES (?, ?, ?, 'CUSTOMER', ?, 'SALES_INVOICE', ?, '0.001', NOW(3))`,
        [tenantId, companyId, receiptId, p8, invoiceId],
      );

      try {
        const res = await deactivate(A.token, p8);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ deactivated: true });

        const after = await getParty(A.token, p8);
        expect(after.status).toBe(200);
        expect(after.body.isActive).toBe(false);
      } finally {
        await db.query('DELETE FROM allocations WHERE tenant_id = ? AND id = ?', [
          tenantId,
          String(ins.insertId),
        ]);
      }
    },
    T,
  );

  it(
    'a party used only on a sales return is deactivated, not deleted',
    async () => {
      const p9 = await party(A.token, 'P9', 'CUSTOMER');
      const { tenantId, companyId } = await partyScope(p9);

      // SQL on purpose: a return needs an original invoice, and the isolated check
      // here is the return row itself. The invoice is any tenant A invoice (see the
      // allocation case), so the row is inserted directly with the customer P9.
      const ins = await db.query<InsertResult>(
        `INSERT INTO sales_returns
           (tenant_id, company_id, return_date, original_invoice_id, customer_id, warehouse_id,
            refund_type, status, net_total, tax_total, grand_total, cost_total, created_at, updated_at)
         VALUES (?, ?, '2025-03-25', ?, ?, ?, 'CREDIT', 'DRAFT', '0.000', '0.000', '0.000', '0.000', NOW(3), NOW(3))`,
        [tenantId, companyId, invoiceId, p9, warehouseId],
      );

      try {
        const res = await deactivate(A.token, p9);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ deactivated: true });

        const after = await getParty(A.token, p9);
        expect(after.status).toBe(200);
        expect(after.body.isActive).toBe(false);
      } finally {
        await db.query('DELETE FROM sales_returns WHERE tenant_id = ? AND id = ?', [
          tenantId,
          String(ins.insertId),
        ]);
      }
    },
    T,
  );

  it(
    'a delete racing a manual journal draft never leaves an orphan line',
    async () => {
      const rounds = 8;
      let tenantId = '';
      for (let round = 1; round <= rounds; round++) {
        const pr = await party(A.token, `RC${round}`, 'CUSTOMER');
        tenantId = (await partyScope(pr)).tenantId;

        const [draftRes, deactRes] = await Promise.all([
          api()
            .post('/api/v1/journal-entries')
            .set(auth(A.token))
            .send({
              entryDate: '2025-03-15',
              description: 'race',
              lines: [
                { accountId: acct(A, '1103'), debit: '1.000', partyType: 'CUSTOMER', partyId: pr },
                { accountId: acct(A, '1101'), credit: '1.000' },
              ],
            }),
          deactivate(A.token, pr),
        ]);

        expect(draftRes.status).not.toBe(500);
        expect(deactRes.status).not.toBe(500);

        // Allowed: the draft won (201, party kept and deactivated), or the delete
        // won (party deleted, so the draft is refused with 404). Anything else,
        // such as a draft line left pointing at a deleted party, fails.
        const draftWon =
          draftRes.status === 201 &&
          deactRes.status === 200 &&
          (deactRes.body as { deactivated?: boolean }).deactivated === true;
        const deleteWon =
          draftRes.status === 404 &&
          deactRes.status === 200 &&
          (deactRes.body as { deleted?: boolean }).deleted === true;
        const ok = draftWon || deleteWon;
        expect({ round, ok }).toEqual({ round, ok: true });
      }

      const orphans = await sql<{ n: number | bigint }>(
        `SELECT COUNT(*) AS n FROM journal_lines jl
          WHERE jl.party_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM parties p WHERE p.tenant_id = jl.tenant_id AND p.id = jl.party_id
            )
            AND jl.tenant_id = ?`,
        [tenantId],
      );
      expect(Number(orphans[0].n)).toBe(0);
    },
    120_000,
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
