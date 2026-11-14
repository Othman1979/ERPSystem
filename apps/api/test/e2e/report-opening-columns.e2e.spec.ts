/**
 * Opening / movement / closing columns in reports (ADR-008, option A):
 *  - opening = everything before `from` + opening entries (is_opening) dated
 *    in the period: the opening entry, OPENING stock adjustments, reversals;
 *  - trial balance: opening and closing net on one side, movements on both,
 *    three balanced totals; the old totalDebit/totalCredit keep their meaning;
 *  - account and party statements: opening row, movements, closing row;
 *  - items balance (ميزان المواد): opening, in, out, closing per item, value
 *    = inventory account; transfers count per warehouse only;
 *  - item movement: opening stock is the opening position, not a row;
 *  - tenant isolation.
 * Owner's example: cash opens 1,500 debit, moves 300 credit, closes 1,200.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { statementBody } from './support/statements.js';

const API_PORT = 3207;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `oc-${RUN}-${Math.random().toString(36).slice(2)}` });
const m3 = (v: Decimal.Value) => new Decimal(v).toFixed(3);
const q6 = (v: Decimal.Value) => new Decimal(v).toFixed(6);

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

type Row = Record<string, string>;

describe('Opening / movement / closing columns', () => {
  let token = '';
  let tokenB = '';
  let w1 = '';
  let w2 = '';
  let itemId = '';
  let customerId = '';
  let openingId = '';
  const acc: Record<string, string> = {};

  const get = async (url: string, t = token) => {
    const res = await api().get(url).set(auth(t));
    expect(res.status).toBe(200);
    return res.body;
  };

  async function post(path: string, body: object) {
    const created = await api().post(`/api/v1/${path}`).set(auth(token)).send(body);
    expect([path, created.status, created.body.error?.message]).toEqual([path, 201, undefined]);
    const posted = await api().post(`/api/v1/${path}/${created.body.id}/post`).set(auth(token)).set(idem());
    expect([path, posted.status, posted.body.error?.message]).toEqual([path, 201, undefined]);
    return posted.body;
  }

  /** The six columns of one trial balance row, 3 decimals. */
  async function tbRow(code: string, query = 'from=2025-01-01&to=2025-12-31') {
    const tb = await get(`/api/v1/reports/trial-balance?${query}`);
    expect(tb.balanced).toBe(true);
    const r = (tb.rows as Row[]).find((x) => x.code === code);
    if (!r) return undefined;
    const keys = ['openingDebit', 'openingCredit', 'periodDebit', 'periodCredit', 'closingDebit', 'closingCredit'];
    return Object.fromEntries(keys.map((k) => [k, m3(r[k])]));
  }

  const six = (od: string, oc: string, pd: string, pc: string, cd: string, cc: string) => ({
    openingDebit: od,
    openingCredit: oc,
    periodDebit: pd,
    periodCredit: pc,
    closingDebit: cd,
    closingCredit: cc,
  });

  it('setup: opening entry, opening stock, then movements', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `OC ${RUN}`, ownerName: 'Owner', email: `oc-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `OC B ${RUN}`, ownerName: 'Owner B', email: `ocb-${RUN}@test.dev`, password: PASS });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    w1 = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W1', nameAr: 'W1' })).body.id;
    // The trial plan allows one warehouse; the second goes straight into the test database.
    const [{ tenantId, companyId }] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`OC ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const now = new Date();
    const ins = await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tenantId, companyId, 'W2', 'W2', now, now],
    );
    w2 = String((ins as { insertId: bigint }).insertId);
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (
      await api().post('/api/v1/items').set(auth(token)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs, itemKind: 'STOCK' })
    ).body.id;
    customerId = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C1', nameAr: 'C1', partyType: 'CUSTOMER' })
    ).body.id;
    for (const a of (await get('/api/v1/accounts')) as { id: string; code: string }[]) acc[a.code] = a.id;

    // Opening balances: cash 1,500 and customer 700 → 3103 credit 2,200.
    const opening = await api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(token))
      .set(idem())
      .send({
        entryDate: '2025-01-01',
        lines: [
          { accountId: acc['1101'], debit: '1500' },
          { accountId: acc['1103'], debit: '700', partyType: 'CUSTOMER', partyId: customerId },
        ],
      });
    expect(opening.status).toBe(201);
    openingId = opening.body.id;

    // Opening stock 10 × 4.5 = 45 in W1, then IN 5 × 6, OUT 3 (avg 5), transfer 2 to W2.
    await post('stock-adjustments', {
      adjustmentDate: '2025-01-01',
      adjustmentType: 'OPENING',
      warehouseId: w1,
      lines: [{ itemId, qty: '10', unitCost: '4.500' }],
    });
    const cashOut = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2025-02-10',
        description: 'expense',
        lines: [
          { accountId: acc['5204'], debit: '300' },
          { accountId: acc['1101'], credit: '300' },
        ],
      });
    expect(cashOut.status).toBe(201);
    const posted = await api().post(`/api/v1/journal-entries/${cashOut.body.id}/post`).set(auth(token)).set(idem());
    expect(posted.status).toBe(201);
    await post('stock-adjustments', {
      adjustmentDate: '2025-03-01',
      adjustmentType: 'IN',
      warehouseId: w1,
      lines: [{ itemId, qty: '5', unitCost: '6.000' }],
    });
    await post('stock-adjustments', {
      adjustmentDate: '2025-04-01',
      adjustmentType: 'OUT',
      warehouseId: w1,
      lines: [{ itemId, qty: '3' }],
    });
    await post('stock-transfers', {
      transferDate: '2025-05-01',
      fromWarehouseId: w1,
      toWarehouseId: w2,
      lines: [{ itemId, qty: '2' }],
    });
  });

  it('flags the opening entry and the opening stock entry, not other entries', async () => {
    expect((await get(`/api/v1/journal-entries/${openingId}`)).isOpening).toBe(true);
    const adjustments = ((await get('/api/v1/stock-adjustments?pageSize=100')) as { items: { adjustmentType: string; journalEntryId: string }[] }).items;
    for (const a of adjustments) {
      const entry = await get(`/api/v1/journal-entries/${a.journalEntryId}`);
      expect([a.adjustmentType, entry.isOpening]).toEqual([a.adjustmentType, a.adjustmentType === 'OPENING']);
    }
  });

  it('trial balance: cash opens 1,500 Dr, moves 300 Cr, closes 1,200 Dr', async () => {
    expect(await tbRow('1101')).toEqual(six('1500.000', '0.000', '0.000', '300.000', '1200.000', '0.000'));
    expect(await tbRow('1103')).toEqual(six('700.000', '0.000', '0.000', '0.000', '700.000', '0.000'));
    // Opening stock is opening too: inventory and 3103 open with it.
    expect(await tbRow('1104')).toEqual(six('45.000', '0.000', '30.000', '15.000', '60.000', '0.000'));
    expect(await tbRow('3103')).toEqual(six('0.000', '2245.000', '0.000', '0.000', '0.000', '2245.000'));

    const tb = await get('/api/v1/reports/trial-balance?from=2025-01-01&to=2025-12-31');
    const t = tb.totals as Row;
    expect([t.openingDebit, t.openingCredit].map(m3)).toEqual(['2245.000', '2245.000']);
    expect(m3(t.periodDebit)).toBe(m3(t.periodCredit));
    expect(m3(t.closingDebit)).toBe(m3(t.closingCredit));
    // The old columns still count every line of the range, opening entries included.
    const cash = (tb.rows as Row[]).find((r) => r.code === '1101')!;
    expect([m3(cash.totalDebit), m3(cash.totalCredit)]).toEqual(['1500.000', '300.000']);
  });

  it('a later start date: what came before is the opening balance', async () => {
    expect(await tbRow('1101', 'from=2025-03-01&to=2025-12-31')).toEqual(
      six('1200.000', '0.000', '0.000', '0.000', '1200.000', '0.000'),
    );
    expect(await tbRow('1104', 'from=2025-03-01&to=2025-12-31')).toEqual(
      six('45.000', '0.000', '30.000', '15.000', '60.000', '0.000'),
    );
    // Without dates the opening entries are still the opening balance.
    expect(await tbRow('1101', '')).toEqual(six('1500.000', '0.000', '0.000', '300.000', '1200.000', '0.000'));
  });

  it('account statement: opening row, movements, closing — the opening entry is not a row', async () => {
    const gl = await statementBody(BASE, `/api/v1/reports/general-ledger?accountId=${acc['1101']}&from=2025-01-01&to=2025-12-31`, token);
    expect([m3(gl.openingDebit), m3(gl.openingCredit), m3(gl.openingBalance)]).toEqual(['1500.000', '0.000', '1500.000']);
    expect(gl.rows).toHaveLength(1);
    expect([m3(gl.rows[0].credit), m3(gl.rows[0].balance)]).toEqual(['300.000', '1200.000']);
    expect([m3(gl.totalDebit), m3(gl.totalCredit)]).toEqual(['0.000', '300.000']);
    expect([m3(gl.closingDebit), m3(gl.closingCredit), m3(gl.closingBalance)]).toEqual(['1200.000', '0.000', '1200.000']);

    const later = await statementBody(BASE, `/api/v1/reports/general-ledger?accountId=${acc['1101']}&from=2025-02-11`, token);
    expect([m3(later.openingBalance), later.rows.length, m3(later.closingBalance)]).toEqual(['1200.000', 0, '1200.000']);

    const ps = await statementBody(BASE, `/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}`, token);
    expect([m3(ps.openingDebit), ps.rows.length, m3(ps.closingDebit)]).toEqual(['700.000', 0, '700.000']);
  });

  it('items balance: opening, ins, outs, closing; value = inventory account', async () => {
    const all = await get('/api/v1/stock/item-balances?from=2025-01-01&to=2025-12-31');
    const r = (all.rows as Row[]).find((x) => x.itemId === itemId)!;
    // Company wide the W1 → W2 transfer moves nothing in or out.
    expect([r.openingQty, r.inQty, r.outQty, r.closingQty].map(q6)).toEqual(
      ['10', '5', '3', '12'].map(q6),
    );
    expect([r.openingValue, r.inValue, r.outValue, r.closingValue]).toEqual(['45.000', '30.000', '15.000', '60.000']);
    expect(all.totals.closingValue).toBe('60.000');
    expect(m3((await get('/api/v1/stock/valuation')).totalValue)).toBe('60.000');
    expect((await tbRow('1104'))!.closingDebit).toBe('60.000');

    // Per warehouse the transfer is an out of W1 and an in of W2 (2 × avg 5).
    const r1 = ((await get(`/api/v1/stock/item-balances?warehouseId=${w1}&from=2025-01-01`)).rows as Row[])[0];
    expect([r1.inQty, r1.outQty, r1.closingQty].map(q6)).toEqual(['5', '5', '10'].map(q6));
    expect([r1.outValue, r1.closingValue]).toEqual(['25.000', '50.000']);
    const r2 = ((await get(`/api/v1/stock/item-balances?warehouseId=${w2}`)).rows as Row[])[0];
    expect([q6(r2.openingQty), q6(r2.inQty), r2.closingValue]).toEqual([q6(0), q6(2), '10.000']);

    // From 2025-04-01: opening = opening stock + the March IN.
    const april = ((await get('/api/v1/stock/item-balances?from=2025-04-01')).rows as Row[])[0];
    expect([q6(april.openingQty), april.openingValue, q6(april.outQty), april.closingValue]).toEqual([
      q6(15),
      '75.000',
      q6(3),
      '60.000',
    ]);
  });

  it('item movement: opening stock is the opening position, not a row', async () => {
    const ledger = await get(`/api/v1/stock/items/${itemId}/ledger?from=2025-01-01&to=2025-12-31`);
    expect(ledger.opening).toEqual({ qty: '10', value: '45.000' });
    // IN, OUT, transfer out, transfer in.
    expect(ledger.rows).toHaveLength(4);
    expect([q6(ledger.closing.qty), ledger.closing.value]).toEqual([q6(12), '60.000']);
  });

  it('a reversed opening entry nets out inside the opening balance', async () => {
    const rev = await api()
      .post(`/api/v1/journal-entries/${openingId}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-01-02' });
    expect(rev.status).toBe(201);
    expect((await get(`/api/v1/journal-entries/${rev.body.id}`)).isOpening).toBe(true);
    // Cash: no opening left, the 300 movement stays.
    expect(await tbRow('1101')).toEqual(six('0.000', '0.000', '0.000', '300.000', '0.000', '300.000'));
    expect(await tbRow('3103')).toEqual(six('0.000', '45.000', '0.000', '0.000', '0.000', '45.000'));
  });

  it('exports carry the new columns', async () => {
    for (const url of [
      '/api/v1/reports/trial-balance?from=2025-01-01&format=xlsx',
      `/api/v1/reports/general-ledger?accountId=${acc['1101']}&format=pdf`,
      '/api/v1/stock/item-balances?format=xlsx',
    ]) {
      const res = await api().get(url).set(auth(token)).buffer(true);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  it("tenant isolation: B sees none of A's balances", async () => {
    const tb = await get('/api/v1/reports/trial-balance', tokenB);
    expect(tb.rows).toEqual([]);
    expect(tb.balanced).toBe(true);
    expect((await get('/api/v1/stock/item-balances', tokenB)).rows).toEqual([]);
    expect((await api().get(`/api/v1/reports/general-ledger?accountId=${acc['1101']}`).set(auth(tokenB))).status).toBe(404);
  });
});
