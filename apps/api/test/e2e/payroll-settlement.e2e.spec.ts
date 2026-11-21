import 'dotenv/config';
import { Decimal } from 'decimal.js';
import { bootApi, kit, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);
let boot: Booted;
let h: ReturnType<typeof kit>;
let token = '';
let tenantId = 0n;

const act = (path: string, body: object, companyId: string) => {
  const request = h.act(token, path, body);
  request.set('X-Company-Id', companyId);
  return request;
};

const get = (path: string, companyId: string) => h.get(token, path).set('X-Company-Id', companyId);

const post = async <T extends object>(path: string, body: object, companyId: string, label: string) =>
  h.ok(await act(path, body, companyId), 201, label) as T;

async function createCompany(label: string, addCompany = false) {
  let company: { id: string };
  if (addCompany) {
    company = h.ok(await h.api().post('/api/v1/companies').set(h.auth(token)).send({
      legalNameAr: `${label} ${RUN}`,
    }), 201, `${label} company`) as { id: string };
  } else {
    company = (h.ok(await h.get(token, 'companies'), 200, `${label} company`) as { id: string }[])[0]!;
  }
  const branch = (h.ok(await get('branches', company.id), 200, `${label} branch`) as { id: string }[])[0]!;
  const costCenter = await post<{ id: string }>('cost-centers', {
    code: `${label.slice(0, 4)}-${RUN}`, nameAr: label,
  }, company.id, `${label} cost center`);
  h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).set('X-Company-Id', company.id).send({
    code: '2026', startDate: '2026-01-01', endDate: '2026-12-31',
  }), 201, `${label} fiscal year`);
  const accounts = h.ok(await get('accounts', company.id), 200, `${label} accounts`) as Array<{ id: string; code: string }>;
  const elements = h.ok(await get('payroll/elements', company.id), 200, `${label} pay elements`) as Array<{
    id: string; code: string; isFixedAllowance: boolean; sscSubject: boolean;
  }>;
  return {
    id: company.id,
    branchId: branch.id,
    costCenterId: costCenter.id,
    accounts,
    elements,
  };
}

async function employee(
  company: Awaited<ReturnType<typeof createCompany>>,
  code: string,
  hireDate: string,
  leaveDate: string,
  salary: string,
  sscCovered: boolean,
  transport?: string,
) {
  const result = await post<{ id: string }>('payroll/employees', {
    code: `${code}-${RUN}`,
    nameAr: code,
    hireDate,
    leaveDate,
    payMethod: 'CASH',
    sscCovered,
    branchId: company.branchId,
    costCenterId: company.costCenterId,
  }, company.id, `${code} employee`);
  await post(`payroll/employees/${result.id}/salaries`, {
    effectiveFrom: hireDate,
    basicSalary: salary,
  }, company.id, `${code} salary`);
  if (transport) {
    const element = company.elements.find((item) => item.code === 'TRANSPORT' && item.isFixedAllowance)!;
    await post(`payroll/employees/${result.id}/recurring-elements`, {
      payElementId: element.id,
      amount: transport,
      validFrom: hireDate,
    }, company.id, `${code} transport`);
  }
  return result;
}

async function run(companyId: string, period: string, postRun = true) {
  const draft = await post<{ id: string }>('payroll/runs', { period }, companyId, `${period} payroll run`);
  if (postRun) h.ok(await act(`payroll/runs/${draft.id}/post`, {}, companyId), 201, `post ${period} payroll run`);
  return h.ok(await get(`payroll/runs/${draft.id}`, companyId), 200, `get ${period} payroll run`) as {
    id: string;
    leaveProvisionEntryId: string | null;
    lines: Array<{
      id: string; employeeId: string; basic: string; earnings: string; gross: string; sscBase: string;
      sscEmployee: string; sscEmployer: string; incomeTax: string; net: string;
      leaveProvision: string; eosProvision: string;
      items: Array<{ description: string; amount: string; kind: string }>;
    }>;
  };
}

