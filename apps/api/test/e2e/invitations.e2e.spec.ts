/**
 * Invitations and membership (owner decisions on user management):
 *  - an existing user is invited as INVITED and accepts or declines it themself;
 *  - a new user gets a temporary password and must change it at first sign-in;
 *  - an owner cannot activate an invitation, only cancel it;
 *  - users see and answer only their own invitations (isolation);
 *  - only the owner manages users (PLAT-28).
 * Real MariaDB (erp_test) and the BUILT API (`node dist/main.js`): run `pnpm build` first.
 * Each run has a RUN suffix. The companies get a dedicated plan, so the TRIAL limit
 * of three members does not cut the scenarios short.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3642;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const NEW_PASS = 'invited-new-456';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const login = (email: string, password: string, tenantId?: string) =>
  api()
    .post('/api/v1/auth/login')
    .send({ email, password, ...(tenantId ? { tenantId } : {}) });
const idsOf = (rows: { membershipId: string }[]) => rows.map((r) => r.membershipId);

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

/** Registers a company and returns its owner's access token (scoped to that company). */
async function register(tenantName: string, email: string): Promise<string> {
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName, ownerName: `Owner ${tenantName}`, email, password: PASS });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

async function tenantIdOf(name: string): Promise<string> {
  const rows = await db.query<{ id: bigint }[]>('SELECT id FROM tenants WHERE name = ?', [name]);
  return String(rows[0]!.id);
}

