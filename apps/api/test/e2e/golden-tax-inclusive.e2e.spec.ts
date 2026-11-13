/**
 * Golden scenario T1–T6 — prices including tax (ADR-017, decisions.md
 * TRADE-06). A NEW golden scenario: the §18 numbers (golden.e2e.spec.ts) are
 * untouched. Rounding rule, per line: net = round3(gross / (1 + rate)),
 * tax = gross − net; the document total is what the user typed.
 *
 *   T1  the company turns «prices include tax» on
 *   T2  credit purchase 10 × 11.600 → net 100.000, tax 16.000, unit cost 10
 *   T3  credit sale 3 × 9.990      → net 25.836, tax 4.134, total 29.970, COGS 30
 *   T4  cash sale 2 × 58.000 − 10%  → total 104.400, net 90.000, tax 14.400, COGS 20
 *   T5  credit return of 1 from T3 → net 8.612, tax 1.378, total 9.990, cost back 10
 *   T6  TB balanced, 1104 = item value 60.000, stock:verify clean
 * Expected numbers are fixed here: do not change them to make the test pass.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3622;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `gt-${RUN}-${Math.random().toString(36).slice(2)}` });
const m3 = (v: Decimal.Value) => new Decimal(v).toFixed(3);

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
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
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
    database: 'erp_test',
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Golden scenario T1–T6 — prices including tax (ADR-017)', () => {
  let token = '';
  let tenantId: bigint;
  let W = '';
  let X = '';
  let customerId = '';
  let supplierId = '';
  let cashAccountId = '';
  let cashCode = '';
  let t3Id = '';
  const code: Record<string, string> = {};

  async function createAndPost(kind: string, body: object) {
    const created = await api().post(`/api/v1/${kind}`).set(auth(token)).send(body);
    if (created.status !== 201) throw new Error(`create ${kind} → ${created.status} ${JSON.stringify(created.body)}`);
    const posted = await api().post(`/api/v1/${kind}/${created.body.id}/post`).set(auth(token)).set(idem());
    if (posted.status !== 201) throw new Error(`post ${kind} → ${posted.status} ${JSON.stringify(posted.body)}`);
    return posted.body as {
      id: string;
      journalEntryId: string;
      pricesIncludeTax?: boolean;
      netTotal: string;
      taxTotal: string;
      grandTotal: string;
      lines: { id: string; netAmount: string; taxAmount: string; lineTotal: string; discountAmount: string }[];
    };
  }

  /** Journal lines as sorted "CODE Dr|Cr amount" strings. */
  async function entryLines(entryId: string) {
    const res = await api().get(`/api/v1/journal-entries/${entryId}`).set(auth(token));
    expect(res.status).toBe(200);
    return (res.body.lines as { account: { code: string }; debit: string; credit: string }[])
      .map((l) => `${l.account.code} ${new Decimal(l.debit).gt(0) ? `Dr ${m3(l.debit)}` : `Cr ${m3(l.credit)}`}`)
      .sort();
  }

  async function itemCost() {
    const [r] = (await db.query('SELECT total_qty AS q, total_value AS v FROM item_costs WHERE tenant_id = ? AND item_id = ?', [
      tenantId,
      X,
    ])) as { q: string; v: string }[];
    return { qty: new Decimal(r.q).toString(), value: m3(r.v) };
  }

  it('setup and T1: the company enters prices including tax', async () => {
    const name = `GoldenTax ${RUN}`;
    const reg = await api().post('/api/v1/auth/register').send({ tenantName: name, ownerName: 'Owner', email: `gtax-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    [{ id: tenantId }] = (await db.query('SELECT id FROM tenants WHERE name = ?', [name])) as { id: bigint }[];
    expect((await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' })).status).toBe(201);
    W = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const pcs = ((await api().get('/api/v1/units').set(auth(token))).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const tax16 = ((await api().get('/api/v1/tax-categories').set(auth(token))).body as { id: string; rate: string }[]).find((t) =>
      new Decimal(t.rate).eq(16),
    )!;
    X = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'X', nameAr: 'X', baseUnitId: pcs, taxCategoryId: tax16.id })).body.id;
    customerId = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' })).body.id;
    supplierId = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S', nameAr: 'S', partyType: 'SUPPLIER' })).body.id;
    const rows = (await db.query(
      'SELECT m.mapping_key AS k, a.code FROM account_mappings m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ?',
      [tenantId],
    )) as { k: string; code: string }[];
    for (const r of rows) code[r.k] = r.code;
    const [cash] = (await db.query("SELECT id, code FROM accounts WHERE tenant_id = ? AND control_type = 'CASH' AND is_postable = 1 LIMIT 1", [
      tenantId,
    ])) as { id: bigint; code: string }[];
    cashAccountId = String(cash.id);
    cashCode = cash.code;

    const on = await api().patch('/api/v1/company').set(auth(token)).send({ pricesIncludeTax: true });
    expect(on.status).toBe(200);
    expect(on.body.pricesIncludeTax).toBe(true);
  });

  it('T2 credit purchase 10 × 11.600 incl. tax → net 100.000, tax 16.000', async () => {
    const inv = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-02-01', supplierId, warehouseId: W, paymentType: 'CREDIT', lines: [{ itemId: X, qty: '10', unitCost: '11.600' }],
    });
    expect(inv.pricesIncludeTax).toBe(true);
    expect([m3(inv.netTotal), m3(inv.taxTotal), m3(inv.grandTotal)]).toEqual(['100.000', '16.000', '116.000']);
    expect(await itemCost()).toEqual({ qty: '10', value: '100.000' });
    expect(await entryLines(inv.journalEntryId)).toEqual(
      [`${code.INVENTORY} Dr 100.000`, `${code.INPUT_TAX} Dr 16.000`, `${code.SUPPLIERS_CONTROL} Cr 116.000`].sort(),
    );
  });

  it('T3 credit sale 3 × 9.990 incl. tax → net 25.836, tax 4.134, total 29.970', async () => {
    const inv = await createAndPost('sales-invoices', {
      invoiceDate: '2025-02-02', customerId, warehouseId: W, paymentType: 'CREDIT', lines: [{ itemId: X, qty: '3', unitPrice: '9.990' }],
    });
    t3Id = inv.id;
    expect([m3(inv.netTotal), m3(inv.taxTotal), m3(inv.grandTotal)]).toEqual(['25.836', '4.134', '29.970']);
    expect(await entryLines(inv.journalEntryId)).toEqual(
      [
        `${code.CUSTOMERS_CONTROL} Dr 29.970`,
        `${code.SALES} Cr 25.836`,
        `${code.OUTPUT_TAX} Cr 4.134`,
        `${code.COGS} Dr 30.000`,
        `${code.INVENTORY} Cr 30.000`,
      ].sort(),
    );
  });

  it('T4 cash sale 2 × 58.000 less 10% incl. tax → total 104.400, net 90.000, tax 14.400', async () => {
    const inv = await createAndPost('sales-invoices', {
      invoiceDate: '2025-02-03', customerId, warehouseId: W, paymentType: 'CASH', cashAccountId,
      lines: [{ itemId: X, qty: '2', unitPrice: '58.000', discountPct: '10' }],
    });
    expect([m3(inv.lines[0].discountAmount), m3(inv.netTotal), m3(inv.taxTotal), m3(inv.grandTotal)]).toEqual([
      '11.600',
      '90.000',
      '14.400',
      '104.400',
    ]);
    expect(await entryLines(inv.journalEntryId)).toEqual(
      [`${cashCode} Dr 104.400`, `${code.SALES} Cr 90.000`, `${code.OUTPUT_TAX} Cr 14.400`, `${code.COGS} Dr 20.000`, `${code.INVENTORY} Cr 20.000`].sort(),
    );
  });

  it('T5 credit return of 1 from T3 → net 8.612, tax 1.378, total 9.990', async () => {
    const t3 = await api().get(`/api/v1/sales-invoices/${t3Id}`).set(auth(token));
    const ret = await createAndPost('sales-returns', {
      returnDate: '2025-02-04', originalInvoiceId: t3Id, refundType: 'CREDIT', reason: 'r', lines: [{ originalLineId: t3.body.lines[0].id, qty: '1' }],
    });
    expect([m3(ret.netTotal), m3(ret.taxTotal), m3(ret.grandTotal)]).toEqual(['8.612', '1.378', '9.990']);
    expect(await entryLines(ret.journalEntryId)).toEqual(
      [
        `${code.SALES_RETURNS} Dr 8.612`,
        `${code.OUTPUT_TAX} Dr 1.378`,
        `${code.CUSTOMERS_CONTROL} Cr 9.990`,
        `${code.INVENTORY} Dr 10.000`,
        `${code.COGS} Cr 10.000`,
      ].sort(),
    );
  });

  it('T6 final: TB balanced, 1104 = item value 60.000, stock:verify clean', async () => {
    expect(await itemCost()).toEqual({ qty: '6', value: '60.000' });
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    expect(tb.body.balanced).toBe(true);
    const inv = (tb.body.rows as { code: string; totalDebit: string; totalCredit: string }[]).find((r) => r.code === code.INVENTORY)!;
    expect(m3(new Decimal(inv.totalDebit).minus(inv.totalCredit))).toBe('60.000');
    const verify = await api().get('/api/v1/stock/verify').set(auth(token));
    expect(verify.body.mismatches).toEqual([]);
  });
});
