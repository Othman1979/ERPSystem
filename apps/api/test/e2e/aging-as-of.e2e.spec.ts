/**
 * Aging as of a date (phase 6 open items, ADR-004 §7 update):
 *  - invoices, credit returns and allocations count from their own business
 *    date (an allocation from its voucher's date, never before its invoice);
 *  - cancelled allocations never count;
 *  - no asOf = today; a malformed asOf is refused;
 *  - opening balances and manual party entries are aged from their entry
 *    date, oldest settled first, and each party's balance equals its control
 *    account (unallocated receipts show as "unapplied");
 *  - allocation rules: cash invoices take none, refunds settle no invoice;
 *  - tenant isolation.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3196;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `ag-${RUN}-${Math.random().toString(36).slice(2)}` });
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

type Bucket = 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus';
interface AgingRow extends Record<Bucket, string> {
  partyId: string;
  code: string;
  total: string;
  unapplied: string;
  balance: string;
}
interface Aging {
  asOf: string;
  rows: AgingRow[];
  totals: Record<Bucket | 'total' | 'unapplied' | 'balance', string>;
}

describe('Aging as of a date', () => {
  let token = '';
  let tokenB = '';
  let warehouseId = '';
  let itemId = '';
  let cashAccountId = '';
  const acc: Record<string, string> = {};
  const party: Record<string, string> = {};
  let invoice1 = '';
  let invoice1Line = '';
  let allocation1 = '';

  async function aging(partyType: 'CUSTOMER' | 'SUPPLIER', asOf?: string, t = token) {
    const res = await api()
      .get(`/api/v1/reports/aging?partyType=${partyType}${asOf ? `&asOf=${asOf}` : ''}`)
      .set(auth(t));
    expect(res.status).toBe(200);
    return res.body as Aging;
  }

  const row = (a: Aging, code: string) => a.rows.find((r) => r.code === code);

  /** The row's non-zero buckets, e.g. { d1_30: '116.000' }. */
  function buckets(r: AgingRow | undefined) {
    if (!r) return undefined;
    const out: Partial<Record<Bucket, string>> = {};
    for (const b of ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const) {
      if (!new Decimal(r[b]).isZero()) out[b] = m3(r[b]);
    }
    return out;
  }

  async function sale(customer: string, date: string, qty: string, dueDate?: string) {
    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: date,
        ...(dueDate ? { dueDate } : {}),
        customerId: party[customer],
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty, unitPrice: '2.000' }],
      });
    expect(inv.status).toBe(201);
    const posted = await api().post(`/api/v1/sales-invoices/${inv.body.id}/post`).set(auth(token)).set(idem());
    expect(posted.status).toBe(201);
    return { id: inv.body.id as string, lineId: (inv.body.lines as { id: string }[])[0].id };
  }

  async function receipt(customer: string, date: string, amount: string, allocations: object[] = []) {
    const res = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({ receiptDate: date, partyType: 'CUSTOMER', partyId: party[customer], cashAccountId, amount, allocations });
    expect(res.status).toBe(201);
    return res.body as { id: string; allocations: { id: string }[] };
  }

  /** Customer control balance (Dr − Cr) from the trial balance up to `to`. */
  async function controlBalance(code: string, to: string) {
    const tb = await api().get(`/api/v1/reports/trial-balance?to=${to}`).set(auth(token));
    const r = (tb.body.rows as { code: string; totalDebit: string; totalCredit: string }[]).find((x) => x.code === code);
    return r ? new Decimal(r.totalDebit).minus(r.totalCredit) : new Decimal(0);
  }

  it('setup', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `AG ${RUN}`, ownerName: 'Owner', email: `ag-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `AG B ${RUN}`, ownerName: 'Owner B', email: `agb-${RUN}@test.dev`, password: PASS });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    // A service item: no stock movements, so documents can be dated in any order.
    itemId = (
      await api().post('/api/v1/items').set(auth(token)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs, itemKind: 'SERVICE' })
    ).body.id;
    for (const [code, partyType] of [
      ['C1', 'CUSTOMER'],
      ['C2', 'CUSTOMER'],
      ['C3', 'CUSTOMER'],
      ['S1', 'SUPPLIER'],
    ] as const) {
      const p = await api().post('/api/v1/parties').set(auth(token)).send({ code, nameAr: code, partyType });
      expect(p.status).toBe(201);
      party[code] = p.body.id;
    }
    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    const walk = (ns: { id: string; code: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        acc[n.code] = n.id;
        if (n.controlType === 'CASH' && !cashAccountId) cashAccountId = n.id;
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
    expect(cashAccountId).not.toBe('');
  });

  it('an invoice counts from its own date, by days past its due date', async () => {
    const inv = await sale('C1', '2025-01-10', '50', '2025-02-09'); // 100 + 16 = 116.000
    invoice1 = inv.id;
    invoice1Line = inv.lineId;
    expect(row(await aging('CUSTOMER', '2025-01-09'), 'C1')).toBeUndefined();
    expect(buckets(row(await aging('CUSTOMER', '2025-02-09'), 'C1'))).toEqual({ notDue: '116.000' });
    expect(buckets(row(await aging('CUSTOMER', '2025-02-20'), 'C1'))).toEqual({ d1_30: '116.000' });
  });

  it('an allocation counts from its voucher date', async () => {
    const r = await receipt('C1', '2025-03-01', '50.000', [
      { documentType: 'SALES_INVOICE', documentId: invoice1, amount: '50.000' },
    ]);
    allocation1 = r.allocations[0].id;
    expect(buckets(row(await aging('CUSTOMER', '2025-02-28'), 'C1'))).toEqual({ d1_30: '116.000' });
    expect(buckets(row(await aging('CUSTOMER', '2025-03-15'), 'C1'))).toEqual({ d31_60: '66.000' });
  });

  it('a credit return counts from its return date', async () => {
    const ret = await api()
      .post('/api/v1/sales-returns')
      .set(auth(token))
      .send({ returnDate: '2025-04-01', originalInvoiceId: invoice1, refundType: 'CREDIT', lines: [{ originalLineId: invoice1Line, qty: '5' }] });
    expect(ret.status).toBe(201);
    expect((await api().post(`/api/v1/sales-returns/${ret.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);
    // 66.000 − (10.000 + 1.600)
    expect(buckets(row(await aging('CUSTOMER', '2025-03-31'), 'C1'))).toEqual({ d31_60: '66.000' });
    expect(buckets(row(await aging('CUSTOMER', '2025-04-15'), 'C1'))).toEqual({ d61_90: '54.400' });
  });

  it('an advance allocated to a later invoice counts from the invoice date', async () => {
    const advance = await receipt('C2', '2025-01-05', '20.000');
    const inv = await sale('C2', '2025-02-01', '10'); // 23.200, due on its date
    const alloc = await api()
      .post(`/api/v1/receipts/${advance.id}/allocations`)
      .set(auth(token))
      .set(idem())
      .send({ allocations: [{ documentType: 'SALES_INVOICE', documentId: inv.id, amount: '20.000' }] });
    expect(alloc.status).toBe(201);
    expect(buckets(row(await aging('CUSTOMER', '2025-01-31'), 'C2')) ?? {}).toEqual({});
    expect(buckets(row(await aging('CUSTOMER', '2025-02-15'), 'C2'))).toEqual({ d1_30: '3.200' });
  });

  it('a cancelled allocation does not count at any date', async () => {
    const cancel = await api().post(`/api/v1/allocations/${allocation1}/cancel`).set(auth(token)).set(idem());
    expect(cancel.status).toBe(201);
    expect(buckets(row(await aging('CUSTOMER', '2025-03-15'), 'C1'))).toEqual({ d31_60: '116.000' });
    expect(buckets(row(await aging('CUSTOMER', '2025-04-15'), 'C1'))).toEqual({ d61_90: '104.400' });
  });

  it('supplier invoices follow the same date rule', async () => {
    const inv = await api()
      .post('/api/v1/purchase-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-01-15',
        supplierId: party.S1,
        warehouseId,
        paymentType: 'CREDIT',
        supplierInvoiceNo: `S-${RUN}`,
        lines: [{ itemId, qty: '10', unitCost: '1.000' }],
      });
    expect(inv.status).toBe(201);
    expect((await api().post(`/api/v1/purchase-invoices/${inv.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);
    expect(row(await aging('SUPPLIER', '2025-01-14'), 'S1')).toBeUndefined();
    expect(buckets(row(await aging('SUPPLIER', '2025-01-20'), 'S1'))).toEqual({ d1_30: '11.600' });
  });

  it('no asOf means today; a malformed one is refused', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const implicit = await aging('CUSTOMER');
    const explicit = await aging('CUSTOMER', today);
    expect(implicit.asOf).toBe(today);
    expect(implicit.rows).toEqual(explicit.rows);
    expect(implicit.totals).toEqual(explicit.totals);
    for (const bad of ['2025-13-01', '2025-02-30', 'abc', '2025-1-1']) {
      const res = await api().get(`/api/v1/reports/aging?partyType=CUSTOMER&asOf=${bad}`).set(auth(token));
      expect(res.status).toBe(400);
    }
  });

  // ------------------------------------------- opening balances / journal

  it('opening balances are aged from their entry date, oldest settled first', async () => {
    const opening = await api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(token))
      .set(idem())
      .send({
        entryDate: '2025-01-01',
        description: 'opening',
        lines: [
          { accountId: acc['1103'], debit: '200.000', partyType: 'CUSTOMER', partyId: party.C3 },
          { accountId: acc['2101'], credit: '300.000', partyType: 'SUPPLIER', partyId: party.S1 },
        ],
      });
    expect(opening.status).toBe(201);
    await receipt('C3', '2025-02-01', '150.000'); // on account, not allocated

    const c3 = row(await aging('CUSTOMER', '2025-03-01'), 'C3')!;
    expect(buckets(c3)).toEqual({ d31_60: '50.000' }); // 59 days since the opening entry
    expect(m3(c3.unapplied)).toBe('0.000');
    expect(m3(c3.balance)).toBe('50.000');

    // S1: opening 300 (59 days) + its invoice of 2025-01-15 (45 days).
    const suppliers = await aging('SUPPLIER', '2025-03-01');
    const s1 = row(suppliers, 'S1')!;
    expect(buckets(s1)).toEqual({ d31_60: '311.600' });
    expect(m3(s1.balance)).toBe('311.600');
    expect(m3(suppliers.totals.balance)).toBe(m3((await controlBalance('2101', '2025-03-01')).neg()));
  });

  it('a manual party entry counts until it is reversed', async () => {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2025-02-10',
        description: 'manual charge',
        lines: [
          { accountId: acc['1103'], debit: '40.000', partyType: 'CUSTOMER', partyId: party.C3 },
          { accountId: acc['4201'], credit: '40.000' },
        ],
      });
    expect(draft.status).toBe(201);
    expect((await api().post(`/api/v1/journal-entries/${draft.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);
    const reversed = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-02-20' });
    expect(reversed.status).toBe(201);

    // Before the reversal: 40 from 2025-02-10 (5 days) + 50 left of the opening.
    expect(buckets(row(await aging('CUSTOMER', '2025-02-15'), 'C3'))).toEqual({ d1_30: '40.000', d31_60: '50.000' });
    // After it: the entry is gone.
    expect(buckets(row(await aging('CUSTOMER', '2025-02-25'), 'C3'))).toEqual({ d31_60: '50.000' });
  });

  it('unallocated receipts show as unapplied; balances match the ledger', async () => {
    const asOf = '2025-04-15';
    const customers = await aging('CUSTOMER', asOf);
    // C1: invoice 116 − return 11.6 still open; the 50 receipt is no longer allocated.
    const c1 = row(customers, 'C1')!;
    expect(buckets(c1)).toEqual({ d61_90: '104.400' });
    expect(m3(c1.total)).toBe('104.400');
    expect(m3(c1.unapplied)).toBe('-50.000');
    expect(m3(c1.balance)).toBe('54.400');

    for (const r of customers.rows) {
      const st = await api()
        .get(`/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${r.partyId}&to=${asOf}`)
        .set(auth(token));
      expect(st.status).toBe(200);
      expect(m3(r.balance)).toBe(m3(st.body.closingBalance));
      expect(m3(new Decimal(r.total).plus(r.unapplied))).toBe(m3(r.balance));
    }
    expect(m3(customers.totals.balance)).toBe(m3(await controlBalance('1103', asOf)));
  });

  // --------------------------------------------- allocation rules (ADR-004 §3)

  it('a cash invoice takes no allocation', async () => {
    const cash = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-05-01',
        customerId: party.C2,
        warehouseId,
        paymentType: 'CASH',
        cashAccountId,
        lines: [{ itemId, qty: '1', unitPrice: '2.000' }],
      });
    expect(cash.status).toBe(201);
    expect((await api().post(`/api/v1/sales-invoices/${cash.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);
    const res = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({
        receiptDate: '2025-05-02',
        partyType: 'CUSTOMER',
        partyId: party.C2,
        cashAccountId,
        amount: '1.000',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: cash.body.id, amount: '1.000' }],
      });
    expect(res.status).toBe(400);
  });

  it('a refund the other way cannot settle an invoice, but can still be made', async () => {
    const open = await sale('C2', '2025-05-01', '5'); // 11.600, credit
    const refund = (body: object) =>
      api()
        .post('/api/v1/payments')
        .set(auth(token))
        .set(idem())
        .send({ paymentDate: '2025-05-03', partyType: 'CUSTOMER', partyId: party.C2, cashAccountId, amount: '5.000', ...body });
    expect(
      (await refund({ allocations: [{ documentType: 'SALES_INVOICE', documentId: open.id, amount: '5.000' }] })).status,
    ).toBe(400);
    expect((await refund({ autoAllocate: true })).status).toBe(400);
    const supplierRefund = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({ receiptDate: '2025-05-03', partyType: 'SUPPLIER', partyId: party.S1, cashAccountId, amount: '1.000', autoAllocate: true });
    expect(supplierRefund.status).toBe(400);

    const plain = await refund({});
    expect(plain.status).toBe(201);
    const left = await api().get(`/api/v1/sales-invoices/${open.id}`).set(auth(token));
    expect(m3(left.body.outstanding)).toBe('11.600');
  });

  it('another tenant sees nothing', async () => {
    const b = await aging('CUSTOMER', '2025-04-15', tokenB);
    expect(b.rows).toEqual([]);
  });
});
