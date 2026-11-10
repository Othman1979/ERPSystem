/**
 * Opening balances on the account, customer/supplier and item forms (ADR-007):
 * each save posts only the change against 3103, dated on the first day of the
 * first fiscal year; opening stock is replaced while the item has no other
 * movement; reports show all of it as the opening position. Real MariaDB
 * (erp_test), built API on :3206. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3206;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `k-${RUN}-${Math.random().toString(36).slice(2)}` });
const m3 = (v: string | number) => new Decimal(v).toFixed(3);

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

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in assertions

describe('Opening balances (ADR-007)', () => {
  let token = '';
  let tokenB = '';
  let period1 = '';
  const acc: Record<string, string> = {};
  const id: Record<string, string> = {};

  const get = async (url: string, t = token) => {
    const res = await api().get(url).set(auth(t));
    expect(res.status).toBe(200);
    return res.body as J;
  };
  const put = (url: string, body: object, t = token) => api().put(url).set(auth(t)).send(body);
  const setAccount = (code: string, body: object) => put(`/api/v1/opening-balances/accounts/${acc[code]}`, body);
  const openingEntries = async () =>
    ((await get('/api/v1/journal-entries?status=POSTED&voucherType=')) as unknown as J[]).filter(
      (e) => e.sourceType === 'OPENING_ENTRY',
    );
  const summaryOf = async (code: string) =>
    ((await get('/api/v1/opening-balances')).accounts as J[]).find((a) => a.accountId === acc[code]) ?? {
      debit: '0',
      credit: '0',
    };

  it('sets up two tenants, a fiscal year, warehouses, items and parties', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `OB ${RUN}`, ownerName: 'Owner', email: `ob-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `OB-B ${RUN}`, ownerName: 'Owner', email: `ob-b-${RUN}@test.dev`, password: PASS });
    tokenB = regB.body.accessToken;

    // Before any fiscal year: nothing is editable and saving says why.
    expect((await get('/api/v1/opening-balances')).editable).toBe(false);

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(fy.status).toBe(201);
    period1 = fy.body.periods[0].id;

    for (const a of (await get('/api/v1/accounts')) as unknown as { id: string; code: string }[]) acc[a.code] = a.id;

    id.w1 = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W1', nameAr: 'رئيسي' })).body.id;
    // The trial plan allows one warehouse; the second goes in directly (as in reports.e2e).
    const [{ tenantId, companyId }] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`OB ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const now = new Date();
    const ins = await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tenantId, companyId, 'W2', 'فرع', now, now],
    );
    id.w2 = String((ins as { insertId: bigint }).insertId);
    const pcs = ((await get('/api/v1/units')) as unknown as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const item = async (code: string, extra: object = {}) => {
      const res = await api().post('/api/v1/items').set(auth(token)).send({ code, nameAr: `صنف ${code}`, baseUnitId: pcs, ...extra });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    id.i1 = await item('I1');
    id.i2 = await item('I2');
    id.svc = await item('SVC', { itemKind: 'SERVICE' });
    const party = async (code: string, partyType: string) => {
      const res = await api().post('/api/v1/parties').set(auth(token)).send({ code, nameAr: `طرف ${code}`, partyType });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    id.c = await party('C1', 'CUSTOMER');
    id.s = await party('S1', 'SUPPLIER');
    id.b = await party('B1', 'BOTH');
  });

  it('posts an account opening balance and later only the change', async () => {
    const before = await get(`/api/v1/opening-balances/accounts/${acc['1101']}`);
    expect(before).toMatchObject({ debit: '0', credit: '0', editable: true, lockedReason: null });

    const first = await setAccount('1101', { debit: '5000' });
    expect(first.status).toBe(200);
    expect(m3(first.body.debit)).toBe('5000.000');

    const second = await setAccount('1101', { debit: '6000.000' });
    expect(m3(second.body.debit)).toBe('6000.000');
    expect((await setAccount('1101', { debit: '6000' })).status).toBe(200); // same → nothing posted

    const entries = await openingEntries();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => m3(e.totalDebit)).sort()).toEqual(['1000.000', '5000.000']);
    for (const e of entries) expect(e.entryDate.slice(0, 10)).toBe('2026-01-01');

    expect((await setAccount('3101', { credit: '20000' })).status).toBe(200);
    const s = await get('/api/v1/opening-balances');
    expect(m3(s.totals.debit)).toBe('6000.000');
    expect(m3(s.totals.credit)).toBe('20000.000');
    // 3103 holds the difference: 6000 Dr vs 20000 Cr → 14000 on the debit side.
    expect(m3(s.difference.debit)).toBe('14000.000');
  });

  it('refuses accounts whose balance comes from elsewhere, and both sides at once', async () => {
    const locked = async (code: string, reason: string) => {
      const res = await setAccount(code, { debit: '10' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'OPENING_BALANCE_LOCKED', details: { reason } });
      expect((await get(`/api/v1/opening-balances/accounts/${acc[code]}`)).lockedReason).toBe(reason);
    };
    await locked('1103', 'CONTROL_ACCOUNT');
    await locked('2101', 'CONTROL_ACCOUNT');
    await locked('1104', 'INVENTORY_ACCOUNT');
    await locked('3103', 'EQUITY_PLUG');
    await locked('4101', 'INCOME_ACCOUNT');
    await locked('5204', 'INCOME_ACCOUNT');
    await locked('1', 'GROUP_ACCOUNT');

    const both = await setAccount('1102', { debit: '1', credit: '1' });
    expect(both.status).toBe(400);
    expect(both.body.error.details).toEqual({ rule: 'ONE_SIDE' });
  });

  it('posts customer and supplier balances on their control accounts', async () => {
    const setParty = (pid: string, body: object) => put(`/api/v1/opening-balances/parties/${pid}`, body);
    expect((await setParty(id.c, { partyType: 'CUSTOMER', debit: '300' })).status).toBe(200);
    expect((await setParty(id.s, { partyType: 'SUPPLIER', credit: '200' })).status).toBe(200);
    expect((await setParty(id.b, { partyType: 'CUSTOMER', debit: '50' })).status).toBe(200);
    expect((await setParty(id.b, { partyType: 'SUPPLIER', credit: '70' })).status).toBe(200);

    const wrong = await setParty(id.c, { partyType: 'SUPPLIER', credit: '1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details).toEqual({ rule: 'PARTY_TYPE' });

    const both = await get(`/api/v1/opening-balances/parties/${id.b}`);
    expect(both.balances.map((b: J) => [b.partyType, m3(b.debit), m3(b.credit)])).toEqual([
      ['CUSTOMER', '50.000', '0.000'],
      ['SUPPLIER', '0.000', '70.000'],
    ]);
    expect(m3((await summaryOf('1103')).debit)).toBe('350.000');
    expect(m3((await summaryOf('2101')).credit)).toBe('270.000');
    // The customers account shows the total but can't be typed into.
    expect(m3((await get(`/api/v1/opening-balances/accounts/${acc['1103']}`)).debit)).toBe('350.000');

    // Aging sees the customer's opening balance.
    const aging = await get('/api/v1/reports/aging?partyType=CUSTOMER&asOf=2026-03-31');
    const c1 = (aging.rows as J[]).find((r) => r.partyId === id.c)!;
    expect(m3(c1.balance)).toBe('300.000');
  });

  it('replaces an item’s opening stock across warehouses', async () => {
    const url = `/api/v1/items/${id.i1}/opening-stock`;
    expect((await get(url)).lockedReason).toBeNull();
    const first = await put(url, {
      lines: [
        { warehouseId: id.w1, qty: '10', unitCost: '5' },
        { warehouseId: id.w2, qty: '4', unitCost: '5' },
      ],
    });
    expect(first.status).toBe(200);
    expect(first.body.lines.map((l: J) => [l.warehouseId, m3(l.qty), m3(l.value)])).toEqual([
      [id.w1, '10.000', '50.000'],
      [id.w2, '4.000', '20.000'],
    ]);
    expect(m3((await summaryOf('1104')).debit)).toBe('70.000');

    const second = await put(url, { lines: [{ warehouseId: id.w1, qty: '12', unitCost: '5.5' }] });
    expect(second.status).toBe(200);
    expect(second.body.lines.map((l: J) => [l.warehouseId, m3(l.qty), m3(l.unitCost), m3(l.value)])).toEqual([
      [id.w1, '12.000', '5.500', '66.000'],
    ]);
    expect(m3((await summaryOf('1104')).debit)).toBe('66.000');
    const balances = (await get(`/api/v1/stock/balances?itemId=${id.i1}&warehouseId=&lowStock=`)) as unknown as J[];
    const onHand = balances.filter((b) => !new Decimal(b.qtyOnHand).isZero());
    expect(onHand.map((b) => [b.warehouseId, m3(b.qtyOnHand)])).toEqual([[id.w1, '12.000']]);

    const dup = await put(url, {
      lines: [
        { warehouseId: id.w1, qty: '1', unitCost: '1' },
        { warehouseId: id.w1, qty: '1', unitCost: '1' },
      ],
    });
    expect(dup.status).toBe(400);
    const svc = await put(`/api/v1/items/${id.svc}/opening-stock`, { lines: [{ warehouseId: id.w1, qty: '1', unitCost: '1' }] });
    expect(svc.status).toBe(409);
    expect(svc.body.error.details.reason).toBe('SERVICE_ITEM');
  });

  it('locks opening stock once the item has another movement', async () => {
    const url = `/api/v1/items/${id.i2}/opening-stock`;
    expect((await put(url, { lines: [{ warehouseId: id.w1, qty: '5', unitCost: '2' }] })).status).toBe(200);

    const draft = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        warehouseId: id.w1,
        adjustmentDate: '2026-02-01',
        adjustmentType: 'IN',
        lines: [{ itemId: id.i2, qty: '1', unitCost: '2' }],
      });
    expect(draft.status).toBe(201);
    expect((await api().post(`/api/v1/stock-adjustments/${draft.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);

    expect((await get(url)).lockedReason).toBe('HAS_MOVEMENTS');
    const res = await put(url, { lines: [{ warehouseId: id.w1, qty: '6', unitCost: '2' }] });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('HAS_MOVEMENTS');
  });

  it('reports show opening balances as the opening position', async () => {
    // A cash sale in March: the only period movement on 1101.
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2026-03-10',
        lines: [
          { accountId: acc['1101'], debit: '100' },
          { accountId: acc['4101'], credit: '100' },
        ],
      });
    expect((await api().post(`/api/v1/journal-entries/${draft.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);

    const tb = await get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-03-31');
    const row = (code: string) => (tb.rows as J[]).find((r) => r.code === code)!;
    expect([row('1101').openingDebit, row('1101').periodDebit, row('1101').closingDebit].map(m3)).toEqual([
      '6000.000',
      '100.000',
      '6100.000',
    ]);
    expect(m3(row('1101').totalDebit)).toBe('6100.000'); // earlier meaning kept: every entry in the range
    expect(m3(row('1104').openingDebit)).toBe('76.000'); // opening stock: I1 66 + I2 10
    expect(m3(row('1104').periodDebit)).toBe('2.000'); // I2's February IN
    expect(m3(row('3103').periodDebit)).toBe('0.000');
    const t = tb.totals;
    expect(m3(t.openingDebit)).toBe(m3(t.openingCredit));
    expect(m3(t.closingDebit)).toBe(m3(t.closingCredit));
    expect(m3(t.periodDebit)).toBe(m3(t.periodCredit));
    expect(tb.balanced).toBe(true);

    // From February on, January's opening sits before `from` — same opening.
    const feb = await get('/api/v1/reports/trial-balance?from=2026-02-01&to=2026-03-31');
    expect(m3((feb.rows as J[]).find((r) => r.code === '1101')!.openingDebit)).toBe('6000.000');

    const gl = await get(`/api/v1/reports/general-ledger?accountId=${acc['1101']}&from=2026-01-01&to=2026-12-31`);
    expect(m3(gl.openingBalance)).toBe('6000.000');
    expect(gl.rows.length).toBe(1);
    expect(m3(gl.closingBalance)).toBe('6100.000');
    const all = await get(`/api/v1/reports/general-ledger?accountId=${acc['1101']}`);
    expect([m3(all.openingBalance), all.rows.length]).toEqual(['6000.000', 1]);

    const ps = await get(`/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${id.c}&from=2026-01-01`);
    expect([m3(ps.openingBalance), ps.rows.length, m3(ps.closingBalance)]).toEqual(['300.000', 0, '300.000']);

    const il = await get(`/api/v1/stock/items/${id.i1}/ledger?from=2026-01-01&to=2026-12-31`);
    expect(il.opening).toEqual({ qty: '12', value: '66.000' });
    expect(il.rows.length).toBe(0);

    const bs = await get('/api/v1/reports/balance-sheet?asOf=2026-03-31');
    expect(bs.balanced).toBe(true);

    const verify = await get('/api/v1/stock/verify');
    expect(verify.mismatches).toEqual([]);
  });

  it('serialises parallel saves: each target is posted once', async () => {
    const before = (await openingEntries()).length;
    const party = () => put(`/api/v1/opening-balances/parties/${id.b}`, { partyType: 'CUSTOMER', debit: '80' });
    const parties = await Promise.all([party(), party(), party()]);
    expect(parties.map((r) => r.status)).toEqual([200, 200, 200]);
    const b = await get(`/api/v1/opening-balances/parties/${id.b}`);
    expect(m3(b.balances.find((x: J) => x.partyType === 'CUSTOMER').debit)).toBe('80.000');

    const account = () => setAccount('1102', { debit: '30' });
    expect((await Promise.all([account(), account(), account()])).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(m3((await get(`/api/v1/opening-balances/accounts/${acc['1102']}`)).debit)).toBe('30.000');
    expect((await openingEntries()).length).toBe(before + 2); // one for the party, one for 1102

    const pcs = ((await get('/api/v1/units')) as unknown as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    id.i3 = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'I3', nameAr: 'صنف I3', baseUnitId: pcs })).body.id;
    const stock = () => put(`/api/v1/items/${id.i3}/opening-stock`, { lines: [{ warehouseId: id.w1, qty: '7', unitCost: '2' }] });
    expect((await Promise.all([stock(), stock(), stock()])).map((r) => r.status)).toEqual([200, 200, 200]);
    const bal = (await get(`/api/v1/stock/balances?itemId=${id.i3}&warehouseId=&lowStock=`)) as unknown as J[];
    expect(bal.map((x) => m3(x.qtyOnHand))).toEqual(['7.000']);
  });

  it('keeps each warehouse’s own cost when costs differ, and a re-save changes nothing', async () => {
    const pcs = ((await get('/api/v1/units')) as unknown as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    id.i4 = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'I4', nameAr: 'صنف I4', baseUnitId: pcs })).body.id;
    const url = `/api/v1/items/${id.i4}/opening-stock`;
    const lines = (b: J) => (b.lines as J[]).map((l) => [l.warehouseId, m3(l.qty), m3(l.unitCost), m3(l.value)]);

    await put(url, { lines: [{ warehouseId: id.w1, qty: '10', unitCost: '10' }, { warehouseId: id.w2, qty: '10', unitCost: '20' }] });
    const replaced = await put(url, { lines: [{ warehouseId: id.w1, qty: '10', unitCost: '10' }, { warehouseId: id.w2, qty: '5', unitCost: '20' }] });
    expect(lines(replaced.body)).toEqual([
      [id.w1, '10.000', '10.000', '100.000'],
      [id.w2, '5.000', '20.000', '100.000'],
    ]);

    // Saving exactly what the form shows posts nothing new.
    const docs = async () => ((await get('/api/v1/stock-adjustments?status=')) as unknown as J[]).length;
    const n = await docs();
    const resave = await put(url, { lines: replaced.body.lines.map((l: J) => ({ warehouseId: l.warehouseId, qty: l.qty, unitCost: l.unitCost })) });
    expect(lines(resave.body)).toEqual(lines(replaced.body));
    expect(await docs()).toBe(n);

    // The reversals mirror the entries they reverse.
    const entries = ((await get('/api/v1/journal-entries?status=POSTED&voucherType=')) as unknown as J[]).filter(
      (e) => e.sourceType === 'STOCK_ADJUSTMENT' && e.postingKind === 'REVERSAL',
    );
    expect(entries.length).toBeGreaterThanOrEqual(2); // I4's two warehouses (plus I1's earlier replace)
    for (const e of entries) {
      const original = await get(`/api/v1/journal-entries/${e.reversalOfId}`);
      expect(m3(e.totalDebit)).toBe(m3(original.totalDebit));
    }
    expect((await get('/api/v1/stock/verify')).mismatches).toEqual([]);
  });

  it('values opening stock at the full unit cost', async () => {
    const pcs = ((await get('/api/v1/units')) as unknown as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    id.i5 = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'I5', nameAr: 'صنف I5', baseUnitId: pcs })).body.id;
    const res = await put(`/api/v1/items/${id.i5}/opening-stock`, { lines: [{ warehouseId: id.w1, qty: '1000', unitCost: '0.0125' }] });
    expect(res.status).toBe(200);
    expect([m3(res.body.lines[0].value), res.body.lines[0].unitCost]).toEqual(['12.500', '0.0125']);
  });

  it('treats opening documents dated later as that period’s movement', async () => {
    // An opening entry reversed in February: January closes at 40, February opens at 40 and moves −40.
    expect((await setAccount('1201', { debit: '40' })).status).toBe(200);
    const entry = (await openingEntries()).find((e) => m3(e.totalDebit) === '40.000')!;
    const rev = await api()
      .post(`/api/v1/journal-entries/${entry.id}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2026-02-15' });
    expect(rev.status).toBe(201);
    const row = async (from: string, to: string) =>
      ((await get(`/api/v1/reports/trial-balance?from=${from}&to=${to}`)).rows as J[]).find((r) => r.code === '1201')!;
    const jan = await row('2026-01-01', '2026-01-31');
    const feb = await row('2026-02-01', '2026-02-28');
    const mar = await row('2026-03-01', '2026-03-31');
    expect([m3(jan.openingDebit), m3(jan.closingDebit)]).toEqual(['40.000', '40.000']);
    expect([m3(feb.openingDebit), m3(feb.periodCredit), m3(feb.closingDebit)]).toEqual(['40.000', '40.000', '0.000']);
    expect(mar === undefined || new Decimal(mar.openingDebit).isZero()).toBe(true);

    // An OPENING stock adjustment dated 2026-03-01 is March movement, not opening stock.
    const pcs = ((await get('/api/v1/units')) as unknown as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    id.i6 = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'I6', nameAr: 'صنف I6', baseUnitId: pcs })).body.id;
    const draft = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({ warehouseId: id.w1, adjustmentDate: '2026-03-01', adjustmentType: 'OPENING', lines: [{ itemId: id.i6, qty: '3', unitCost: '4' }] });
    expect((await api().post(`/api/v1/stock-adjustments/${draft.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);
    const il = await get(`/api/v1/stock/items/${id.i6}/ledger?from=2026-03-01&to=2026-03-31`);
    expect([il.opening.qty, il.rows.length]).toEqual(['0', 1]);
    const os = await get(`/api/v1/items/${id.i6}/opening-stock`);
    expect([os.lines.length, os.lockedReason]).toEqual([0, 'HAS_MOVEMENTS']);
  });

  it('keeps tenants apart', async () => {
    expect((await api().get(`/api/v1/opening-balances/accounts/${acc['1101']}`).set(auth(tokenB))).status).toBe(404);
    expect((await put(`/api/v1/opening-balances/accounts/${acc['1101']}`, { debit: '1' }, tokenB)).status).toBe(404);
    expect((await api().get(`/api/v1/opening-balances/parties/${id.c}`).set(auth(tokenB))).status).toBe(404);
    expect((await put(`/api/v1/opening-balances/parties/${id.c}`, { partyType: 'CUSTOMER', debit: '1' }, tokenB)).status).toBe(404);
    expect((await api().get(`/api/v1/items/${id.i1}/opening-stock`).set(auth(tokenB))).status).toBe(404);
    expect((await put(`/api/v1/items/${id.i1}/opening-stock`, { lines: [] }, tokenB)).status).toBe(404);
    const s = await get('/api/v1/opening-balances', tokenB);
    expect(s.accounts).toEqual([]);
  });

  it('stops changes once the first period is closed', async () => {
    expect((await api().post(`/api/v1/fiscal-periods/${period1}/close`).set(auth(token))).status).toBe(201);
    expect((await get(`/api/v1/opening-balances/accounts/${acc['1102']}`)).editable).toBe(false);
    const res = await setAccount('1102', { debit: '10' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PERIOD_CLOSED');
    expect((await get(`/api/v1/items/${id.i1}/opening-stock`)).lockedReason).toBe('PERIOD_CLOSED');
  });
});
