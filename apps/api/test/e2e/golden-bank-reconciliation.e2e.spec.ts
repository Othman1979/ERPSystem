/**
 * Phase 20 (ADR-035): bank statements, matching and reconciliation.
 * Golden results: R1 adjusted 1295.000, R2 adjusted 1007.500, R3 rejections and reopen.
 * Real MariaDB + built API. Run `pnpm --filter api build` first.
 */
import 'dotenv/config';
import ExcelJS from 'exceljs';
import { addMember } from './support/members.js';
import { bootApi, kit, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);

let boot: Booted;
let h: ReturnType<typeof kit>;
let token = '';
let tokenB = '';
let restricted = '';
const accounts: Record<string, string> = {};
let bankAccountId = '';
let customerId = '';
let january = '';
let february = '';

interface Line {
  id: string;
  lineNo: number;
  matched: boolean;
  deposit: string;
  withdrawal: string;
  reference: string | null;
  matches: { id: string; amount: string }[];
}
interface Detail {
  id: string;
  status: string;
  lines: Line[];
  summary: Record<string, string | number>;
  outstandingDeposits: { id: string; amount: string }[];
  outstandingPayments: { id: string; amount: string }[];
}

async function register(prefix: string) {
  const body = h.ok(
    await h.api().post('/api/v1/auth/register').send({
      tenantName: `Bank Rec ${prefix} ${RUN}`,
      ownerName: 'Owner',
      email: `bank-rec-${prefix}-${RUN}@test.dev`,
      password: PASS,
    }),
    201,
    `register ${prefix}`,
  );
  return body.accessToken as string;
}

const post = async (path: string, body: object, what: string, status = 201) =>
  h.ok(await h.api().post(`/api/v1/${path}`).set(h.auth(token)).send(body), status, what);

async function receipt(date: string, amount: string, referenceNo?: string) {
  return h.ok(
    await h.act(token, 'receipts', {
      receiptDate: date,
      partyType: 'CUSTOMER',
      partyId: customerId,
      cashAccountId: accounts['1102'],
      amount,
      ...(referenceNo ? { referenceNo } : {}),
    }),
    201,
    `receipt ${date}`,
  );
}

async function payment(date: string, amount: string, referenceNo?: string) {
  return h.ok(
    await h.act(token, 'payments', {
      paymentDate: date,
      expenseAccountId: accounts['5204'],
      cashAccountId: accounts['1102'],
      amount,
      ...(referenceNo ? { referenceNo } : {}),
    }),
    201,
    `payment ${date}`,
  );
}

async function postJournal(date: string, lines: object[]) {
  const draft = h.ok(
    await h.api().post('/api/v1/journal-entries').set(h.auth(token)).send({ entryDate: date, lines }),
    201,
    `draft journal ${date}`,
  );
  return h.ok(await h.act(token, `journal-entries/${draft.id}/post`), 201, `post journal ${date}`);
}

const detail = async (id: string) => h.ok(await h.get(token, `bank-statements/${id}`), 200, 'statement') as Detail;
const addLine = (id: string, body: object) => post(`bank-statements/${id}/lines`, body, 'add line') as Promise<Detail>;

async function expectBalanced() {
  const tb = await h.get(token, 'reports/trial-balance?from=2030-01-01&to=2031-12-31');
  expect(tb.status).toBe(200);
  expect(tb.body.balanced).toBe(true);
}