function employeeLine(result: Awaited<ReturnType<typeof run>>, employeeId: string) {
  return result.lines.find((line) => line.employeeId === employeeId)!;
}

async function journalLines(entryId: string) {
  return await boot.db.query(
    `SELECT a.code, CAST(l.debit AS CHAR) AS debit, CAST(l.credit AS CHAR) AS credit
       FROM journal_entries e
       JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id
       JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE e.tenant_id = ? AND e.id = ?
      ORDER BY a.code`,
    [tenantId, BigInt(entryId)],
  ) as Array<{ code: string; debit: string; credit: string }>;
}

async function settlementAccountBalances(companyId: string) {
  return await boot.db.query(
    `SELECT a.code, CAST(COALESCE(SUM(l.debit - l.credit), 0) AS CHAR) AS balance
       FROM companies c
       JOIN accounts a ON a.tenant_id = c.tenant_id AND a.company_id = c.id AND a.code IN ('2106', '2108', '2110', '1102')
       LEFT JOIN journal_entries e ON e.tenant_id = c.tenant_id AND e.company_id = c.id
       LEFT JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id AND l.account_id = a.id
      WHERE c.tenant_id = ? AND c.id = ?
      GROUP BY a.code
      ORDER BY a.code`,
    [tenantId, BigInt(companyId)],
  ) as Array<{ code: string; balance: string }>;
}

beforeAll(async () => {
  boot = await bootApi(3863);
  h = kit(boot.base, `settlement-${RUN}`);
  token = h.ok(await h.api().post('/api/v1/auth/register').send({
    tenantName: `Settlement ${RUN}`,
    ownerName: 'Owner',
    email: `settlement-${RUN}@test.dev`,
    password: PASS,
  }), 201, 'register settlement tenant').accessToken as string;
  const [tenant] = await boot.db.query('SELECT id FROM tenants WHERE name = ?', [`Settlement ${RUN}`]) as Array<{ id: bigint }>;
  tenantId = tenant!.id;
}, 90_000);

afterAll(async () => stopApi(boot));

