/**
 * Phase 25 (ADR-040): several companies in one tenant. C1 the owner adds a company with its own
 * chart and MAIN branch, picked with X-Company-Id; C2 a company of another tenant, or a bad id,
 * is refused; C3 a member restricted to one company cannot use the other, and the last active
 * company cannot be deactivated. Real MariaDB, two tenants (A & B). Spawns the BUILT API.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3872;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string, companyId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(companyId ? { 'X-Company-Id': companyId } : {}),
});

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await api().get('/api/v1/health');
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

beforeAll(async () => {
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl(), API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

describe('multi-company (ADR-040)', () => {
  let ownerA = '';
  let ownerB = '';
  let memberToken = '';
  let memberMembership = '';
  let first = '';
  let second = '';

  const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

  it('sets up tenant A (owner, accountant) and tenant B (owner)', async () => {
    const a = await api().post('/api/v1/auth/register').send({ tenantName: `MC A ${RUN}`, ownerName: 'Owner A', email: `mc-a-${RUN}@test.dev`, password: PASS });
    const b = await api().post('/api/v1/auth/register').send({ tenantName: `MC B ${RUN}`, ownerName: 'Owner B', email: `mc-b-${RUN}@test.dev`, password: PASS });
    expect([a.status, b.status]).toEqual([201, 201]);
    ownerA = a.body.accessToken;
    ownerB = b.body.accessToken;
    const m = await addMember(BASE, ownerA, { email: `mc-m-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS });
    memberToken = m.token;
    memberMembership = m.membershipId;
    const list = await api().get('/api/v1/companies').set(auth(ownerA));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].current).toBe(true);
    first = list.body[0].id;
  });

  it('C1: the owner adds a company with its own chart and MAIN branch', async () => {
    const created = await api().post('/api/v1/companies').set(auth(ownerA)).send({ legalNameAr: 'الشركة الثانية', legalNameEn: 'Second Co' });
    expect(created.status).toBe(201);
    second = created.body.id;
    expect(second).not.toBe(first);
    const denied = await api().post('/api/v1/companies').set(auth(memberToken)).send({ legalNameAr: 'x' });
    expect(denied.status).toBe(403);

    const listed = await api().get('/api/v1/companies').set(auth(ownerA, second));
    expect(listed.body.map((c: { id: string; current: boolean }) => [c.id, c.current])).toEqual([[first, false], [second, true]]);

    const accounts1 = await api().get('/api/v1/accounts').set(auth(ownerA, first));
    const accounts2 = await api().get('/api/v1/accounts').set(auth(ownerA, second));
    expect([accounts1.status, accounts2.status]).toEqual([200, 200]);
    expect(accounts2.body.length).toBeGreaterThan(0);
    const one = ids(accounts1.body);
    expect(accounts2.body.some((r: { id: string }) => one.has(r.id))).toBe(false);

    const branches1 = await api().get('/api/v1/branches').set(auth(ownerA, first));
    const branches2 = await api().get('/api/v1/branches').set(auth(ownerA, second));
    expect([branches1.status, branches2.status]).toEqual([200, 200]);
    const b1 = ids(branches1.body.items ?? branches1.body);
    const rows2 = (branches2.body.items ?? branches2.body) as { id: string; code: string }[];
    expect(rows2.map((r) => r.code)).toEqual(['MAIN']);
    expect(rows2.some((r) => b1.has(r.id))).toBe(false);
  });

  it('C4: item, party, and stock reads stay within the selected company', async () => {
    const headers = auth(ownerA, first);
    const units = await api().get('/api/v1/units').set(headers);
    expect(units.status).toBe(200);
    const baseUnit = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS') ?? units.body[0];
    const item = await api().post('/api/v1/items').set(headers).send({
      code: `MC-${RUN}`,
      nameAr: 'صنف الشركة الأولى',
      baseUnitId: baseUnit.id,
    });
    expect(item.status).toBe(201);

    const party = await api().post('/api/v1/parties').set(headers).send({
      code: `MC-${RUN}`,
      nameAr: 'عميل الشركة الأولى',
      partyType: 'CUSTOMER',
    });
    expect(party.status).toBe(201);

    const fiscalYear = await api().post('/api/v1/fiscal-years').set(headers).send({
      code: `MC-${RUN}`,
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    expect(fiscalYear.status).toBe(201);

    const warehouse = await api().post('/api/v1/warehouses').set(headers).send({
      code: `MC-${RUN}`,
      nameAr: 'مستودع الشركة الأولى',
    });
    expect(warehouse.status).toBe(201);
    const adjustment = await api().post('/api/v1/stock-adjustments').set(headers).send({
      adjustmentDate: '2025-01-13',
      adjustmentType: 'OPENING',
      warehouseId: warehouse.body.id,
      lines: [{ itemId: item.body.id, qty: '7', unitCost: '1.000' }],
    });
    expect(adjustment.status).toBe(201);
    const posted = await api()
      .post(`/api/v1/stock-adjustments/${adjustment.body.id}/post`)
      .set(headers)
      .set('Idempotency-Key', `mc-stock-${RUN}`);
    expect(posted.status).toBe(201);

    const otherItem = await api().get(`/api/v1/items/${item.body.id}`).set(auth(ownerA, second));
    const ownItem = await api().get(`/api/v1/items/${item.body.id}`).set(headers);
    const otherPatch = await api().patch(`/api/v1/items/${item.body.id}`).set(auth(ownerA, second)).send({ nameAr: 'تعديل ممنوع' });
    expect([otherItem.status, ownItem.status, otherPatch.status]).toEqual([404, 200, 404]);

    const otherParty = await api().get(`/api/v1/parties/${party.body.id}`).set(auth(ownerA, second));
    const ownParty = await api().get(`/api/v1/parties/${party.body.id}`).set(headers);
    expect([otherParty.status, ownParty.status]).toEqual([404, 200]);

    const otherItems = await api().get('/api/v1/items').set(auth(ownerA, second));
    const ownItems = await api().get('/api/v1/items').set(headers);
    expect(otherItems.body.items.some((row: { id: string }) => row.id === item.body.id)).toBe(false);
    expect(ownItems.body.items.some((row: { id: string }) => row.id === item.body.id)).toBe(true);

    const otherBalances = await api().get('/api/v1/stock/balances').set(auth(ownerA, second));
    const ownBalances = await api().get('/api/v1/stock/balances').set(headers);
    expect(otherBalances.body.some((row: { itemId: string }) => row.itemId === item.body.id)).toBe(false);
    expect(ownBalances.body.some((row: { itemId: string }) => row.itemId === item.body.id)).toBe(true);
  });

  it('exports company-owned records from every company when one company is selected', async () => {
    const exported = await api()
      .get('/api/v1/export/tenant-data')
      .set(auth(ownerA, second))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    const files = unzipSync(new Uint8Array(exported.body as Buffer));
    const payroll = new ExcelJS.Workbook();
    await payroll.xlsx.load(Buffer.from(files['16-payroll.xlsx']!) as unknown as ArrayBuffer);
    expect(payroll.getWorksheet('Employee')).toBeDefined();
    expect(payroll.getWorksheet('PayrollRun')).toBeDefined();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(files['01-company.xlsx']!) as unknown as ArrayBuffer);
    const rows: unknown[][] = [];
    workbook.getWorksheet('Branch')!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    const [header, ...branches] = rows;
    const companyIdColumn = header!.indexOf('companyId');
    expect(branches.map((row) => row[companyIdColumn])).toEqual(expect.arrayContaining([first, second]));
  });

  it('does not deactivate a tenant-wide item group used by another company', async () => {
    const units = await api().get('/api/v1/units').set(auth(ownerA, first));
    const baseUnit = (units.body as { id: string; code: string }[]).find((unit) => unit.code === 'PCS') ?? units.body[0];
    const group = await api().post('/api/v1/item-groups').set(auth(ownerA, first)).send({
      code: `MC-G-${RUN}`,
      nameAr: 'مجموعة مشتركة',
    });
    expect(group.status).toBe(201);
    const item = await api().post('/api/v1/items').set(auth(ownerA, first)).send({
      code: `MC-GI-${RUN}`,
      nameAr: 'صنف الشركة الأولى',
      baseUnitId: baseUnit.id,
      itemGroupId: group.body.id,
    });
    expect(item.status).toBe(201);
    expect(item.body.itemGroupId).toBe(group.body.id);
    const inSecond = await api().get('/api/v1/items').set(auth(ownerA, second));
    expect(inSecond.body.items.some((row: { id: string }) => row.id === item.body.id)).toBe(false);

    const deactivate = await api().patch(`/api/v1/item-groups/${group.body.id}`).set(auth(ownerA, second)).send({ isActive: false });
    expect(deactivate.status).toBe(409);
    expect(deactivate.body.error.code).toBe('CONFLICT');
  });

  it('C2: another tenant cannot pick the company, and the header must be an id', async () => {
    const other = await api().get('/api/v1/accounts').set(auth(ownerB, second));
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('COMPANY_NOT_ALLOWED');
    const bad = await api().get('/api/v1/accounts').set(auth(ownerA, 'abc'));
    expect(bad.status).toBe(400);
    const patch = await api().patch(`/api/v1/companies/${second}`).set(auth(ownerB)).send({ legalNameAr: 'x' });
    expect(patch.status).toBe(404);
  });

  it('C3: a branch assigned in the first company does not restrict the second', async () => {
    const branch1 = (await api().get('/api/v1/branches').set(auth(ownerA, first))).body;
    const mainId = ((branch1.items ?? branch1) as { id: string }[])[0]!.id;
    const assign = await api().patch(`/api/v1/users/${memberMembership}`).set(auth(ownerA)).send({ branchIds: [mainId] });
    expect(assign.status).toBe(200);
    const inSecond = await api().get('/api/v1/accounts').set(auth(memberToken, second));
    expect(inSecond.status).toBe(200);
    const me = await api().get('/api/v1/me').set(auth(memberToken, second));
    expect(me.body.currentMembership.companyId).toBe(second);
    expect(me.body.currentMembership.branches.map((b: { code: string }) => b.code)).toEqual(['MAIN']);
    expect(me.body.currentMembership.branches[0].id).not.toBe(mainId);
    await api().patch(`/api/v1/users/${memberMembership}`).set(auth(ownerA)).send({ branchIds: [] });
  });

  it('C3: a member can be assigned branches from both companies', async () => {
    const branches1 = await api().get('/api/v1/branches').set(auth(ownerA, first));
    const branches2 = await api().get('/api/v1/branches').set(auth(ownerA, second));
    const branch1 = ((branches1.body.items ?? branches1.body) as { id: string }[])[0]!;
    const branch2 = ((branches2.body.items ?? branches2.body) as { id: string }[])[0]!;

    const assigned = await api()
      .patch(`/api/v1/users/${memberMembership}`)
      .set(auth(ownerA, first))
      .send({ branchIds: [branch1.id, branch2.id] });
    expect([assigned.status, assigned.body.error?.message]).toEqual([200, undefined]);

    const meFirst = await api().get('/api/v1/me').set(auth(memberToken, first));
    const meSecond = await api().get('/api/v1/me').set(auth(memberToken, second));
    expect(meFirst.body.currentMembership.branches.map((branch: { id: string }) => branch.id)).toEqual([branch1.id]);
    expect(meSecond.body.currentMembership.branches.map((branch: { id: string }) => branch.id)).toEqual([branch2.id]);
    await api().patch(`/api/v1/users/${memberMembership}`).set(auth(ownerA)).send({ branchIds: [] });
  });

  it('C3: a member restricted to the first company cannot use the second', async () => {
    const before = await api().get('/api/v1/accounts').set(auth(memberToken, second));
    expect(before.status).toBe(200);
    const restrict = await api().patch(`/api/v1/users/${memberMembership}`).set(auth(ownerA)).send({ companyIds: [first] });
    expect(restrict.status).toBe(200);
    expect(restrict.body.companyIds).toEqual([first]);
    const after = await api().get('/api/v1/accounts').set(auth(memberToken, second));
    expect(after.status).toBe(403);
    const listed = await api().get('/api/v1/companies').set(auth(memberToken));
    expect(listed.body.map((c: { id: string }) => c.id)).toEqual([first]);
  });

  it('C3: the last active company cannot be deactivated', async () => {
    const off = await api().patch(`/api/v1/companies/${second}`).set(auth(ownerA)).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    const last = await api().patch(`/api/v1/companies/${first}`).set(auth(ownerA)).send({ isActive: false });
    expect(last.status).toBe(409);
    const gone = await api().get('/api/v1/accounts').set(auth(ownerA, second));
    expect(gone.status).toBe(403);
  });
});
