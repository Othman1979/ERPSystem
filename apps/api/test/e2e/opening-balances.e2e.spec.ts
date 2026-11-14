/**
 * Opening balances (BUILD_PLAN §8.6, ADR-007):
 *  - POST /journal-entries/opening needs an Idempotency-Key; a replay with
 *    the same key returns the same entry, never a second one;
 *  - accounts, customers and suppliers in one entry; the difference goes to
 *    OPENING_BALANCE_EQUITY (3103); party statements equal their lines;
 *  - the inventory account is refused (OPENING_INVENTORY_VIA_STOCK): opening
 *    stock is an OPENING stock adjustment, so the inventory account equals
 *    the stock valuation and stock:verify finds nothing;
 *  - party lines must name a party of the tenant, of the right kind;
 *  - the list filters by sourceType and tags reversed entries;
 *  - tenant isolation.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { wholeStatement } from './support/statements.js';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3206;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `ob-${RUN}-${Math.random().toString(36).slice(2)}` });
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
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

interface EntryLine {
  debit: string;
  credit: string;
  description: string | null;
  partyType: string | null;
  partyId: string | null;
  account: { code: string };
}
interface Entry {
  id: string;
  entryNo: string;
  status: string;
  sourceType: string;
  postingKind: string;
  totalDebit: string;
  totalCredit: string;
  lines: EntryLine[];
  reversals?: { id: string }[];
}

describe('Opening balances', () => {
  let token = '';
  let tokenB = '';
  let warehouseId = '';
  let itemId = '';
  let openingId = '';
  const acc: Record<string, string> = {};
  const party: Record<string, string> = {};

  const opening = (lines: object[], t = token, key = idem()) =>
    api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(t))
      .set(key)
      .send({ entryDate: '2025-01-01', description: 'opening', lines });

  async function openingEntries(t = token) {
    const res = await api().get('/api/v1/journal-entries?sourceType=OPENING_ENTRY&pageSize=100').set(auth(t));
    expect(res.status).toBe(200);
    return (res.body as { items: Entry[] }).items;
  }

  async function trialBalance() {
    const res = await api().get('/api/v1/reports/trial-balance?from=2025-01-01&to=2025-12-31').set(auth(token));
    expect(res.status).toBe(200);
    return res.body as {
      balanced: boolean;
      rows: { code: string; totalDebit: string; totalCredit: string }[];
    };
  }

  /** Debit-minus-credit of one account in the trial balance. */
  const net = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => {
    const r = tb.rows.find((x) => x.code === code);
    return m3(r ? new Decimal(r.totalDebit).minus(r.totalCredit) : 0);
  };

  async function statement(partyType: 'CUSTOMER' | 'SUPPLIER', code: string) {
    const res = await wholeStatement(BASE, `/api/v1/reports/party-statement?partyType=${partyType}&partyId=${party[code]}`, token);
    expect(res.status).toBe(200);
    return m3(res.body.closingBalance);
  }

  it('setup: two tenants, fiscal year, parties, a stock item', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `OB ${RUN}`, ownerName: 'Owner', email: `ob-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `OB B ${RUN}`, ownerName: 'Owner B', email: `obb-${RUN}@test.dev`, password: PASS });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;

    for (const t of [token, tokenB]) {
      const fy = await api()
        .post('/api/v1/fiscal-years')
        .set(auth(t))
        .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
      expect(fy.status).toBe(201);
    }
    warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (
      await api().post('/api/v1/items').set(auth(token)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs, itemKind: 'STOCK' })
    ).body.id;
    for (const [code, partyType] of [
      ['C1', 'CUSTOMER'],
      ['S1', 'SUPPLIER'],
      ['B1', 'BOTH'],
    ] as const) {
      const p = await api().post('/api/v1/parties').set(auth(token)).send({ code, nameAr: code, partyType });
      expect(p.status).toBe(201);
      party[code] = p.body.id;
    }
    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    for (const a of accounts.body as { id: string; code: string }[]) acc[a.code] = a.id;
    for (const code of ['1101', '1102', '1103', '1104', '2101', '3103']) expect(acc[code]).toBeDefined();
  });

  it('requires an Idempotency-Key and posts nothing without one', async () => {
    const res = await api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(token))
      .send({ entryDate: '2025-01-01', lines: [{ accountId: acc['1101'], debit: '10' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(await openingEntries()).toEqual([]);
  });

  it('refuses the inventory account: opening stock is a stock adjustment', async () => {
    const res = await opening([
      { accountId: acc['1101'], debit: '100' },
      { accountId: acc['1104'], debit: '400' },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OPENING_INVENTORY_VIA_STOCK');
    expect(res.body.error.details.line).toBe(2);
    expect(await openingEntries()).toEqual([]);
  });

  it('refuses party lines without a party, with an unknown party, or the wrong kind', async () => {
    const noParty = await opening([{ accountId: acc['1103'], debit: '100' }]);
    expect(noParty.status).toBe(400);

    const unknown = await opening([
      { accountId: acc['1103'], debit: '100', partyType: 'CUSTOMER', partyId: '999999999' },
    ]);
    expect(unknown.status).toBe(404);

    const wrongKind = await opening([
      { accountId: acc['1103'], debit: '100', partyType: 'CUSTOMER', partyId: party.S1 },
    ]);
    expect(wrongKind.status).toBe(400);

    expect(await openingEntries()).toEqual([]);
  });

  it('posts accounts, customers and suppliers, plugging the difference to 3103', async () => {
    const key = idem();
    const lines = [
      { accountId: acc['1101'], debit: '1500', description: 'cash on hand' },
      { accountId: acc['1102'], debit: '2500' },
      { accountId: acc['1103'], debit: '700', partyType: 'CUSTOMER', partyId: party.C1 },
      { accountId: acc['1103'], debit: '50', partyType: 'CUSTOMER', partyId: party.B1 },
      { accountId: acc['2101'], credit: '1200', partyType: 'SUPPLIER', partyId: party.S1 },
    ];
    const res = await opening(lines, token, key);
    expect(res.status).toBe(201);
    const entry = res.body as Entry;
    openingId = entry.id;
    expect(entry.status).toBe('POSTED');
    expect(entry.sourceType).toBe('OPENING_ENTRY');
    expect(entry.entryNo).toMatch(/^OP-/);
    // Debits 4,750 − credits 1,200 = 3,550 credited to opening balances equity.
    expect(m3(entry.totalDebit)).toBe('4750.000');
    expect(m3(entry.totalCredit)).toBe('4750.000');
    const plug = entry.lines.filter((l) => l.account.code === '3103');
    expect(plug).toHaveLength(1);
    expect(m3(plug[0].credit)).toBe('3550.000');
    expect(entry.lines.find((l) => l.account.code === '1101')!.description).toBe('cash on hand');

    // Same key, same body: the stored entry comes back, no second entry.
    const replay = await opening(lines, token, key);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(openingId);
    expect((await openingEntries()).map((e) => e.id)).toEqual([openingId]);

    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(net(tb, '3103')).toBe('-3550.000');
    expect(net(tb, '1103')).toBe('750.000');
    expect(await statement('CUSTOMER', 'C1')).toBe('700.000');
    expect(await statement('CUSTOMER', 'B1')).toBe('50.000');
    // Party statements are debit-minus-credit: a supplier we owe is negative.
    expect(await statement('SUPPLIER', 'S1')).toBe('-1200.000');
  });

  it('opening stock through an OPENING adjustment keeps inventory = valuation', async () => {
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: '2025-01-01',
        adjustmentType: 'OPENING',
        warehouseId,
        lines: [{ itemId, qty: '10', unitCost: '4.500' }],
      });
    expect(adj.status).toBe(201);
    const posted = await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(token)).set(idem());
    expect(posted.status).toBe(201);

    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    const valuation = await api().get('/api/v1/stock/valuation').set(auth(token));
    expect(valuation.status).toBe(200);
    expect(m3(valuation.body.totalValue)).toBe('45.000');
    expect(net(tb, '1104')).toBe(m3(valuation.body.totalValue));
    expect(net(tb, '3103')).toBe('-3595.000');

    const verify = await api().get('/api/v1/stock/verify').set(auth(token));
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);

    // The stock adjustment's entry is not an opening entry in the list.
    expect((await openingEntries()).map((e) => e.id)).toEqual([openingId]);
  });

  it('filters the list by sourceType and refuses unknown filters', async () => {
    const manual = await api().get('/api/v1/journal-entries?sourceType=MANUAL_JOURNAL').set(auth(token));
    expect(manual.status).toBe(200);
    expect(manual.body).toMatchObject({ items: [], total: 0 });
    const bad = await api().get('/api/v1/journal-entries?sourceType=SALES_INVOICE').set(auth(token));
    expect(bad.status).toBe(400);
  });

  it('a reversal lists with the opening entries and the original shows as reversed', async () => {
    const rev = await api()
      .post(`/api/v1/journal-entries/${openingId}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-01-02' });
    expect(rev.status).toBe(201);

    const list = await openingEntries();
    expect(list).toHaveLength(2);
    const original = list.find((e) => e.id === openingId)!;
    expect(original.reversals).toHaveLength(1);
    expect(list.find((e) => e.id !== openingId)!.postingKind).toBe('REVERSAL');

    // Only the opening stock remains against 3103.
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(net(tb, '3103')).toBe('-45.000');
  });

  it("tenant isolation: B sees none of A's opening entries and cannot use A's accounts or parties", async () => {
    expect(await openingEntries(tokenB)).toEqual([]);
    expect((await api().get(`/api/v1/journal-entries/${openingId}`).set(auth(tokenB))).status).toBe(404);

    const foreignAccount = await opening([{ accountId: acc['1101'], debit: '10' }], tokenB);
    expect(foreignAccount.status).toBe(404);

    const accountsB = await api().get('/api/v1/accounts').set(auth(tokenB));
    const customersB = (accountsB.body as { id: string; code: string }[]).find((a) => a.code === '1103')!.id;
    const foreignParty = await opening(
      [{ accountId: customersB, debit: '10', partyType: 'CUSTOMER', partyId: party.C1 }],
      tokenB,
    );
    expect(foreignParty.status).toBe(404);
    expect(await openingEntries(tokenB)).toEqual([]);
  });
});