describe('Phase 28C payroll settlements', () => {
  it('computes and posts EOS1/EOS2, pays and reverses EOS2 in chronological order', async () => {
    const eos1Company = await createCompany('EOS1');
    const eos1Employee = await employee(eos1Company, 'EOS1', '2008-01-01', '2026-12-31', '1000.000', false, '100.000');
    const eos1DraftRun = await run(eos1Company.id, '2026-12', false);
    const earlySettlement = await act('payroll/settlements', { employeeId: eos1Employee.id }, eos1Company.id);
    expect(earlySettlement).toMatchObject({
      status: 409,
      body: { error: { code: 'PAYROLL_SETTLEMENT_RUN_REQUIRED' } },
    });
    const eos1Run = h.ok(await act(`payroll/runs/${eos1DraftRun.id}/post`, {}, eos1Company.id), 201, 'post EOS1 run');
    const eos1Line = employeeLine(eos1Run as Awaited<ReturnType<typeof run>>, eos1Employee.id);
    expect(eos1Line.eosProvision).toBe('20900');
    const eos1 = await post<{
      id: string; settlementNo: string | null; status: string; serviceYears: string; lastWage: string; eosAmount: string;
      serviceDaysBefore2010: number; serviceDays2010To2014: number; serviceDaysFrom2015: number;
      taxableAmount: string; eosTax: string; nationalContribution: string; provisionUsed: string; net: string;
    }>('payroll/settlements', { employeeId: eos1Employee.id }, eos1Company.id, 'create EOS1 settlement');
    expect(eos1).toEqual(expect.objectContaining({
      status: 'DRAFT', serviceYears: '19', lastWage: '1100', eosAmount: '20900',
      serviceDaysBefore2010: 731, serviceDays2010To2014: 1826, serviceDaysFrom2015: 4383,
      taxableAmount: '2749.524', eosTax: '247.457', nationalContribution: '0', provisionUsed: '20900',
      net: '20652.543',
    }));
    const eos1Duplicate = await act('payroll/settlements', { employeeId: eos1Employee.id }, eos1Company.id);
    expect(eos1Duplicate.status).toBe(409);
    expect(eos1Duplicate.body.error.code).toBe('PAYROLL_SETTLEMENT_EXISTS');
    const eos1Posted = h.ok(
      await act(`payroll/settlements/${eos1.id}/post`, {}, eos1Company.id),
      200,
      'post EOS1 settlement',
    ) as { journalEntryId: string };
    const eos1Lines = await journalLines(eos1Posted.journalEntryId);
    expect(eos1Lines.map((line) => [line.code, line.debit, line.credit])).toEqual([
      ['2106', '0.000', '20652.543'],
      ['2108', '0.000', '247.457'],
      ['2110', '20900.000', '0.000'],
    ]);

    const eos2Company = await createCompany('EOS2', true);
    const eos2Employee = await employee(eos2Company, 'EOS2', '2020-03-01', '2026-08-31', '3000.000', false);
    const unpaidType = (h.ok(await get('payroll/leave-types', eos2Company.id), 200, 'EOS2 leave types') as Array<{
      id: string; code: string;
    }>).find((type) => type.code === 'UNPAID')!;
    const unpaid = await post<{ id: string }>('payroll/leave-requests', {
      employeeId: eos2Employee.id,
      leaveTypeId: unpaidType.id,
      startDate: '2026-05-01',
      endDate: '2026-05-10',
    }, eos2Company.id, 'create EOS2 unpaid leave');
    h.ok(await act(`payroll/leave-requests/${unpaid.id}/approve`, {}, eos2Company.id), 200, 'approve EOS2 unpaid leave');
    await run(eos2Company.id, '2026-05');
    const july = await run(eos2Company.id, '2026-07');
    expect(employeeLine(july, eos2Employee.id).eosProvision).toBe('19175.343');
    const beforeAugust = await act('payroll/settlements', { employeeId: eos2Employee.id }, eos2Company.id);
    expect(beforeAugust.status).toBe(409);
    expect(beforeAugust.body.error.code).toBe('PAYROLL_SETTLEMENT_RUN_REQUIRED');
    const august = await run(eos2Company.id, '2026-08');
    expect(employeeLine(august, eos2Employee.id).eosProvision).toBe('19430.136');
    const augustProvisionLines = (await journalLines(august.leaveProvisionEntryId!))
      .filter((line) => line.code === '2110' || line.code === '5208');
    expect(augustProvisionLines.map((line) => [line.code, line.debit, line.credit])).toEqual([
      ['2110', '0.000', '254.793'],
      ['5208', '254.793', '0.000'],
    ]);
    const eos2 = await post<{
      id: string; serviceYears: string; eosAmount: string; taxableAmount: string; eosTax: string;
      provisionUsed: string; net: string;
    }>('payroll/settlements', { employeeId: eos2Employee.id }, eos2Company.id, 'create EOS2 settlement');
    expect(eos2).toEqual(expect.objectContaining({
      serviceYears: '6.476712', eosAmount: '19430.136', taxableAmount: '4430.136',
      eosTax: '398.712', provisionUsed: '19430.136', net: '19031.424',
    }));
    const bankGl = eos2Company.accounts.find((account) => account.code === '1102')!;
    const bank = h.ok(await h.api().post('/api/v1/bank-accounts').set(h.auth(token)).set('X-Company-Id', eos2Company.id).send({
      bankName: 'EOS2 Bank', accountId: bankGl.id,
    }), 201, 'create EOS2 bank') as { id: string };
    const balancesBeforeSettlement = await settlementAccountBalances(eos2Company.id);
    const posted = h.ok(await act(`payroll/settlements/${eos2.id}/post`, {}, eos2Company.id), 200, 'post EOS2 settlement') as {
      journalEntryId: string;
    };
    expect((await journalLines(posted.journalEntryId)).map((line) => [line.code, line.debit, line.credit])).toEqual([
      ['2106', '0.000', '19031.424'],
      ['2108', '0.000', '398.712'],
      ['2110', '19430.136', '0.000'],
    ]);
    const earlyPayment = await act(`payroll/settlements/${eos2.id}/pay`, {
      paymentDate: '2026-08-30', bankAccountId: bank.id,
    }, eos2Company.id);
    expect(earlyPayment.status).toBe(400);
    const paid = h.ok(await act(`payroll/settlements/${eos2.id}/pay`, {
      paymentDate: '2026-09-01', bankAccountId: bank.id,
    }, eos2Company.id), 200, 'pay EOS2 settlement') as { paymentEntryId: string };
    expect((await journalLines(paid.paymentEntryId)).map((line) => [line.code, line.debit, line.credit])).toEqual([
      ['1102', '0.000', '19031.424'],
      ['2106', '19031.424', '0.000'],
    ]);
    const reversed = h.ok(await act(`payroll/settlements/${eos2.id}/reverse`, {
      reversalDate: '2026-10-01',
    }, eos2Company.id), 200, 'reverse EOS2 settlement') as {
      status: string; reversalEntryId: string; paymentReversalEntryId: string;
    };
    expect(reversed.status).toBe('REVERSED');
    expect((await journalLines(reversed.reversalEntryId)).map((line) => [line.code, line.debit, line.credit])).toEqual([
      ['2106', '19031.424', '0.000'],
      ['2108', '398.712', '0.000'],
      ['2110', '0.000', '19430.136'],
    ]);
    expect((await journalLines(reversed.paymentReversalEntryId)).map((line) => [line.code, line.debit, line.credit])).toEqual([
      ['1102', '19031.424', '0.000'],
      ['2106', '0.000', '19031.424'],
    ]);
    expect(await settlementAccountBalances(eos2Company.id)).toEqual(balancesBeforeSettlement);
    expect((await get('reports/trial-balance?from=2026-01-01&to=2026-12-31', eos2Company.id)).body.balanced).toBe(true);
  });

  it('recomputes a stale settlement draft from current salary history when posting', async () => {
    const company = await createCompany('STALE', true);
    const leaver = await employee(company, 'STALE', '2020-03-01', '2026-08-31', '1000.000', false);
    await run(company.id, '2026-08');
    const draft = await post<{ id: string; eosAmount: string }>('payroll/settlements', {
      employeeId: leaver.id,
    }, company.id, 'create stale settlement draft');
    await post(`payroll/employees/${leaver.id}/salaries`, {
      effectiveFrom: '2026-01-01', basicSalary: '2000.000',
    }, company.id, 'add effective salary');
    const posted = h.ok(await act(`payroll/settlements/${draft.id}/post`, {}, company.id), 200, 'post recomputed settlement') as {
      lastWage: string; serviceYears: string; eosAmount: string;
    };
    expect(posted.lastWage).toBe('2000');
    expect(new Decimal(posted.eosAmount).eq(new Decimal(posted.serviceYears).mul('2000'))).toBe(true);
    expect(new Decimal(posted.eosAmount).gt(draft.eosAmount)).toBe(true);
  });

  it('prorates EN1, encashes annual leave, releases leave provision, and refuses settlement for SSC staff', async () => {
    const company = await createCompany('EN1', true);
    const leaver = await employee(company, 'EN1', '2026-07-01', '2026-09-20', '600.000', true, '40.000');
    const july = await run(company.id, '2026-07');
    expect(employeeLine(july, leaver.id).leaveProvision).toBe('25.387');
    const august = await run(company.id, '2026-08');
    expect(employeeLine(august, leaver.id).leaveProvision).toBe('50.773');
    const september = await run(company.id, '2026-09');
    const line = employeeLine(september, leaver.id);
    expect(line).toEqual(expect.objectContaining({
      basic: '400', gross: '493.867', sscBase: '400', sscEmployee: '30', sscEmployer: '57',
      incomeTax: '0', net: '463.867', leaveProvision: '0', eosProvision: '0',
    }));
    expect(line.items).toContainEqual(expect.objectContaining({ description: 'Unused leave encashment', amount: '67.2', kind: 'EARNING' }));
    expect(line.items).toContainEqual(expect.objectContaining({ description: 'Transport', amount: '26.667', kind: 'EARNING' }));
    expect(september.leaveProvisionEntryId).toBeTruthy();
    const provisionLines = await journalLines(september.leaveProvisionEntryId!);
    expect(provisionLines.map((row) => [row.code, row.debit, row.credit])).toEqual([
      ['2109', '50.773', '0.000'],
      ['5207', '0.000', '50.773'],
    ]);
    const denied = await act('payroll/settlements', { employeeId: leaver.id }, company.id);
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('PAYROLL_SETTLEMENT_NOT_ELIGIBLE');
  });

  it('protects employee settlement fields and blocks payroll reversal until settlement reversal', async () => {
    const company = await createCompany('GUARD', true);
    h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).set('X-Company-Id', company.id).send({
      code: '2027', startDate: '2027-01-01', endDate: '2027-12-31',
    }), 201, 'create settlement guard FY 2027');
    const leaver = await employee(company, 'GUARD', '2020-01-01', '2026-12-31', '1000.000', false);
    const payroll = await run(company.id, '2026-12');
    const annual = (h.ok(await get('payroll/leave-types', company.id), 200, 'departure leave types') as Array<{
      id: string; code: string;
    }>).find((type) => type.code === 'ANNUAL')!;
    const leave = await post<{ id: string }>('payroll/leave-requests', {
      employeeId: leaver.id, leaveTypeId: annual.id, startDate: '2026-12-01', endDate: '2026-12-02',
    }, company.id, 'create post-departure-run annual leave');
    const deniedApproval = await act(`payroll/leave-requests/${leave.id}/approve`, {}, company.id);
    expect(deniedApproval.status).toBe(409);
    expect(deniedApproval.body.error.code).toBe('LEAVE_RUN_ALREADY_POSTED');
    const settlement = await post<{ id: string }>('payroll/settlements', { employeeId: leaver.id }, company.id, 'create guarded settlement');

    const draftEdit = await h.api().patch(`/api/v1/payroll/employees/${leaver.id}`)
      .set(h.auth(token)).set('X-Company-Id', company.id).send({ hireDate: '2019-01-01' });
    expect(draftEdit.status).toBe(409);
    expect(draftEdit.body.error.code).toBe('PAYROLL_SETTLEMENT_ACTIVE');

    h.ok(await act(`payroll/settlements/${settlement.id}/post`, {}, company.id), 200, 'post guarded settlement');
    const postedEdit = await h.api().patch(`/api/v1/payroll/employees/${leaver.id}`)
      .set(h.auth(token)).set('X-Company-Id', company.id).send({ leaveDate: '2026-12-30' });
    expect(postedEdit.status).toBe(409);
    expect(postedEdit.body.error.code).toBe('PAYROLL_SETTLEMENT_ACTIVE');

    const bank = h.ok(await h.api().post('/api/v1/bank-accounts').set(h.auth(token)).set('X-Company-Id', company.id).send({
      bankName: 'Settlement guard bank',
      accountId: company.accounts.find((account) => account.code === '1102')!.id,
    }), 201, 'create settlement guard bank') as { id: string };
    h.ok(await act(`payroll/settlements/${settlement.id}/pay`, {
      paymentDate: '2027-01-01', bankAccountId: bank.id,
    }, company.id), 200, 'pay guarded settlement');
    const paidEdit = await h.api().patch(`/api/v1/payroll/employees/${leaver.id}`)
      .set(h.auth(token)).set('X-Company-Id', company.id).send({ sscCovered: true });
    expect(paidEdit.status).toBe(409);
    expect(paidEdit.body.error.code).toBe('PAYROLL_SETTLEMENT_ACTIVE');

    const blockedReverse = await act(`payroll/runs/${payroll.id}/reverse`, { date: '2027-01-02' }, company.id);
    expect(blockedReverse.status).toBe(409);
    expect(blockedReverse.body.error.code).toBe('PAYROLL_SETTLEMENT_ACTIVE');
    h.ok(await act(`payroll/settlements/${settlement.id}/reverse`, {
      reversalDate: '2027-01-02',
    }, company.id), 200, 'reverse guarded settlement');
    const blockedDepartureEdit = await h.api().patch(`/api/v1/payroll/employees/${leaver.id}`)
      .set(h.auth(token)).set('X-Company-Id', company.id).send({ leaveDate: '2026-12-30' });
    expect(blockedDepartureEdit.status).toBe(409);
    expect(blockedDepartureEdit.body.error.code).toBe('PAYROLL_SETTLEMENT_ACTIVE');
    h.ok(await act(`payroll/runs/${payroll.id}/reverse`, { date: '2027-01-03' }, company.id), 201, 'reverse run after settlement');
    expect((await h.api().patch(`/api/v1/payroll/employees/${leaver.id}`)
      .set(h.auth(token)).set('X-Company-Id', company.id).send({ leaveDate: '2026-12-30' })).status).toBe(200);
  });

  it('allocates distinct first settlement numbers in separate fiscal years', async () => {
    const company = await createCompany('SEQ', true);
    h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).set('X-Company-Id', company.id).send({
      code: '2027', startDate: '2027-01-01', endDate: '2027-12-31',
    }), 201, 'create settlement sequence FY 2027');
    const firstEmployee = await employee(company, 'SEQ26', '2026-01-01', '2026-12-31', '1000.000', false);
    const secondEmployee = await employee(company, 'SEQ27', '2027-01-01', '2027-01-31', '1000.000', false);
    await run(company.id, '2026-12');
    const first = await post<{ id: string }>('payroll/settlements', { employeeId: firstEmployee.id }, company.id, 'create 2026 settlement');
    const firstPosted = h.ok(await act(`payroll/settlements/${first.id}/post`, {}, company.id), 200, 'post 2026 settlement') as {
      settlementNo: string;
    };
    expect(firstPosted.settlementNo).toBe('FS-2026-000001');

    await run(company.id, '2027-01');
    const second = await post<{ id: string }>('payroll/settlements', { employeeId: secondEmployee.id }, company.id, 'create 2027 settlement');
    const secondPosted = h.ok(await act(`payroll/settlements/${second.id}/post`, {}, company.id), 200, 'post 2027 settlement') as {
      settlementNo: string;
    };
    expect(secondPosted.settlementNo).toBe('FS-2027-000001');
  });

  it('prorates from active days before rounding and posts a fully unpaid partial month', async () => {
    const company = await createCompany('PRORATE', true);
    const employeeRecord = await employee(company, 'PRORATE', '2026-12-22', '2026-12-31', '3000.000', false);
    const unpaid = (h.ok(await get('payroll/leave-types', company.id), 200, 'proration leave types') as Array<{
      id: string; code: string;
    }>).find((type) => type.code === 'UNPAID')!;
    h.ok(await h.api().patch(`/api/v1/payroll/leave-types/${unpaid.id}`)
      .set(h.auth(token)).set('X-Company-Id', company.id).send({ countBasis: 'CALENDAR_DAYS' }), 200, 'set calendar unpaid days');
    const request = await post<{ id: string }>('payroll/leave-requests', {
      employeeId: employeeRecord.id, leaveTypeId: unpaid.id, startDate: '2026-12-22', endDate: '2026-12-31',
    }, company.id, 'create full active unpaid leave');
    h.ok(await act(`payroll/leave-requests/${request.id}/approve`, {}, company.id), 200, 'approve full active unpaid leave');
    const payroll = await run(company.id, '2026-12');
    expect(employeeLine(payroll, employeeRecord.id)).toEqual(expect.objectContaining({
      basic: '1000', deductions: '1000', net: '0',
    }));
  });
});
