/**
 * Phase 22 (ADR-037): incoming and outgoing cheques.
 * Golden results K1–K3 in BUILD_PLAN §18. Real MariaDB + built API. Run `pnpm --filter api build` first.
 */
import 'dotenv/config';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);

let boot: Booted;
let h: ReturnType<typeof kit>;
let token = '';
let tokenB = '';
let tenantId: bigint;
const accounts: Record<string, string> = {};
let customerId = '';
let supplierId = '';

interface Cheque {
  id: string;
  status: string;
  direction: string;
  chequeNo: string;
  dueDate: string;
  amount: string;
  bankAccount: { id: string } | null;
  events: { action: string; undoneAt: string | null; journalEntry: { id: string } | null }[];
}

async function register(prefix: string) {
  const body = h.ok(
    await h.api().post('/api/v1/auth/register').send({
      tenantName: `Cheques ${prefix} ${RUN}`,
      ownerName: 'Owner',
      email: `cheques-${prefix}-${RUN}@test.dev`,
      password: PASS,
    }),
    201,
    `register ${prefix}`,
  );
  return body.accessToken as string;
}

const post = async (path: string, body: object, what: string, status = 201) =>
  h.ok(await h.api().post(`/api/v1/${path}`).set(h.auth(token)).send(body), status, what);

async function postJournal(date: string, lines: object[]) {
  const draft = h.ok(
    await h.api().post('/api/v1/journal-entries').set(h.auth(token)).send({ entryDate: date, lines }),
    201,
    `draft journal ${date}`,
  );
  return h.ok(await h.act(token, `journal-entries/${draft.id}/post`), 201, `post journal ${date}`);
}

const receiptByCheque = async (date: string, amount: string, chequeNo: string, dueDate: string, bankName = 'بنك الإسكان') =>
  h.act(token, 'receipts', {
    receiptDate: date,
    partyType: 'CUSTOMER',
    partyId: customerId,
    amount,
    cheque: { chequeNo, bankName, dueDate },
  });

const paymentByCheque = async (date: string, amount: string, chequeNo: string, dueDate: string) =>
  h.act(token, 'payments', {
    paymentDate: date,
    partyType: 'SUPPLIER',
    partyId: supplierId,
    cashAccountId: accounts['1102'],
    amount,
    cheque: { chequeNo, dueDate },
  });

const chequeOf = async (no: string) => {
  const page = h.ok(await h.get(token, `cheques?q=${no}`), 200, `find ${no}`) as { items: Cheque[] };
  const hit = page.items.find((c) => c.chequeNo === no);
  if (!hit) throw new Error(`cheque ${no} not found`);
  return h.ok(await h.get(token, `cheques/${hit.id}`), 200, `cheque ${no}`) as Cheque;
};

