/**
 * Phase 24 (ADR-039): direct edit of posted journal entries and vouchers.
 * Golden results E1–E3 in BUILD_PLAN §18. Real MariaDB + built API. Run `pnpm --filter api build` first.
 */
import 'dotenv/config';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';
import { addMember } from './support/members.js';

const RUN = Date.now().toString(36);

let boot: Booted;
let h: ReturnType<typeof kit>;
let token = '';
let tokenB = '';
let accountantToken = '';
let accountantMembershipId = '';
let tenantId: bigint;
let yearId = '';
const accounts: Record<string, string> = {};
let customerId = '';
let supplierId = '';

async function register(prefix: string) {
  const body = h.ok(
    await h.api().post('/api/v1/auth/register').send({
      tenantName: `Edit ${prefix} ${RUN}`,
      ownerName: 'Owner',
      email: `edit-${prefix}-${RUN}@test.dev`,
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
  return h.ok(await h.act(token, `journal-entries/${draft.id}/post`), 201, `post journal ${date}`) as {
    id: string;
    entryNo: string;
  };
}

/** Debit minus credit on one account (optionally one party), straight from the ledger. */
async function balance(code: string, partyId?: string) {
  const [row] = (await boot.db.query(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b FROM journal_lines l
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

const sale = (amount: string) => [
  { accountId: accounts['1103'], debit: amount, partyType: 'CUSTOMER', partyId: customerId },
  { accountId: accounts['4101'], credit: amount },
];

beforeAll(async () => {
  boot = await bootApi(3871);
  h = kit(boot.base, `edit-${RUN}`);
  token = await register('a');
  tokenB = await register('b');
  const accountant = await addMember(boot.base, token, {
    email: `edit-accountant-${RUN}@test.dev`,
    roleCode: 'ACCOUNTANT',
    password: PASS,
  });
  accountantToken = accountant.token;
  accountantMembershipId = accountant.membershipId;
  const [tenant] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [`Edit a ${RUN}`])) as { id: bigint }[];
  tenantId = tenant!.id;
  const year = h.ok(
    await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: '2031', startDate: '2031-01-01', endDate: '2031-12-31' }),
    201,
    'year 2031',
  ) as { id: string };
  yearId = year.id;
  const chart = h.ok(await h.get(token, 'accounts'), 200, 'accounts') as { id: string; code: string }[];
  for (const account of chart) accounts[account.code] = account.id;
  await post('bank-accounts', { bankName: 'Arab Bank', accountId: accounts['1102'] }, 'bank account');
  customerId = String(((await post('parties', { code: `C${RUN}`, nameAr: 'عميل التعديل', partyType: 'CUSTOMER' }, 'customer')) as { id: string }).id);
  supplierId = String(((await post('parties', { code: `S${RUN}`, nameAr: 'مورد التعديل', partyType: 'SUPPLIER' }, 'supplier')) as { id: string }).id);
}, 90_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('E1 — a posted journal entry is edited in place', () => {
  it('keeps the entry number and replaces date, lines and totals', async () => {
    const entry = await postJournal('2031-02-05', sale('1000.000'));
    const edited = h.ok(
      await h.actLocked(token, 'JOURNAL_ENTRY', entry.id, `journal-entries/${entry.id}/amend`, {
        entryDate: '2031-02-20',
        description: 'corrected sale',
        lines: sale('1250.000'),
      }),
      201,
      'amend journal',
    ) as { id: string; entryNo: string; entryDate: string; totalDebit: string; status: string; description: string };
    expect(edited.id).toBe(entry.id);
    expect(edited.entryNo).toBe(entry.entryNo);
    expect(edited.status).toBe('POSTED');
    expect(edited.entryDate.slice(0, 10)).toBe('2031-02-20');
    expect(m3(edited.totalDebit)).toBe('1250.000');
    expect(edited.description).toBe('corrected sale');
    expect(await balance('4101')).toBe('-1250.000');
    expect(await balance('1103', customerId)).toBe('1250.000');
    const [remainingLock] = (await boot.db.query(
      'SELECT COUNT(*) AS n FROM document_edit_locks WHERE tenant_id = ? AND doc_type = ? AND doc_id = ?',
      [tenantId, 'JOURNAL_ENTRY', entry.id],
    )) as { n: bigint }[];
    expect(Number(remainingLock!.n)).toBe(0);

    const [audit] = (await boot.db.query(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id = ? AND action = 'journal.amend' AND entity_id = ?",
      [tenantId, entry.id],
    )) as { n: bigint }[];
    expect(Number(audit!.n)).toBe(1);
    await expectBalanced();
  });

  it('refuses an unbalanced edit and leaves the entry as it was', async () => {
    const entry = await postJournal('2031-02-06', sale('300.000'));
    expect(
      h.err(
        await h.actLocked(token, 'JOURNAL_ENTRY', entry.id, `journal-entries/${entry.id}/amend`, {
          entryDate: '2031-02-06',
          lines: [
            { accountId: accounts['1103'], debit: '300.000', partyType: 'CUSTOMER', partyId: customerId },
            { accountId: accounts['4101'], credit: '200.000' },
          ],
        }),
      ),
    ).toEqual([400, 'UNBALANCED_ENTRY']);
    expect(await balance('4101')).toBe('-1550.000');
  });
});

describe('E2 — a posted cheque receipt is edited with its cheque', () => {
  it('moves the new amount and date onto the voucher, entry and cheque', async () => {
    const receipt = h.ok(
      await h.act(token, 'receipts', {
        receiptDate: '2031-03-01',
        partyType: 'CUSTOMER',
        partyId: customerId,
        amount: '600.000',
        cheque: { chequeNo: `E-100-${RUN}`, bankName: 'بنك الإسكان', dueDate: '2031-04-15' },
      }),
      201,
      'receipt',
    ) as { id: string; receiptNo: string };
    expect(
      h.err(await h.act(token, `receipts/${receipt.id}/amend`, { voucherDate: '2031-03-03', amount: '650.000' })),
    ).toEqual([409, 'DOCUMENT_LOCK_REQUIRED']);
    const edited = h.ok(
      await h.actLocked(token, 'RECEIPT', receipt.id, `receipts/${receipt.id}/amend`, { voucherDate: '2031-03-03', amount: '650.000' }),
      201,
      'amend receipt',
    ) as { receiptNo: string; amount: string; receiptDate: string };
    expect(edited.receiptNo).toBe(receipt.receiptNo);
    expect(m3(edited.amount)).toBe('650.000');
    expect(edited.receiptDate.slice(0, 10)).toBe('2031-03-03');
    expect(await balance('1106')).toBe('650.000');
    expect(await balance('1103', customerId)).toBe('900.000');
    const [receiptLock] = (await boot.db.query(
      'SELECT COUNT(*) AS n FROM document_edit_locks WHERE tenant_id = ? AND doc_type = ? AND doc_id = ?',
      [tenantId, 'RECEIPT', receipt.id],
    )) as { n: bigint }[];
    expect(Number(receiptLock!.n)).toBe(0);

    const page = h.ok(await h.get(token, `cheques?q=E-100-${RUN}`), 200, 'cheques') as { items: { id: string; amount: string }[] };
    expect(m3(page.items[0]!.amount)).toBe('650.000');
    await expectBalanced();
  });

  it('edits a cash payment without a party onto another expense account', async () => {
    const payment = h.ok(
      await h.act(token, 'payments', {
        paymentDate: '2031-03-05',
        cashAccountId: accounts['1102'],
        expenseAccountId: accounts['5201'],
        amount: '80.000',
      }),
      201,
      'payment',
    ) as { id: string };
    const before = await balance('1102');
    expect(
      h.err(await h.act(token, `payments/${payment.id}/amend`, { voucherDate: '2031-03-05', amount: '95.500' })),
    ).toEqual([409, 'DOCUMENT_LOCK_REQUIRED']);
    h.ok(await h.actLocked(token, 'PAYMENT', payment.id, `payments/${payment.id}/amend`, { voucherDate: '2031-03-05', amount: '95.500' }), 201, 'amend payment');
    expect(before).toBe('-80.000');
    expect(await balance('1102')).toBe('-95.500');
    const [paymentLock] = (await boot.db.query(
      'SELECT COUNT(*) AS n FROM document_edit_locks WHERE tenant_id = ? AND doc_type = ? AND doc_id = ?',
      [tenantId, 'PAYMENT', payment.id],
    )) as { n: bigint }[];
    expect(Number(paymentLock!.n)).toBe(0);
    await expectBalanced();
  });
});

describe('E3 — what cannot be edited', () => {
  it('refuses a document-generated entry through the journal', async () => {
    const [row] = (await boot.db.query(
      "SELECT id FROM journal_entries WHERE tenant_id = ? AND source_type = 'RECEIPT' LIMIT 1",
      [tenantId],
    )) as { id: bigint }[];
    const id = String(row!.id);
    expect(
      h.err(await h.actLocked(token, 'JOURNAL_ENTRY', id, `journal-entries/${id}/amend`, { entryDate: '2031-03-03', lines: sale('1.000') })),
    ).toEqual([409, 'REVERSE_VIA_DOCUMENT']);
  });

  it('refuses a reversed entry', async () => {
    const entry = await postJournal('2031-04-02', sale('50.000'));
    h.ok(await h.act(token, `journal-entries/${entry.id}/reverse`, { reversalDate: '2031-04-03' }), 201, 'reverse');
    expect(
      h.err(await h.actLocked(token, 'JOURNAL_ENTRY', entry.id, `journal-entries/${entry.id}/amend`, { entryDate: '2031-04-02', lines: sale('60.000') })),
    ).toEqual([409, 'ENTRY_ALREADY_REVERSED']);
  });

  it('refuses a receipt whose cheque was deposited', async () => {
    const receipt = h.ok(
      await h.act(token, 'receipts', {
        receiptDate: '2031-04-05',
        partyType: 'CUSTOMER',
        partyId: customerId,
        amount: '200.000',
        cheque: { chequeNo: `E-101-${RUN}`, bankName: 'بنك الإسكان', dueDate: '2031-05-01' },
      }),
      201,
      'receipt',
    ) as { id: string };
    const page = h.ok(await h.get(token, `cheques?q=E-101-${RUN}`), 200, 'cheques') as { items: { id: string }[] };
    h.ok(await h.act(token, `cheques/${page.items[0]!.id}/deposit`, { date: '2031-04-10', bankAccountId: accounts['1102'] }), 201, 'deposit');
    expect(
      h.err(await h.actLocked(token, 'RECEIPT', receipt.id, `receipts/${receipt.id}/amend`, { voucherDate: '2031-04-05', amount: '250.000' })),
    ).toEqual([409, 'CHEQUE_INVALID_STATUS']);
    expect(await balance('1103', customerId)).toBe('700.000');
  });

  it('refuses an edit into or out of a closed period', async () => {
    const entry = await postJournal('2031-05-04', sale('10.000'));
    const year = h.ok(await h.get(token, `fiscal-years/${yearId}`), 200, 'year') as { periods: { id: string; periodNo: number }[] };
    const june = year.periods.find((p) => p.periodNo === 6)!;
    h.ok(await h.act(token, `fiscal-periods/${june.id}/close`), 201, 'close June');
    expect(
      h.err(await h.actLocked(token, 'JOURNAL_ENTRY', entry.id, `journal-entries/${entry.id}/amend`, { entryDate: '2031-06-10', lines: sale('10.000') })),
    ).toEqual([409, 'PERIOD_CLOSED']);
    const may = year.periods.find((p) => p.periodNo === 5)!;
    h.ok(await h.act(token, `fiscal-periods/${may.id}/close`), 201, 'close May');
    expect(
      h.err(await h.actLocked(token, 'JOURNAL_ENTRY', entry.id, `journal-entries/${entry.id}/amend`, { entryDate: '2031-07-01', lines: sale('10.000') })),
    ).toEqual([409, 'PERIOD_CLOSED']);
  });

  it('needs an Idempotency-Key', async () => {
    const entry = await postJournal('2031-07-02', sale('5.000'));
    const res = await h
      .api()
      .post(`/api/v1/journal-entries/${entry.id}/amend`)
      .set(h.auth(token))
      .send({ entryDate: '2031-07-02', lines: sale('6.000') });
    expect(res.status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it("tenant B cannot edit tenant A's entry or voucher", async () => {
    const entry = await postJournal('2031-07-03', sale('7.000'));
    const [receipt] = (await boot.db.query('SELECT id FROM receipts WHERE tenant_id = ? LIMIT 1', [tenantId])) as { id: bigint }[];
    expect(h.err(await h.act(tokenB, `journal-entries/${entry.id}/amend`, { entryDate: '2031-07-03', lines: sale('8.000') }))[0]).toBe(404);
    expect(h.err(await h.act(tokenB, `receipts/${receipt!.id}/amend`, { voucherDate: '2031-07-03', amount: '1.000' }))[0]).toBe(404);
    expect((await h.get(tokenB, `document-locks/JOURNAL_ENTRY/${entry.id}`)).status).toBe(404);
    expect((await h.acquireLock(tokenB, 'JOURNAL_ENTRY', entry.id)).response.status).toBe(404);
    expect(
      (await h.api().post(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}/heartbeat`)
        .set(h.auth(tokenB))
        .set('X-Edit-Lock', 'ffffffff-ffff-4fff-8fff-ffffffffffff')).status,
    ).toBe(404);

    const company2 = h.ok(
      await h.api().post('/api/v1/companies').set(h.auth(token)).send({ legalNameAr: `Second ${RUN}` }),
      201,
      'create second company',
    ) as { id: string };
    expect(
      (await h.api().get(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
        .set(h.auth(token))
        .set('X-Company-Id', company2.id)).status,
    ).toBe(404);
    expect(
      (await h.api().post(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}/acquire`)
        .set(h.auth(token))
        .set('X-Company-Id', company2.id)
        .set('X-Edit-Lock', 'ffffffff-ffff-4fff-8fff-ffffffffffff')).status,
    ).toBe(404);
    expect(
      (await h.api().post(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}/heartbeat`)
        .set(h.auth(token))
        .set('X-Company-Id', company2.id)
        .set('X-Edit-Lock', 'ffffffff-ffff-4fff-8fff-ffffffffffff')).status,
    ).toBe(404);

    const lock = await h.acquireLock(token, 'JOURNAL_ENTRY', entry.id);
    expect(lock.response.status).toBe(201);
    expect(
      (await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
        .set(h.auth(tokenB))
        .set('X-Edit-Lock', lock.holderToken)).status,
    ).toBe(204);
    expect(
      (await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
        .set(h.auth(token))
        .set('X-Company-Id', company2.id)
        .set('X-Edit-Lock', lock.holderToken)).status,
    ).toBe(204);
    expect((await h.get(token, `document-locks/JOURNAL_ENTRY/${entry.id}`)).body.holder).not.toBeNull();
    expect(
      (await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
        .set(h.auth(token))
        .set('X-Edit-Lock', lock.holderToken)).status,
    ).toBe(204);
    expect(await balance('4101')).not.toBe('0.000');
  });
});

describe('document edit locks', () => {
  it('rejects IDs outside the signed BIGINT range', async () => {
    for (const id of ['9999999999999999999999999', '9223372036854775808']) {
      expect((await h.get(token, `document-locks/JOURNAL_ENTRY/${id}`)).status).toBe(400);
    }
  });

  it('acquires, reports, heartbeats, conflicts across tabs and users, and releases', async () => {
    const entry = await postJournal('2031-08-01', sale('10.000'));
    const first = await h.acquireLock(token, 'JOURNAL_ENTRY', entry.id);
    expect(first.response.status).toBe(201);
    expect(first.response.body.acquiredAt).toBeDefined();
    expect(first.response.body.expiresAt).toBeDefined();

    const sameUserOtherTab = await h.acquireLock(token, 'JOURNAL_ENTRY', entry.id);
    expect(h.err(sameUserOtherTab.response)).toEqual([409, 'DOCUMENT_LOCKED']);
    expect(sameUserOtherTab.response.body.error.details.userName).toBe('Owner');
    expect(sameUserOtherTab.response.body.error.details.acquiredAt).toBeDefined();

    const otherUser = await h.acquireLock(accountantToken, 'JOURNAL_ENTRY', entry.id);
    expect(h.err(otherUser.response)).toEqual([409, 'DOCUMENT_LOCKED']);
    expect(otherUser.response.body.error.details.userName).toBe('Owner');

    const status = await h.get(token, `document-locks/JOURNAL_ENTRY/${entry.id}`);
    expect(status.body.holder).toMatchObject({ userName: 'Owner', mine: false });
    const mine = await h.get(token, `document-locks/JOURNAL_ENTRY/${entry.id}`).set('X-Edit-Lock', first.holderToken);
    expect(mine.body.holder.mine).toBe(true);
    expect((await h.api().post(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}/heartbeat`)
      .set(h.auth(token))
      .set('X-Edit-Lock', first.holderToken)).status).toBe(200);

    expect(
      (await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
        .set(h.auth(token))
        .set('X-Edit-Lock', first.holderToken)).status,
    ).toBe(204);
    expect(
      (await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
        .set(h.auth(token))
        .set('X-Edit-Lock', first.holderToken)).status,
    ).toBe(204);
    expect((await h.get(token, `document-locks/JOURNAL_ENTRY/${entry.id}`)).body.holder).toBeNull();
  });

  it('takes over expired leases and rejects the stale holder heartbeat and save', async () => {
    const entry = await postJournal('2031-08-02', sale('11.000'));
    const stale = await h.acquireLock(token, 'JOURNAL_ENTRY', entry.id);
    expect(stale.response.status).toBe(201);
    await boot.db.query(
      `UPDATE document_edit_locks
          SET expires_at = NOW(3) - INTERVAL 1 SECOND
        WHERE tenant_id = ? AND doc_type = 'JOURNAL_ENTRY' AND doc_id = ?`,
      [tenantId, entry.id],
    );

    const takeover = await h.acquireLock(accountantToken, 'JOURNAL_ENTRY', entry.id);
    expect(takeover.response.status).toBe(201);
    expect(
      h.err(
        await h.api().post(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}/heartbeat`)
          .set(h.auth(token))
          .set('X-Edit-Lock', stale.holderToken),
      ),
    ).toEqual([409, 'DOCUMENT_LOCK_REQUIRED']);
    expect(
      h.err(
        await h.api().post(`/api/v1/journal-entries/${entry.id}/amend`)
          .set(h.auth(token))
          .set('X-Edit-Lock', stale.holderToken)
          .set(h.idem())
          .send({ entryDate: '2031-08-02', lines: sale('12.000') }),
      ),
    ).toEqual([409, 'DOCUMENT_LOCK_REQUIRED']);
    await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
      .set(h.auth(accountantToken))
      .set('X-Edit-Lock', takeover.holderToken);
  });

  it('requires the lock for amendment, deletes it in the edit transaction, and serializes concurrent acquires', async () => {
    const entry = await postJournal('2031-08-03', sale('12.000'));
    expect(
      h.err(await h.act(token, `journal-entries/${entry.id}/amend`, { entryDate: '2031-08-03', lines: sale('13.000') })),
    ).toEqual([409, 'DOCUMENT_LOCK_REQUIRED']);

    h.ok(
      await h.actLocked(token, 'JOURNAL_ENTRY', entry.id, `journal-entries/${entry.id}/amend`, {
        entryDate: '2031-08-03',
        lines: sale('13.000'),
      }),
      201,
      'amend with lock',
    );
    const [afterEdit] = (await boot.db.query(
      'SELECT COUNT(*) AS n FROM document_edit_locks WHERE tenant_id = ? AND doc_type = ? AND doc_id = ?',
      [tenantId, 'JOURNAL_ENTRY', entry.id],
    )) as { n: bigint }[];
    expect(Number(afterEdit!.n)).toBe(0);

    const contested = await postJournal('2031-08-04', sale('14.000'));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.acquireLock(token, 'JOURNAL_ENTRY', contested.id)),
    );
    expect(results.filter((result) => result.response.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.response.status === 409)).toHaveLength(4);
    const winner = results.find((result) => result.response.status === 201)!;
    await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${contested.id}`)
      .set(h.auth(token))
      .set('X-Edit-Lock', winner.holderToken);
  });

  it('blocks journal delete, post, and reverse while another holder has the lock', async () => {
    const draft = h.ok(
      await h.api().post('/api/v1/journal-entries').set(h.auth(token)).send({ entryDate: '2031-08-06', lines: sale('16.000') }),
      201,
      'draft journal',
    ) as { id: string };
    const draftLock = await h.acquireLock(accountantToken, 'JOURNAL_ENTRY', draft.id);
    expect(draftLock.response.status).toBe(201);
    expect(h.err(await h.act(token, `journal-entries/${draft.id}/post`))).toEqual([409, 'DOCUMENT_LOCKED']);
    expect(
      (await h.api().delete(`/api/v1/journal-entries/${draft.id}`).set(h.auth(token))).body.error.code,
    ).toBe('DOCUMENT_LOCKED');
    await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${draft.id}`)
      .set(h.auth(accountantToken))
      .set('X-Edit-Lock', draftLock.holderToken);

    const entry = await postJournal('2031-08-07', sale('17.000'));
    const postedLock = await h.acquireLock(accountantToken, 'JOURNAL_ENTRY', entry.id);
    expect(postedLock.response.status).toBe(201);
    expect(h.err(await h.act(token, `journal-entries/${entry.id}/reverse`, { reversalDate: '2031-08-08' })))
      .toEqual([409, 'DOCUMENT_LOCKED']);
    await h.api().delete(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}`)
      .set(h.auth(accountantToken))
      .set('X-Edit-Lock', postedLock.holderToken);
  });

  it('blocks voucher reverse and allocation while another holder has the lock', async () => {
    const receipt = h.ok(
      await h.act(token, 'receipts', {
        receiptDate: '2031-08-08',
        partyType: 'CUSTOMER',
        partyId: customerId,
        cashAccountId: accounts['1102'],
        amount: '18.000',
      }),
      201,
      'receipt',
    ) as { id: string };
    const receiptLock = await h.acquireLock(accountantToken, 'RECEIPT', receipt.id);
    expect(receiptLock.response.status).toBe(201);
    expect(h.err(await h.act(token, `receipts/${receipt.id}/reverse`, { reversalDate: '2031-08-09' })))
      .toEqual([409, 'DOCUMENT_LOCKED']);
    expect(h.err(await h.act(token, `receipts/${receipt.id}/allocations`, { auto: true })))
      .toEqual([409, 'DOCUMENT_LOCKED']);
    await h.api().delete(`/api/v1/document-locks/RECEIPT/${receipt.id}`)
      .set(h.auth(accountantToken))
      .set('X-Edit-Lock', receiptLock.holderToken);

    const payment = h.ok(
      await h.act(token, 'payments', {
        paymentDate: '2031-08-08',
        partyType: 'SUPPLIER',
        partyId: supplierId,
        cashAccountId: accounts['1102'],
        expenseAccountId: accounts['5201'],
        amount: '19.000',
      }),
      201,
      'payment',
    ) as { id: string };
    const paymentLock = await h.acquireLock(accountantToken, 'PAYMENT', payment.id);
    expect(paymentLock.response.status).toBe(201);
    expect(h.err(await h.act(token, `payments/${payment.id}/reverse`, { reversalDate: '2031-08-09' })))
      .toEqual([409, 'DOCUMENT_LOCKED']);
    expect(h.err(await h.act(token, `payments/${payment.id}/allocations`, { auto: true })))
      .toEqual([409, 'DOCUMENT_LOCKED']);
    await h.api().delete(`/api/v1/document-locks/PAYMENT/${payment.id}`)
      .set(h.auth(accountantToken))
      .set('X-Edit-Lock', paymentLock.holderToken);
  });

  it('restricts force release and audits the owner and previous holder', async () => {
    const entry = await postJournal('2031-08-05', sale('15.000'));
    const lock = await h.acquireLock(accountantToken, 'JOURNAL_ENTRY', entry.id);
    expect(lock.response.status).toBe(201);
    const previousHolder = h.ok(
      await h.get(token, `document-locks/JOURNAL_ENTRY/${entry.id}`),
      200,
      'lock status before force release',
    ) as { holder: { userName: string; acquiredAt: string } };
    expect(
      (await h.api().post(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}/force-release`)
        .set(h.auth(accountantToken))).status,
    ).toBe(403);
    expect(
      (await h.api().post(`/api/v1/document-locks/JOURNAL_ENTRY/${entry.id}/force-release`)
        .set(h.auth(token))).status,
    ).toBe(200);

    const [audit] = (await boot.db.query(
      `SELECT user_id, action, entity_type, entity_id, CAST(before_json AS CHAR) AS before_json
         FROM audit_logs
        WHERE tenant_id = ? AND action = 'document_lock.force_release' AND entity_id = ?
        ORDER BY id DESC LIMIT 1`,
      [tenantId, entry.id],
    )) as { user_id: bigint; action: string; entity_type: string; entity_id: string; before_json: string }[];
    const [owner] = (await boot.db.query(
      `SELECT tm.user_id FROM tenant_memberships tm
         JOIN roles r ON r.id = tm.role_id
        WHERE tm.tenant_id = ? AND r.code = 'OWNER' LIMIT 1`,
      [tenantId],
    )) as { user_id: bigint }[];
    expect(audit).toMatchObject({ user_id: owner!.user_id, action: 'document_lock.force_release', entity_type: 'journal_entry', entity_id: entry.id });
    expect(JSON.parse(audit!.before_json as string)).toMatchObject({
      userName: previousHolder.holder.userName,
      acquiredAt: previousHolder.holder.acquiredAt,
    });
    const [locks] = (await boot.db.query(
      'SELECT COUNT(*) AS n FROM document_edit_locks WHERE tenant_id = ? AND doc_type = ? AND doc_id = ?',
      [tenantId, 'JOURNAL_ENTRY', entry.id],
    )) as { n: bigint }[];
    expect(Number(locks!.n)).toBe(0);
  });

  it('allows a journal.post-only role to acquire a lock and amend an entry', async () => {
    const entry = await postJournal('2031-08-09', sale('20.000'));
    const role = h.ok(
      await h.api().post('/api/v1/roles/custom').set(h.auth(token)).send({
        code: `JPOST_${RUN.toUpperCase()}`,
        nameAr: 'مرحل القيود',
        permissions: ['journal.post'],
      }),
      201,
      'create journal poster role',
    ) as { id: string; permissions: string[] };
    expect(role.permissions).toContain('journal.post');
    expect(role.permissions).not.toContain('journal.manage');

    const assigned = await h.api().patch(`/api/v1/users/${accountantMembershipId}`)
      .set(h.auth(token))
      .send({ customRoleId: role.id });
    expect(assigned.status).toBe(200);
    try {
      h.ok(
        await h.actLocked(accountantToken, 'JOURNAL_ENTRY', entry.id, `journal-entries/${entry.id}/amend`, {
          entryDate: '2031-08-09',
          lines: sale('21.000'),
        }),
        201,
        'amend with journal.post only',
      );
    } finally {
      expect(
        (await h.api().patch(`/api/v1/users/${accountantMembershipId}`)
          .set(h.auth(token))
          .send({ customRoleId: null })).status,
      ).toBe(200);
    }
  });
});
