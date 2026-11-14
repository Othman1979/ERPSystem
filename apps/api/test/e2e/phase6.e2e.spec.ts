/**
 * Phase 6 — treasury (BUILD_PLAN §17 Phase 6 acceptance + §10.3/§10.4):
 *  - every posted voucher creates one balanced entry, once (Idempotency-Key);
 *  - an allocation can exceed neither the invoice's nor the voucher's remainder;
 *  - cash invoices never appear in aging;
 *  - a cash box's balance in the report equals its account in the trial balance;
 *  - a voucher with allocations cannot be reversed until they are cancelled;
 *  - auto-allocation settles the oldest invoices first;
 *  - cash transfers post Dr destination / Cr source and reverse cleanly;
 *  - concurrent allocations cannot over-settle an invoice;
 *  - document entries are reversed through their document, not the journal;
 *  - tenant isolation of the new endpoints.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3192;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const key = () => `p6-${RUN}-${Math.random().toString(36).slice(2)}`;
const idem = () => ({ 'Idempotency-Key': key() });
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

describe('Phase 6 — treasury', () => {
  let token = '';
  let tokenB = '';
  let tenantId: bigint;
  let warehouseId = '';
  let itemId = '';
  let customerId = '';
  let customer2Id = '';
  let cashAccountId = '';
  let bankAccountId = '';
  let firstReceiptId = '';
  let firstAllocationId = '';
  let transferId = '';

  // ------------------------------------------------------------- helpers

  async function creditSale(date: string, qty: string, price: string, customer = customerId, paymentType = 'CREDIT') {
    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: date,
        customerId: customer,
        warehouseId,
        paymentType,
        ...(paymentType === 'CASH' ? { cashAccountId } : {}),
        lines: [{ itemId, qty, unitPrice: price }],
      });
    expect(inv.status).toBe(201);
    const posted = await api().post(`/api/v1/sales-invoices/${inv.body.id}/post`).set(auth(token)).set(idem());
    expect(posted.status).toBe(201);
    return inv.body.id as string;
  }

  async function outstanding(invoiceId: string) {
    return m3((await api().get(`/api/v1/sales-invoices/${invoiceId}`).set(auth(token))).body.outstanding);
  }

  async function receipt(body: object, k = key()) {
    return api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set('Idempotency-Key', k)
      .send({ partyType: 'CUSTOMER', partyId: customerId, cashAccountId, ...body });
  }

  async function entriesFor(sourceType: string, sourceId: string) {
    return (await db.query(
      `SELECT id, posting_kind AS kind, total_debit AS dr, total_credit AS cr
         FROM journal_entries WHERE tenant_id = ? AND source_type = ? AND source_id = ?`,
      [tenantId, sourceType, sourceId],
    )) as { id: bigint; kind: string; dr: string; cr: string }[];
  }

  async function trialBalance() {
    return (await api().get('/api/v1/reports/trial-balance').set(auth(token))).body as {
      balanced: boolean;
      rows: { code: string; accountId: string; totalDebit: string; totalCredit: string }[];
    };
  }

  // --------------------------------------------------------------- setup

  it('setup', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `P6 ${RUN}`, ownerName: 'Owner', email: `p6-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `P6 B ${RUN}`, ownerName: 'Owner B', email: `p6b-${RUN}@test.dev`, password: PASS });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;
    tenantId = ((await db.query('SELECT id FROM tenants WHERE name = ?', [`P6 ${RUN}`])) as { id: bigint }[])[0].id;

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs })).body.id;
    customerId = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C1', nameAr: 'عميل 1', partyType: 'CUSTOMER' })
    ).body.id;
    customer2Id = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C2', nameAr: 'عميل 2', partyType: 'CUSTOMER' })
    ).body.id;

    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: '2025-01-02',
        adjustmentType: 'OPENING',
        warehouseId,
        lines: [{ itemId, qty: '1000', unitCost: '2.000' }],
      });
    await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(token)).set(idem());

    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    const flat: { id: string; controlType?: string }[] = [];
    const walk = (ns: { id: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
    cashAccountId = flat.find((a) => a.controlType === 'CASH')!.id;
    bankAccountId = flat.find((a) => a.controlType === 'BANK')!.id;
    expect(
      (await api().post('/api/v1/cash-boxes').set(auth(token)).send({ code: 'CB1', name: 'Main box', accountId: cashAccountId }))
        .status,
    ).toBe(201);
    expect(
      (await api().post('/api/v1/bank-accounts').set(auth(token)).send({ bankName: 'Bank 1', accountId: bankAccountId }))
        .status,
    ).toBe(201);
  });

  // ------------------------------------------------------------- acceptance

  it('a posted voucher creates one balanced entry, once — the key is required and replays', async () => {
    const inv = await creditSale('2025-02-01', '50', '2.000'); // 100 + 16 = 116.000
    expect(await outstanding(inv)).toBe('116.000');

    const missing = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .send({ receiptDate: '2025-02-02', partyType: 'CUSTOMER', partyId: customerId, cashAccountId, amount: '50.000' });
    expect(missing.status).toBe(400);

    const k = key();
    const body = {
      receiptDate: '2025-02-02',
      amount: '50.000',
      allocations: [{ documentType: 'SALES_INVOICE', documentId: inv, amount: '50.000' }],
    };
    const first = await receipt(body, k);
    expect(first.status).toBe(201);
    const replay = await receipt(body, k);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    firstReceiptId = first.body.id;
    firstAllocationId = first.body.allocations[0].id;

    const entries = await entriesFor('RECEIPT', firstReceiptId);
    expect(entries).toHaveLength(1);
    expect(m3(entries[0].dr)).toBe('50.000');
    expect(m3(entries[0].cr)).toBe('50.000');
    expect(await outstanding(inv)).toBe('66.000');
    expect(m3(first.body.unallocatedAmount)).toBe('0.000');
  });

  it('an allocation exceeds neither the invoice remainder nor the voucher remainder', async () => {
    const inv = await creditSale('2025-02-03', '25', '2.000'); // 58.000

    const overVoucher = await receipt({
      receiptDate: '2025-02-04',
      amount: '30.000',
      allocations: [{ documentType: 'SALES_INVOICE', documentId: inv, amount: '40.000' }],
    });
    expect(overVoucher.status).toBe(400);

    const open = await receipt({ receiptDate: '2025-02-04', amount: '100.000' }); // on account
    expect(open.status).toBe(201);
    expect(m3(open.body.unallocatedAmount)).toBe('100.000');

    const overInvoice = await api()
      .post(`/api/v1/receipts/${open.body.id}/allocations`)
      .set(auth(token))
      .set(idem())
      .send({ allocations: [{ documentType: 'SALES_INVOICE', documentId: inv, amount: '60.000' }] });
    expect(overInvoice.status).toBe(400);

    const ok = await api()
      .post(`/api/v1/receipts/${open.body.id}/allocations`)
      .set(auth(token))
      .set(idem())
      .send({ allocations: [{ documentType: 'SALES_INVOICE', documentId: inv, amount: '58.000' }] });
    expect(ok.status).toBe(201);
    expect(m3(ok.body.unallocatedAmount)).toBe('42.000');
    expect(await outstanding(inv)).toBe('0.000');

    const nothingLeft = await api()
      .post(`/api/v1/receipts/${open.body.id}/allocations`)
      .set(auth(token))
      .set(idem())
      .send({ allocations: [{ documentType: 'SALES_INVOICE', documentId: inv, amount: '1.000' }] });
    expect(nothingLeft.status).toBe(400);
  });

  it('auto-allocation settles the oldest open invoices first', async () => {
    const older = await creditSale('2025-03-01', '10', '2.000', customer2Id); // 23.200
    const newer = await creditSale('2025-03-05', '10', '2.000', customer2Id); // 23.200
    const res = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({
        receiptDate: '2025-03-06',
        partyType: 'CUSTOMER',
        partyId: customer2Id,
        cashAccountId,
        amount: '30.000',
        autoAllocate: true,
      });
    expect(res.status).toBe(201);
    expect(await outstanding(older)).toBe('0.000');
    expect(await outstanding(newer)).toBe('16.400'); // 23.200 − (30.000 − 23.200)
    expect(m3(res.body.unallocatedAmount)).toBe('0.000');
  });

  it('cash invoices never appear in aging; credit balances do', async () => {
    await creditSale('2025-03-10', '5', '2.000', customer2Id, 'CASH'); // settled at sale
    const aging = await api().get('/api/v1/reports/aging?partyType=CUSTOMER').set(auth(token));
    expect(aging.status).toBe(200);
    const c2 = (aging.body.rows as { partyId: string; total: string }[]).find((r) => r.partyId === customer2Id)!;
    expect(m3(c2.total)).toBe('16.400'); // only the newer credit invoice remains
    const c1 = (aging.body.rows as { partyId: string; total: string }[]).find((r) => r.partyId === customerId)!;
    expect(m3(c1.total)).toBe('66.000');
    // Invoices from 2025 are far past due "today": all in the 90+ bucket.
    expect(m3(aging.body.totals.d90plus)).toBe(m3(aging.body.totals.total));
  });

  it('a cash invoice owes nothing and cannot take a receipt allocation', async () => {
    const cashInv = await creditSale('2025-03-11', '2', '2.000', customerId, 'CASH'); // 4.640, settled at sale
    expect(await outstanding(cashInv)).toBe('0.000');
    const res = await receipt({
      receiptDate: '2025-03-12',
      amount: '4.640',
      allocations: [{ documentType: 'SALES_INVOICE', documentId: cashInv, amount: '4.640' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
  it('a voucher with allocations cannot be reversed until they are cancelled', async () => {
    const blocked = await api()
      .post(`/api/v1/receipts/${firstReceiptId}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-04-01' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('VOUCHER_HAS_ALLOCATIONS');

    const cancel = await api().post(`/api/v1/allocations/${firstAllocationId}/cancel`).set(auth(token)).set(idem());
    expect(cancel.status).toBe(201);
    const again = await api().post(`/api/v1/allocations/${firstAllocationId}/cancel`).set(auth(token)).set(idem());
    expect(again.status).toBe(409);

    const reversed = await api()
      .post(`/api/v1/receipts/${firstReceiptId}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-04-01' });
    expect(reversed.status).toBe(201);
    expect(reversed.body.reversedAt).not.toBeNull();

    const entries = await entriesFor('RECEIPT', firstReceiptId);
    expect(entries.map((e) => e.kind).sort()).toEqual(['POST', 'REVERSAL']);
    expect((await trialBalance()).balanced).toBe(true);

    const twice = await api()
      .post(`/api/v1/receipts/${firstReceiptId}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-04-02' });
    expect(twice.status).toBe(409);
  });

  it('cash transfer: Dr destination / Cr source, then a clean reversal', async () => {
    const before = await api().get('/api/v1/treasury/balances').set(auth(token));
    const bal = (body: { rows: { kind: string; balance: string }[] }, kind: string) =>
      new Decimal(body.rows.find((r) => r.kind === kind)!.balance);
    const cashBefore = bal(before.body, 'CASH_BOX');
    const bankBefore = bal(before.body, 'BANK_ACCOUNT');

    const same = await api()
      .post('/api/v1/cash-transfers')
      .set(auth(token))
      .set(idem())
      .send({ transferDate: '2025-04-05', fromAccountId: cashAccountId, toAccountId: cashAccountId, amount: '1.000' });
    expect(same.status).toBe(400);

    const t = await api()
      .post('/api/v1/cash-transfers')
      .set(auth(token))
      .set(idem())
      .send({ transferDate: '2025-04-05', fromAccountId: cashAccountId, toAccountId: bankAccountId, amount: '25.000' });
    expect(t.status).toBe(201);
    expect(t.body.transferNo).toMatch(/^CT-2025-/);
    transferId = t.body.id;

    const lines = (
      (await api().get(`/api/v1/journal-entries/${t.body.journalEntry.id}`).set(auth(token))).body.lines as {
        accountId: string;
        debit: string;
        credit: string;
      }[]
    ).map((l) => `${l.accountId}:${m3(l.debit)}/${m3(l.credit)}`);
    expect(lines.sort()).toEqual([`${bankAccountId}:25.000/0.000`, `${cashAccountId}:0.000/25.000`].sort());

    const mid = await api().get('/api/v1/treasury/balances').set(auth(token));
    expect(bal(mid.body, 'CASH_BOX').toFixed(3)).toBe(cashBefore.minus(25).toFixed(3));
    expect(bal(mid.body, 'BANK_ACCOUNT').toFixed(3)).toBe(bankBefore.plus(25).toFixed(3));

    const rev = await api()
      .post(`/api/v1/cash-transfers/${transferId}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-04-06' });
    expect(rev.status).toBe(201);
    const after = await api().get('/api/v1/treasury/balances').set(auth(token));
    expect(bal(after.body, 'CASH_BOX').toFixed(3)).toBe(cashBefore.toFixed(3));
    expect(bal(after.body, 'BANK_ACCOUNT').toFixed(3)).toBe(bankBefore.toFixed(3));
  });

  it('the cash box balance in the report equals its account in the trial balance', async () => {
    const report = await api().get('/api/v1/treasury/balances').set(auth(token));
    const box = (report.body.rows as { kind: string; balance: string; account: { id: string } }[]).find(
      (r) => r.kind === 'CASH_BOX',
    )!;
    const row = (await trialBalance()).rows.find((r) => r.accountId === box.account.id)!;
    expect(m3(box.balance)).toBe(m3(new Decimal(row.totalDebit).minus(row.totalCredit)));
  });

  it('two receipts racing for the same invoice cannot over-settle it (§10.4)', async () => {
    const inv = await creditSale('2025-05-01', '10', '2.000'); // 23.200
    const race = () =>
      receipt({
        receiptDate: '2025-05-02',
        amount: '23.200',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: inv, amount: '23.200' }],
      });
    const results = await Promise.all([race(), race(), race()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await outstanding(inv)).toBe('0.000');
  });

  it("a document's journal entry is reversed through the document, not the journal", async () => {
    const [entry] = await entriesFor('SALES_INVOICE', await creditSale('2025-05-10', '1', '2.000'));
    const res = await api()
      .post(`/api/v1/journal-entries/${entry.id}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-05-11' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVERSE_VIA_DOCUMENT');
  });

  it('tenant isolation for transfers, allocations and treasury reports', async () => {
    expect((await api().get('/api/v1/cash-transfers').set(auth(tokenB))).body).toMatchObject({ items: [], total: 0 });
    expect((await api().get(`/api/v1/cash-transfers/${transferId}`).set(auth(tokenB))).status).toBe(404);
    const cancel = await api().post(`/api/v1/allocations/${firstAllocationId}/cancel`).set(auth(tokenB)).set(idem());
    expect(cancel.status).toBe(404);
    const aging = await api().get('/api/v1/reports/aging?partyType=CUSTOMER').set(auth(tokenB));
    expect(aging.body.rows).toEqual([]);
    const balances = await api().get('/api/v1/treasury/balances').set(auth(tokenB));
    // B sees only its own (unlinked, untouched) cash/bank accounts — none of A's.
    const bRows = balances.body.rows as { kind: string; balance: string; account: { id: string } }[];
    expect(bRows.length).toBeGreaterThan(0);
    expect(bRows.every((r) => r.kind === 'ACCOUNT' && m3(r.balance) === '0.000')).toBe(true);
    expect(bRows.some((r) => r.account.id === cashAccountId || r.account.id === bankAccountId)).toBe(false);
  });

  it('the trial balance stays balanced', async () => {
    expect((await trialBalance()).balanced).toBe(true);
  });
});