async function sheet(rows: (string | number | Date)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Statement');
  ws.addRow(['التاريخ', 'البيان', 'المرجع', 'إيداع', 'سحب']);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

beforeAll(async () => {
  boot = await bootApi(3851);
  h = kit(boot.base, `br-${RUN}`);
  token = await register('a');
  tokenB = await register('b');
  for (const code of ['2030', '2031']) {
    h.ok(
      await h.api()
        .post('/api/v1/fiscal-years')
        .set(h.auth(token))
        .send({ code, startDate: `${code}-01-01`, endDate: `${code}-12-31` }),
      201,
      `year ${code}`,
    );
  }
  const chart = h.ok(await h.get(token, 'accounts'), 200, 'accounts') as { id: string; code: string }[];
  for (const account of chart) accounts[account.code] = account.id;
  const bank = (await post('bank-accounts', { bankName: 'Arab Bank', accountId: accounts['1102'] }, 'bank account')) as {
    id: string;
  };
  bankAccountId = String(bank.id);
  const customer = (await post('parties', { code: `C${RUN}`, nameAr: 'عميل البنك', partyType: 'CUSTOMER' }, 'customer')) as {
    id: string;
  };
  customerId = String(customer.id);

  // A branch-restricted member needs a second branch to be restricted at all.
  const tenantName = `Bank Rec a ${RUN}`;
  const [tenant] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [tenantName])) as { id: bigint }[];
  const [plan] = (await boot.db.query('SELECT id FROM plans WHERE max_branches >= 2 ORDER BY max_branches LIMIT 1')) as {
    id: bigint;
  }[];
  await boot.db.query('UPDATE tenants SET plan_id = ? WHERE id = ?', [plan!.id, tenant!.id]);
  const branches = h.ok(await h.get(token, 'branches'), 200, 'branches') as { id: string }[];
  await post('branches', { code: `B${RUN}`, nameAr: 'فرع ثان', nameEn: 'Second branch' }, 'branch');
  restricted = (
    await addMember(boot.base, token, {
      email: `bank-rec-accountant-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      branchIds: [branches[0]!.id],
      defaultBranchId: branches[0]!.id,
    })
  ).token;
}, 90_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('R1 — first statement', () => {
  it('reconciles January with one outstanding cheque', async () => {
    await receipt('2030-12-20', '1000.000');
    await receipt('2031-01-05', '500.000', 'DEP-1');
    await payment('2031-01-10', '200.000', 'CHQ-1');
    await payment('2031-01-28', '300.000', 'CHQ-2');
    await payment('2031-01-31', '5.000');

    const created = (await post(
      'bank-statements',
      { bankAccountId, startDate: '2031-01-01', endDate: '2031-01-31', openingBalance: '1000.000', closingBalance: '1295.000' },
      'create January',
    )) as Detail;
    january = created.id;
    expect(created.status).toBe('DRAFT');

    await addLine(january, { lineDate: '2031-01-05', reference: 'DEP-1', deposit: '500.000' });
    await addLine(january, { lineDate: '2031-01-12', reference: 'CHQ-1', withdrawal: '200.000' });
    const filled = await addLine(january, { lineDate: '2031-01-31', description: 'Bank charges', withdrawal: '5.000' });
    expect(filled.lines).toHaveLength(3);

    // The 2030 receipt is before the first statement: it is in the opening balance, not a candidate.
    const candidates = h.ok(await h.get(token, `bank-statements/${january}/candidates`), 200, 'candidates') as {
      amount: string;
    }[];
    expect(candidates.map((c) => c.amount).sort()).toEqual(['-200.000', '-300.000', '-5.000', '500.000']);

    // R3: a line with both amounts, a mismatched match, and an unmatched reconcile are refused.
    expect(
      h.err(await h.api().post(`/api/v1/bank-statements/${january}/lines`).set(h.auth(token)).send({
        lineDate: '2031-01-15',
        deposit: '1.000',
        withdrawal: '1.000',
      })),
    ).toEqual([400, 'VALIDATION']);
    const depositLine = filled.lines[0]!;
    const minus200 = (candidates as { id: string; amount: string }[]).find((c) => c.amount === '-200.000')!;
    expect(
      h.err(await h.api().post(`/api/v1/bank-statements/${january}/matches`).set(h.auth(token)).send({
        statementLineId: depositLine.id,
        journalLineIds: [minus200.id],
      })),
    ).toEqual([409, 'BANK_MATCH_AMOUNT_MISMATCH']);
    expect(h.err(await h.act(token, `bank-statements/${january}/reconcile`))).toEqual([409, 'BANK_STATEMENT_UNMATCHED']);

    const auto = h.ok(await h.act(token, `bank-statements/${january}/auto-match`), 201, 'auto-match') as {
      matched: number;
      statement: Detail;
    };
    expect(auto.matched).toBe(3);
    expect(auto.statement.summary).toMatchObject({
      bookBalance: '995.000',
      outstandingDeposits: '0.000',
      outstandingPayments: '300.000',
      adjustedBookBalance: '1295.000',
      computedClosingBalance: '1295.000',
      difference: '0.000',
      unmatchedLines: 0,
    });
    expect(auto.statement.outstandingPayments.map((p) => p.amount)).toEqual(['-300.000']);

    const reconciled = h.ok(await h.act(token, `bank-statements/${january}/reconcile`), 201, 'reconcile') as Detail;
    expect(reconciled.status).toBe('RECONCILED');
    expect(reconciled.summary.adjustedBookBalance).toBe('1295.000');

    expect(
      h.err(await h.api().post(`/api/v1/bank-statements/${january}/lines`).set(h.auth(token)).send({
        lineDate: '2031-01-20',
        deposit: '1.000',
      })),
    ).toEqual([409, 'BANK_STATEMENT_NOT_DRAFT']);
    await expectBalanced();
  });

  it('exports the reconciliation report', async () => {
    const xlsx = await h.get(token, `bank-statements/${january}/report?format=xlsx&lang=en`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const pdf = await h.get(token, `bank-statements/${january}/report?format=pdf&lang=ar`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('pdf');
  });
});

describe('R2 — second statement', () => {
  it('carries the opening balance and leaves a deposit in transit', async () => {
    await receipt('2031-02-27', '400.000');
    await postJournal('2031-02-15', [
      { accountId: accounts['1102'], debit: '12.500' },
      { accountId: accounts['4201'], credit: '12.500' },
    ]);
    const header = { bankAccountId, startDate: '2031-02-01', endDate: '2031-02-28', closingBalance: '1007.500' };
    expect(
      h.err(await h.api().post('/api/v1/bank-statements').set(h.auth(token)).send({ ...header, openingBalance: '1000.000' })),
    ).toEqual([409, 'BANK_STATEMENT_OPENING_MISMATCH']);
    expect(
      h.err(
        await h.api()
          .post('/api/v1/bank-statements')
          .set(h.auth(token))
          .send({ ...header, startDate: '2031-01-31', openingBalance: '1295.000' }),
      ),
    ).toEqual([409, 'BANK_STATEMENT_OVERLAP']);
    february = ((await post('bank-statements', { ...header, openingBalance: '1295.000' }, 'create February')) as Detail).id;
    expect(
      h.err(await h.api().post('/api/v1/bank-statements').set(h.auth(token)).send({
        ...header,
        startDate: '2031-03-01',
        endDate: '2031-03-31',
        openingBalance: '1007.500',
      })),
    ).toEqual([409, 'BANK_STATEMENT_DRAFT_EXISTS']);

    const withCheque = await addLine(february, { lineDate: '2031-02-03', reference: 'CHQ-2', withdrawal: '300.000' });
    await addLine(february, { lineDate: '2031-02-15', description: 'Interest', deposit: '12.500' });

    // R3: a ledger line matched in January cannot be matched again.
    const jan = await detail(january);
    const matchedInJanuary = jan.lines[0]!.matches[0]!.id;
    expect(
      h.err(await h.api().post(`/api/v1/bank-statements/${february}/matches`).set(h.auth(token)).send({
        statementLineId: withCheque.lines[0]!.id,
        journalLineIds: [matchedInJanuary],
      })),
    ).toEqual([409, 'BANK_LINE_ALREADY_MATCHED']);

    // CHQ-2 is 6 days from its book date: it matches on the reference.
    const auto = h.ok(await h.act(token, `bank-statements/${february}/auto-match`), 201, 'auto-match') as {
      matched: number;
      statement: Detail;
    };
    expect(auto.matched).toBe(2);
    expect(auto.statement.summary).toMatchObject({
      bookBalance: '1407.500',
      outstandingDeposits: '400.000',
      outstandingPayments: '0.000',
      adjustedBookBalance: '1007.500',
      difference: '0.000',
    });

    // R3: a wrong closing balance is refused, then corrected.
    h.ok(
      await h.api()
        .put(`/api/v1/bank-statements/${february}`)
        .set(h.auth(token))
        .send({ startDate: '2031-02-01', endDate: '2031-02-28', openingBalance: '1295.000', closingBalance: '1012.500' }),
      200,
      'wrong closing',
    );
    const unbalanced = await h.act(token, `bank-statements/${february}/reconcile`);
    expect(h.err(unbalanced)).toEqual([409, 'BANK_RECONCILIATION_UNBALANCED']);
    expect(unbalanced.body.error.details).toMatchObject({ kind: 'STATEMENT', difference: '5.000' });
    h.ok(
      await h.api()
        .put(`/api/v1/bank-statements/${february}`)
        .set(h.auth(token))
        .send({ startDate: '2031-02-01', endDate: '2031-02-28', openingBalance: '1295.000', closingBalance: '1007.500' }),
      200,
      'closing corrected',
    );
    expect((h.ok(await h.act(token, `bank-statements/${february}/reconcile`), 201, 'reconcile') as Detail).status).toBe(
      'RECONCILED',
    );
    await expectBalanced();
    // January, reconciled, still lists the cheque February cleared.
    const januaryAfter = await detail(january);
    expect(januaryAfter.outstandingPayments.map((p) => p.amount)).toEqual(['-300.000']);
    expect(januaryAfter.summary.outstandingPayments).toBe('300.000');
  });
});

describe('R3 — reopen', () => {
  it('reopens only the latest statement', async () => {
    expect(h.err(await h.act(token, `bank-statements/${january}/reopen`))).toEqual([409, 'BANK_STATEMENT_NOT_LATEST']);
    const reopened = h.ok(await h.act(token, `bank-statements/${february}/reopen`), 201, 'reopen') as Detail;
    expect(reopened.status).toBe('DRAFT');
    const line = reopened.lines[0]!;
    const unmatched = h.ok(
      await h.api().delete(`/api/v1/bank-statements/${february}/matches/${line.id}`).set(h.auth(token)),
      200,
      'unmatch',
    ) as Detail;
    expect(unmatched.summary.unmatchedLines).toBe(1);
    expect((h.ok(await h.act(token, `bank-statements/${february}/auto-match`), 201, 'rematch') as { matched: number }).matched).toBe(1);
    expect((h.ok(await h.act(token, `bank-statements/${february}/reconcile`), 201, 'reconcile again') as Detail).status).toBe(
      'RECONCILED',
    );
  });
});

describe('concurrency', () => {
  it('reconciles a statement once under two concurrent requests', async () => {
    const march = ((await post(
      'bank-statements',
      { bankAccountId, startDate: '2031-03-01', endDate: '2031-03-31', openingBalance: '1007.500', closingBalance: '1007.500' },
      'create March',
    )) as Detail).id;
    const results = await Promise.all([
      h.act(token, `bank-statements/${march}/reconcile`),
      h.act(token, `bank-statements/${march}/reconcile`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('BANK_STATEMENT_NOT_DRAFT');
  });

  it('matches a ledger line once under two concurrent requests, after an xlsx import', async () => {
    const april = ((await post(
      'bank-statements',
      { bankAccountId, startDate: '2031-04-01', endDate: '2031-04-30', openingBalance: '1007.500', closingBalance: '1807.500' },
      'create April',
    )) as Detail).id;

    const impossible = await h.api()
      .post(`/api/v1/bank-statements/${april}/import`)
      .set(h.auth(token))
      .attach('file', await sheet([['31/04/2031', 'Deposit', '', '400', '']]), 'statement.xlsx');
    expect(h.err(impossible)).toEqual([400, 'VALIDATION']);

    const bad = await h.api()
      .post(`/api/v1/bank-statements/${april}/import`)
      .set(h.auth(token))
      .attach('file', await sheet([['2031-04-02', 'Deposit', '', '400', ''], ['not a date', 'x', '', '1', '']]), 'statement.xlsx');
    expect(h.err(bad)).toEqual([400, 'VALIDATION']);
    expect((await detail(april)).lines).toHaveLength(0);

    const imported = h.ok(
      await h.api()
        .post(`/api/v1/bank-statements/${april}/import`)
        .set(h.auth(token))
        .attach(
          'file',
          await sheet([[new Date('2031-04-02T00:00:00Z'), 'Deposit', 'A', 400, ''], ['03/04/2031', 'Deposit', 'B', '400.000', '']]),
          'statement.xlsx',
        ),
      201,
      'import',
    ) as Detail;
    expect(imported.lines.map((l) => [l.lineNo, l.deposit, l.withdrawal])).toEqual([
      [1, '400.000', '0.000'],
      [2, '400.000', '0.000'],
    ]);
    const open = imported.outstandingDeposits.find((d) => d.amount === '400.000')!;
    const results = await Promise.all(
      imported.lines.map((line) =>
        h.api()
          .post(`/api/v1/bank-statements/${april}/matches`)
          .set(h.auth(token))
          .send({ statementLineId: line.id, journalLineIds: [open.id] }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('BANK_LINE_ALREADY_MATCHED');
    const [count] = (await boot.db.query(
      'SELECT COUNT(*) AS n FROM bank_statement_matches WHERE statement_id = ?',
      [april],
    )) as { n: bigint }[];
    expect(String(count!.n)).toBe('1');
  });
});

describe('access', () => {
  it('keeps tenant B out of tenant A statements', async () => {
    const asB = (path: string) => h.api().get(`/api/v1/${path}`).set(h.auth(tokenB));
    expect(h.err(await asB(`bank-statements/${january}`))).toEqual([404, 'NOT_FOUND']);
    expect(h.err(await asB(`bank-statements/${january}/candidates`))).toEqual([404, 'NOT_FOUND']);
    expect(h.err(await asB(`bank-statements/${january}/report`))).toEqual([404, 'NOT_FOUND']);
    expect((await asB('bank-statements')).body).toEqual([]);
    expect(
      h.err(await h.api().post('/api/v1/bank-statements').set(h.auth(tokenB)).send({
        bankAccountId,
        startDate: '2032-01-01',
        endDate: '2032-01-31',
        openingBalance: '0',
        closingBalance: '0',
      })),
    ).toEqual([404, 'NOT_FOUND']);
    for (const path of ['reconcile', 'reopen', 'auto-match']) {
      expect(h.err(await h.api().post(`/api/v1/bank-statements/${february}/${path}`).set(h.auth(tokenB)).set(h.idem()))).toEqual([
        404,
        'NOT_FOUND',
      ]);
    }
    expect(h.err(await h.api().delete(`/api/v1/bank-statements/${february}`).set(h.auth(tokenB)))).toEqual([404, 'NOT_FOUND']);
  });

  it('refuses a branch-restricted member', async () => {
    expect(h.err(await h.get(restricted, 'bank-statements'))).toEqual([403, 'BRANCH_NOT_ALLOWED']);
  });

  it('requires an Idempotency-Key to reconcile', async () => {
    const res = await h.api().post(`/api/v1/bank-statements/${february}/reconcile`).set(h.auth(token));
    expect(res.status).toBe(400);
  });
});

describe('opening balance', () => {
  it('keeps the opening entry out of the first statement (tenant B)', async () => {
    h.ok(
      await h.api()
        .post('/api/v1/fiscal-years')
        .set(h.auth(tokenB))
        .send({ code: '2031', startDate: '2031-01-01', endDate: '2031-12-31' }),
      201,
      'B year',
    );
    const chartB = h.ok(await h.get(tokenB, 'accounts'), 200, 'B accounts') as { id: string; code: string }[];
    const bankLedger = chartB.find((a) => a.code === '1102')!.id;
    h.ok(
      await h.api()
        .post('/api/v1/journal-entries/opening')
        .set(h.auth(tokenB))
        .set(h.idem())
        .send({ entryDate: '2031-01-01', lines: [{ accountId: bankLedger, debit: '250.000' }] }),
      201,
      'B opening entry',
    );
    const bank = h.ok(
      await h.api().post('/api/v1/bank-accounts').set(h.auth(tokenB)).send({ bankName: 'Housing Bank', accountId: bankLedger }),
      201,
      'B bank account',
    ) as { id: string };
    const statement = h.ok(
      await h.api().post('/api/v1/bank-statements').set(h.auth(tokenB)).send({
        bankAccountId: String(bank.id),
        startDate: '2031-01-01',
        endDate: '2031-01-31',
        openingBalance: '250.000',
        closingBalance: '250.000',
      }),
      201,
      'B statement',
    ) as Detail;
    expect(statement.outstandingDeposits).toEqual([]);
    expect(statement.summary).toMatchObject({ bookBalance: '250.000', adjustedBookBalance: '250.000', difference: '0.000' });
    const done = h.ok(
      await h.api().post(`/api/v1/bank-statements/${statement.id}/reconcile`).set(h.auth(tokenB)).set(h.idem()),
      201,
      'B reconcile',
    ) as Detail;
    expect(done.status).toBe('RECONCILED');
  });
});