/** Debit minus credit on one account (optionally one party), straight from the ledger. */
async function balance(code: string, partyId?: string) {
  const [row] = (await boot.db.query(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
      WHERE l.tenant_id = ? AND l.account_id = ? ${partyId ? 'AND l.party_id = ?' : ''}`,
    [tenantId, accounts[code], ...(partyId ? [partyId] : [])],
  )) as { b: string }[];
  return m3(row!.b);
}

async function expectBalanced() {
  const tb = await h.get(token, 'reports/trial-balance?from=2031-01-01&to=2031-12-31');
  expect(tb.status).toBe(200);
  expect(tb.body.balanced).toBe(true);
}

beforeAll(async () => {
  boot = await bootApi(3861);
  h = kit(boot.base, `chq-${RUN}`);
  token = await register('a');
  tokenB = await register('b');
  const [tenant] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [`Cheques a ${RUN}`])) as { id: bigint }[];
  tenantId = tenant!.id;
  h.ok(
    await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: '2031', startDate: '2031-01-01', endDate: '2031-12-31' }),
    201,
    'year 2031',
  );
  const chart = h.ok(await h.get(token, 'accounts'), 200, 'accounts') as { id: string; code: string }[];
  for (const account of chart) accounts[account.code] = account.id;
  await post('bank-accounts', { bankName: 'Arab Bank', accountId: accounts['1102'] }, 'bank account');
  customerId = String(((await post('parties', { code: `C${RUN}`, nameAr: 'عميل الشيكات', partyType: 'CUSTOMER' }, 'customer')) as { id: string }).id);
  supplierId = String(((await post('parties', { code: `S${RUN}`, nameAr: 'مورد الشيكات', partyType: 'SUPPLIER' }, 'supplier')) as { id: string }).id);
}, 90_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('K1 — incoming cheques: collect and return', () => {
  it('posts received cheques on cheques under collection', async () => {
    expect(accounts['1106']).toBeDefined();
    expect(accounts['2105']).toBeDefined();
    await postJournal('2031-01-02', [
      { accountId: accounts['1103'], debit: '1000.000', partyType: 'CUSTOMER', partyId: customerId },
      { accountId: accounts['4101'], credit: '1000.000' },
    ]);
    h.ok(await receiptByCheque('2031-01-10', '600.000', `CH-100-${RUN}`, '2031-02-15'), 201, 'receipt CH-100');
    h.ok(await receiptByCheque('2031-01-12', '400.000', `CH-101-${RUN}`, '2031-03-01'), 201, 'receipt CH-101');

    expect(await balance('1106')).toBe('1000.000');
    expect(await balance('1103', customerId)).toBe('0.000');
    const ch100 = await chequeOf(`CH-100-${RUN}`);
    expect(ch100.status).toBe('IN_HAND');
    expect(ch100.dueDate).toBe('2031-02-15');
    await expectBalanced();
  });

  it('deposits and collects CH-100 into the bank', async () => {
    const id = (await chequeOf(`CH-100-${RUN}`)).id;
    h.ok(await h.act(token, `cheques/${id}/deposit`, { date: '2031-02-10', bankAccountId: accounts['1102'] }), 201, 'deposit');
    expect(await balance('1106')).toBe('1000.000');
    const collected = h.ok(await h.act(token, `cheques/${id}/collect`, { date: '2031-02-15' }), 201, 'collect') as Cheque;
    expect(collected.status).toBe('COLLECTED');
    expect(await balance('1102')).toBe('600.000');
    expect(await balance('1106')).toBe('400.000');
    await expectBalanced();
  });

  it('returns CH-101 to the customer', async () => {
    const id = (await chequeOf(`CH-101-${RUN}`)).id;
    h.ok(await h.act(token, `cheques/${id}/deposit`, { date: '2031-02-25', bankAccountId: accounts['1102'] }), 201, 'deposit');
    const returned = h.ok(await h.act(token, `cheques/${id}/return`, { date: '2031-03-02', notes: 'insufficient funds' }), 201, 'return') as Cheque;
    expect(returned.status).toBe('RETURNED');
    expect(await balance('1106')).toBe('0.000');
    expect(await balance('1103', customerId)).toBe('400.000');
    await expectBalanced();
  });
});

describe('K2 — outgoing cheque: issue, clear and bank reconciliation', () => {
  it('posts an issued cheque on post-dated cheques payable, then clears it from the bank', async () => {
    await postJournal('2031-01-03', [
      { accountId: accounts['5103'], debit: '900.000' },
      { accountId: accounts['2101'], credit: '900.000', partyType: 'SUPPLIER', partyId: supplierId },
    ]);
    h.ok(await paymentByCheque('2031-01-15', '900.000', `CQ-500-${RUN}`, '2031-02-20'), 201, 'payment CQ-500');
    expect(await balance('2105')).toBe('-900.000');
    expect(await balance('2101', supplierId)).toBe('0.000');

    const cheque = await chequeOf(`CQ-500-${RUN}`);
    expect(cheque.status).toBe('ISSUED');
    expect(cheque.bankAccount?.id).toBe(accounts['1102']);
    h.ok(await h.act(token, `cheques/${cheque.id}/clear`, { date: '2031-02-20' }), 201, 'clear');
    expect(await balance('2105')).toBe('0.000');
    expect(await balance('1102')).toBe('-300.000');

    const bank = (h.ok(await h.get(token, 'bank-accounts'), 200, 'bank accounts') as { id: string; accountId: string }[]).find(
      (b) => String(b.accountId) === accounts['1102'],
    )!;
    const statement = h.ok(
      await h.api().post('/api/v1/bank-statements').set(h.auth(token)).send({
        bankAccountId: bank.id,
        startDate: '2031-02-01',
        endDate: '2031-02-28',
        openingBalance: '0.000',
        closingBalance: '-300.000',
      }),
      201,
      'statement',
    ) as { outstandingPayments: { amount: string; entryDate: string }[] };
    expect(statement.outstandingPayments).toEqual(
      expect.arrayContaining([expect.objectContaining({ amount: '-900.000', entryDate: '2031-02-20' })]),
    );
    await expectBalanced();
  });
});

describe('K3 — rejections and undo', () => {
  it('refuses moves out of order and duplicate numbers', async () => {
    const res = await receiptByCheque('2031-03-05', '50.000', `CH-200-${RUN}`, '2031-04-01');
    h.ok(res, 201, 'receipt CH-200');
    const ch200 = await chequeOf(`CH-200-${RUN}`);
    expect(h.err(await h.act(token, `cheques/${ch200.id}/collect`, { date: '2031-03-06' }))).toEqual([409, 'CHEQUE_INVALID_STATUS']);
    expect(h.err(await h.act(token, `cheques/${ch200.id}/clear`, { date: '2031-03-06' }))).toEqual([409, 'CHEQUE_INVALID_STATUS']);
    const cleared = await chequeOf(`CQ-500-${RUN}`);
    expect(h.err(await h.act(token, `cheques/${cleared.id}/clear`, { date: '2031-03-06' }))).toEqual([409, 'CHEQUE_INVALID_STATUS']);
    expect(h.err(await receiptByCheque('2031-03-05', '10.000', `CH-200-${RUN}`, '2031-04-01'))).toEqual([409, 'CHEQUE_DUPLICATE']);
    // Same number from another drawee bank is a different cheque.
    h.ok(await receiptByCheque('2031-03-05', '10.000', `CH-200-${RUN}`, '2031-04-01', 'البنك العربي'), 201, 'other bank');
    expect(h.err(await receiptByCheque('2031-03-05', '10.000', `CH-300-${RUN}`, '2031-02-30'))).toEqual([400, 'VALIDATION']);
    expect(h.err(await h.act(token, 'receipts', {
      receiptDate: '2031-03-05', partyType: 'CUSTOMER', partyId: customerId, amount: '5.000',
      cheque: { chequeNo: `CH-301-${RUN}`, dueDate: '2031-04-01' },
    }))).toEqual([400, 'VALIDATION']);
    expect(h.err(await h.act(token, 'payments', {
      paymentDate: '2031-03-05', expenseAccountId: accounts['5103'], cashAccountId: accounts['1102'], amount: '5.000',
      cheque: { chequeNo: `CQ-301-${RUN}`, dueDate: '2031-04-01' },
    }))).toEqual([400, 'VALIDATION']);
    expect(h.err(await h.act(token, 'payments', {
      paymentDate: '2031-03-05', partyType: 'SUPPLIER', partyId: supplierId, cashAccountId: accounts['1101'], amount: '5.000',
      cheque: { chequeNo: `CQ-302-${RUN}`, dueDate: '2031-04-01' },
    }))[0]).toBe(400);
    await expectBalanced();
  });

  it('undoes a collection and refuses reversing a voucher whose cheque moved', async () => {
    const res = await receiptByCheque('2031-03-10', '70.000', `CH-400-${RUN}`, '2031-03-20');
    const receipt = h.ok(res, 201, 'receipt CH-400') as { id: string };
    const ch = await chequeOf(`CH-400-${RUN}`);
    const bankBefore = await balance('1102');
    h.ok(await h.act(token, `cheques/${ch.id}/deposit`, { date: '2031-03-15', bankAccountId: accounts['1102'] }), 201, 'deposit');
    h.ok(await h.act(token, `cheques/${ch.id}/collect`, { date: '2031-03-20' }), 201, 'collect');
    expect(h.err(await h.act(token, `receipts/${receipt.id}/reverse`, { reversalDate: '2031-03-21' }))).toEqual([409, 'CHEQUE_INVALID_STATUS']);

    const undone = h.ok(await h.act(token, `cheques/${ch.id}/undo`, { date: '2031-03-21' }), 201, 'undo collect') as Cheque;
    expect(undone.status).toBe('DEPOSITED');
    expect(await balance('1102')).toBe(bankBefore);
    const undone2 = h.ok(await h.act(token, `cheques/${ch.id}/undo`, { date: '2031-03-21' }), 201, 'undo deposit') as Cheque;
    expect(undone2.status).toBe('IN_HAND');
    expect(undone2.bankAccount).toBeNull();
    expect(h.err(await h.act(token, `cheques/${ch.id}/undo`, { date: '2031-03-21' }))).toEqual([409, 'CHEQUE_INVALID_STATUS']);

    h.ok(await h.act(token, `receipts/${receipt.id}/reverse`, { reversalDate: '2031-03-22' }), 201, 'reverse receipt');
    const cancelled = await chequeOf(`CH-400-${RUN}`);
    expect(cancelled.status).toBe('CANCELLED');
    // The number is free again once its cheque is cancelled.
    h.ok(await receiptByCheque('2031-03-23', '70.000', `CH-400-${RUN}`, '2031-04-20'), 201, 're-use CH-400');
    await expectBalanced();
  });
});

describe('concurrency, listing, reports and isolation', () => {
  it('collects a cheque once under two concurrent requests', async () => {
    h.ok(await receiptByCheque('2031-04-01', '30.000', `CH-600-${RUN}`, '2031-04-10'), 201, 'receipt CH-600');
    const ch = await chequeOf(`CH-600-${RUN}`);
    h.ok(await h.act(token, `cheques/${ch.id}/deposit`, { date: '2031-04-05', bankAccountId: accounts['1102'] }), 201, 'deposit');
    const before = await balance('1102');
    const results = await Promise.all([
      h.act(token, `cheques/${ch.id}/collect`, { date: '2031-04-10' }),
      h.act(token, `cheques/${ch.id}/collect`, { date: '2031-04-10' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('CHEQUE_INVALID_STATUS');
    expect(await balance('1102')).toBe(m3(Number(before) + 30));
    await expectBalanced();
  });

  it('lists and exports outstanding cheques by due date', async () => {
    const open = h.ok(await h.get(token, 'cheques?open=true&direction=INCOMING'), 200, 'open') as {
      items: Cheque[];
      total: number;
      totalAmount: string;
    };
    expect(open.items.every((c) => ['IN_HAND', 'DEPOSITED'].includes(c.status))).toBe(true);
    const dues = open.items.map((c) => c.dueDate);
    expect([...dues].sort()).toEqual(dues);
    const report = h.ok(await h.get(token, 'cheques/outstanding?dueTo=2031-04-30'), 200, 'report') as {
      items: Cheque[];
      incomingTotal: string;
      outgoingTotal: string;
    };
    expect(report.items.every((c) => c.dueDate <= '2031-04-30')).toBe(true);
    expect(report.outgoingTotal).toBe('0.000');
    for (const format of ['pdf', 'xlsx']) {
      const file = await h.get(token, `cheques/outstanding?format=${format}`).buffer(true);
      expect(file.status).toBe(200);
    }
  });

  it('keeps tenant B out of tenant A cheques', async () => {
    const ch = await chequeOf(`CH-100-${RUN}`);
    expect((await h.get(tokenB, `cheques/${ch.id}`)).status).toBe(404);
    expect((h.ok(await h.get(tokenB, 'cheques'), 200, 'B list') as { total: number }).total).toBe(0);
    expect(h.err(await h.act(tokenB, `cheques/${ch.id}/undo`, { date: '2031-03-01' }))[0]).toBe(404);
    expect(h.err(await h.act(tokenB, `cheques/${ch.id}/return`, { date: '2031-03-01' }))[0]).toBe(404);
  });

  it('needs an Idempotency-Key on every movement', async () => {
    const ch = await chequeOf(`CH-200-${RUN}`);
    const res = await h.api().post(`/api/v1/cheques/${ch.id}/deposit`).set(h.auth(token)).send({ date: '2031-04-01', bankAccountId: accounts['1102'] });
    expect(res.status).toBe(400);
  });
});