beforeAll(async () => {
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
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
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Invitations and membership (erp_test)', () => {
  const nameA = `Inv A ${RUN}`;
  const nameB = `Inv B ${RUN}`;
  const nameC = `Inv C ${RUN}`;
  const nameE = `Inv E ${RUN}`;
  const nameF = `Inv F ${RUN}`;
  const emailA = `inv-owner-a-${RUN}@test.dev`;
  const emailB = `inv-owner-b-${RUN}@test.dev`;
  const emailC = `inv-owner-c-${RUN}@test.dev`;
  const emailE = `inv-only-${RUN}@test.dev`;
  const emailF = `inv-cancel-${RUN}@test.dev`;
  const emailNew = `inv-new-${RUN}@test.dev`;
  const emailAcc = `inv-acc-${RUN}@test.dev`;

  // Owner tokens come from registration: each is scoped to its own company.
  let tokA = '';
  let tokB = '';
  let tokC = '';
  let tokF = '';
  let tokBInA = '';
  let idA = '';
  let idE = '';
  let inviteB = '';
  let codeB = '';
  let inviteBC = '';
  let inviteF = '';
  let inviteE = '';
  let codeE = '';

  it('sets up four companies on a dedicated plan', async () => {
    tokA = await register(nameA, emailA);
    tokB = await register(nameB, emailB);
    tokC = await register(nameC, emailC);
    await register(nameE, emailE);
    tokF = await register(nameF, emailF);

    const plan = (await db.query(
      `INSERT INTO plans (code, name_ar, name_en, max_users, max_branches, max_warehouses,
                          max_invoices_per_month, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 50, 50, 50, 100000, 1, NOW(3), NOW(3))`,
      [`E2E-INV-${RUN}`, `E2E ${RUN}`, `E2E ${RUN}`],
    )) as { insertId: bigint };
    await db.query('UPDATE tenants SET plan_id = ? WHERE name LIKE ?', [plan.insertId, `%${RUN}`]);

    idA = await tenantIdOf(nameA);
    idE = await tenantIdOf(nameE);
  });

  it('a new user gets an ACTIVE membership and a temporary password, and changes it at first sign-in', async () => {
    const invited = await api()
      .post('/api/v1/users/invite')
      .set(bearer(tokA))
      .send({ email: emailNew, roleCode: 'VIEWER' });
    expect(invited.status).toBe(201);
    expect(invited.body.status).toBe('ACTIVE');
    const temporary = invited.body.temporaryPassword as string;
    expect(typeof temporary).toBe('string');

    const first = await login(emailNew, temporary);
    expect(first.status).toBe(200);
    const blocked = await api().get('/api/v1/branches').set(bearer(first.body.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(first.body.accessToken))
      .send({ currentPassword: temporary, newPassword: NEW_PASS });
    expect(changed.status).toBe(204);

    const second = await login(emailNew, NEW_PASS);
    expect(second.status).toBe(200);
    const ok = await api().get('/api/v1/branches').set(bearer(second.body.accessToken));
    expect(ok.status).toBe(200);
  });

  it('refuses a password chosen by the inviter', async () => {
    const res = await api()
      .post('/api/v1/users/invite')
      .set(bearer(tokA))
      .send({ email: `inv-pw-${RUN}@test.dev`, roleCode: 'VIEWER', password: 'chosen-by-owner-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('invites an existing user as INVITED: the name stays hidden and their companies are unchanged until they accept', async () => {
    const invited = await api()
      .post('/api/v1/users/invite')
      .set(bearer(tokA))
      .send({ email: emailB, roleCode: 'VIEWER' });
    expect(invited.status).toBe(201);
    expect(invited.body.status).toBe('INVITED');
    expect(invited.body.temporaryPassword).toBeUndefined();
    expect(invited.body.user.fullName).toBeNull();
    inviteB = invited.body.membershipId as string;
    codeB = invited.body.acceptanceCode as string;
    expect(codeB).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    const listA = await api().get('/api/v1/users').set(bearer(tokA));
    const row = listA.body.find((m: { membershipId: string }) => m.membershipId === inviteB);
    expect(row.status).toBe('INVITED');
    expect(row.user.fullName).toBeNull();
    expect(row.user.email).toBe(emailB);

    const tenantsB = await api().get('/api/v1/me/tenants').set(bearer(tokB));
    const namesB = tenantsB.body.map((t: { name: string }) => t.name);
    expect(namesB).toContain(nameB);
    expect(namesB).not.toContain(nameA);

    // Not a member until the invitation is accepted.
    const notYet = await login(emailB, PASS, idA);
    expect(notYet.status).toBe(403);

    const inbox = await api().get('/api/v1/me/invitations').set(bearer(tokB));
    expect(inbox.status).toBe(200);
    const mine = inbox.body.find((i: { membershipId: string }) => i.membershipId === inviteB);
    expect(mine).toMatchObject({
      tenantId: idA,
      tenantName: nameA,
      role: { code: 'VIEWER' },
      invitedBy: { email: emailA },
    });
  });

  it('accepts the invitation, then switches to that company', async () => {
    const accepted = await api().post(`/api/v1/me/invitations/${inviteB}/accept`).set(bearer(tokB)).send({ code: codeB });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ membershipId: inviteB, tenantId: idA, tenantName: nameA });

    const switched = await api()
      .post('/api/v1/me/switch-tenant')
      .set(bearer(tokB))
      .send({ tenantId: idA });
    expect(switched.status).toBe(200);
    tokBInA = switched.body.accessToken as string;
    expect((await api().get('/api/v1/branches').set(bearer(tokBInA))).status).toBe(200);

    const listA = await api().get('/api/v1/users').set(bearer(tokA));
    const row = listA.body.find((m: { membershipId: string }) => m.membershipId === inviteB);
    expect(row.status).toBe('ACTIVE');
    expect(row.user.fullName).not.toBeNull();
  });

  it('declining removes the invitation from the inbox and from the company list', async () => {
    const invited = await api()
      .post('/api/v1/users/invite')
      .set(bearer(tokC))
      .send({ email: emailB, roleCode: 'VIEWER' });
    expect(invited.status).toBe(201);
    inviteBC = invited.body.membershipId as string;

    const before = await api().get('/api/v1/me/invitations').set(bearer(tokBInA));
    expect(idsOf(before.body)).toContain(inviteBC);

    const declined = await api()
      .post(`/api/v1/me/invitations/${inviteBC}/decline`)
      .set(bearer(tokBInA));
    expect(declined.status).toBe(204);

    const after = await api().get('/api/v1/me/invitations').set(bearer(tokBInA));
    expect(idsOf(after.body)).not.toContain(inviteBC);
    const listC = await api().get('/api/v1/users').set(bearer(tokC));
    expect(idsOf(listC.body)).not.toContain(inviteBC);

    const again = await api()
      .post(`/api/v1/me/invitations/${inviteBC}/decline`)
      .set(bearer(tokBInA));
    expect(again.status).toBe(404);
  });

  it('an owner cannot activate an invitation; cancelling it removes the membership', async () => {
    const invited = await api()
      .post('/api/v1/users/invite')
      .set(bearer(tokA))
      .send({ email: emailF, roleCode: 'VIEWER' });
    expect(invited.status).toBe(201);
    inviteF = invited.body.membershipId as string;

    const activate = await api()
      .patch(`/api/v1/users/${inviteF}`)
      .set(bearer(tokA))
      .send({ status: 'ACTIVE' });
    expect(activate.status).toBe(403);
    expect(activate.body.error.code).toBe('FORBIDDEN');

    // The inviting company cannot reset the invited person's password (identity takeover).
    const reset = await api().post(`/api/v1/users/${inviteF}/reset-password`).set(bearer(tokA));
    expect(reset.status).toBe(403);
    expect(reset.body.error.code).toBe('PASSWORD_RESET_NOT_ALLOWED');

    // Re-roling a mistaken OWNER invitation is not "removing the last owner".
    const asOwner = await api().patch(`/api/v1/users/${inviteF}`).set(bearer(tokA)).send({ roleCode: 'OWNER' });
    expect(asOwner.status).toBe(200);
    const back = await api().patch(`/api/v1/users/${inviteF}`).set(bearer(tokA)).send({ roleCode: 'VIEWER' });
    expect(back.status).toBe(200);
    expect(back.body.role.code).toBe('VIEWER');

    const cancelled = await api().delete(`/api/v1/users/${inviteF}`).set(bearer(tokA));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ membershipId: inviteF, cancelled: true });

    const inboxF = await api().get('/api/v1/me/invitations').set(bearer(tokF));
    expect(idsOf(inboxF.body)).not.toContain(inviteF);
    const listA = await api().get('/api/v1/users').set(bearer(tokA));
    expect(idsOf(listA.body)).not.toContain(inviteF);
  });

  it('a user cannot accept or decline another user\'s invitation, and a company never sees another company\'s members', async () => {
    const invited = await api()
      .post('/api/v1/users/invite')
      .set(bearer(tokA))
      .send({ email: emailE, roleCode: 'VIEWER' });
    expect(invited.status).toBe(201);
    inviteE = invited.body.membershipId as string;
    codeE = invited.body.acceptanceCode as string;

    // Company B's owner is not the invitee.
    // Even with the right code: the invitation is not theirs.
    const accept = await api().post(`/api/v1/me/invitations/${inviteE}/accept`).set(bearer(tokB)).send({ code: codeE });
    expect(accept.status).toBe(404);
    const decline = await api()
      .post(`/api/v1/me/invitations/${inviteE}/decline`)
      .set(bearer(tokB));
    expect(decline.status).toBe(404);
    const inboxB = await api().get('/api/v1/me/invitations').set(bearer(tokB));
    expect(idsOf(inboxB.body)).not.toContain(inviteE);

    const listB = await api().get('/api/v1/users').set(bearer(tokB));
    expect(listB.status).toBe(200);
    const emailsInB = listB.body.map((m: { user: { email: string } }) => m.user.email);
    expect(emailsInB).toContain(emailB);
    expect(emailsInB).not.toContain(emailA);
    expect(emailsInB).not.toContain(emailE);
    expect(emailsInB).not.toContain(emailNew);
    expect(idsOf(listB.body)).not.toContain(inviteE);
    expect(idsOf(listB.body)).not.toContain(inviteB);
  });

  it('a member whose only membership is an invitation signs in with it pending, then accepts it', async () => {
    // Leave the registered member with no active company of their own.
    await db.query(
      `UPDATE tenant_memberships tm JOIN users u ON u.id = tm.user_id
          SET tm.status = 'SUSPENDED'
        WHERE u.email = ? AND tm.tenant_id = ?`,
      [emailE, idE],
    );

    const signIn = await login(emailE, PASS);
    expect(signIn.status).toBe(200);
    expect(signIn.body.pendingInvitations).toBe(1);
    const tokPending = signIn.body.accessToken as string;

    // No company is selected yet, so business routes refuse the session.
    expect((await api().get('/api/v1/branches').set(bearer(tokPending))).status).toBe(401);

    const inbox = await api().get('/api/v1/me/invitations').set(bearer(tokPending));
    expect(idsOf(inbox.body)).toEqual([inviteE]);

    const accepted = await api()
      .post(`/api/v1/me/invitations/${inviteE}/accept`)
      .set(bearer(tokPending))
      .send({ code: codeE });
    expect(accepted.status).toBe(200);

    const signedIn = await login(emailE, PASS);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.tenants.map((t: { name: string }) => t.name)).toEqual([nameA]);
    expect((await api().get('/api/v1/branches').set(bearer(signedIn.body.accessToken))).status).toBe(
      200,
    );
  });

  it('an accountant cannot manage users or see the directory; the owner can', async () => {
    const acc = await addMember(BASE, tokA, {
      email: emailAcc,
      roleCode: 'ACCOUNTANT',
      password: PASS,
    });

    const list = await api().get('/api/v1/users').set(bearer(acc.token));
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');

    const invite = await api()
      .post('/api/v1/users/invite')
      .set(bearer(acc.token))
      .send({ email: `inv-blocked-${RUN}@test.dev`, roleCode: 'VIEWER' });
    expect(invite.status).toBe(403);

    const roles = await api().get('/api/v1/users/roles').set(bearer(acc.token));
    expect(roles.status).toBe(403);

    expect((await api().get('/api/v1/users').set(bearer(tokA))).status).toBe(200);
    expect((await api().get('/api/v1/users/roles').set(bearer(tokA))).status).toBe(200);
  });
});
