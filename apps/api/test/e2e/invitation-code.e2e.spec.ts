/**
 * Invitation acceptance code (owner decision, ADR-012 §PLAT-10):
 *  - the attack chain from the review: company A creates an account for a new
 *    email and so knows its first password, takes the account over, then company
 *    B invites the same email; A cannot accept B's invitation without B's code;
 *  - a wrong code counts; after MAX_ATTEMPTS even the right code is refused;
 *  - an expired code is refused;
 *  - re-issuing a code invalidates the old one, and the new one works;
 *  - isolation: another company cannot re-issue B's code, another user cannot
 *    accept with it.
 * Real MariaDB (erp_test) and the BUILT API (`node dist/main.js`): run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3644;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const ATTACKER_PASS = 'attacker-chosen-789';

let server: ChildProcess;
let db: Connection;
let registrations = 0;

const api = () => request(BASE);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const login = (email: string, password: string, tenantId?: string) =>
  api()
    .post('/api/v1/auth/login')
    .send({ email, password, ...(tenantId ? { tenantId } : {}) });
const accept = (token: string, membershipId: string, code?: string) =>
  api()
    .post(`/api/v1/me/invitations/${membershipId}/accept`)
    .set(bearer(token))
    .send(code === undefined ? {} : { code });

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

/** Registers a company (each from its own client address: 5 a minute per address) and returns its owner's token. */
async function register(name: string, email: string): Promise<string> {
  const res = await api()
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', `198.51.100.${++registrations}`)
    .send({ tenantName: name, ownerName: `Owner ${name}`, email, password: PASS });
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

describe('Invitation acceptance code (ADR-012 §PLAT-10, erp_test)', () => {
  const nameA = `Code A ${RUN}`;
  const nameB = `Code B ${RUN}`;
  const nameC = `Code C ${RUN}`;
  const emailX = `code-x-${RUN}@test.dev`;
  let tokA = '';
  let tokB = '';
  let tokC = '';
  let tokX = '';
  let idB = '';
  let inviteB = '';
  let codeB = '';

  it('setup: company A creates the account for a new email and takes it over with the first password', async () => {
    tokA = await register(nameA, `code-a-${RUN}@test.dev`);
    tokB = await register(nameB, `code-b-${RUN}@test.dev`);
    tokC = await register(nameC, `code-c-${RUN}@test.dev`);
    idB = await tenantIdOf(nameB);

    const created = await api().post('/api/v1/users/invite').set(bearer(tokA)).send({ email: emailX, roleCode: 'VIEWER' });
    expect(created.status).toBe(201);
    const temporary = created.body.temporaryPassword as string;
    expect(created.body.acceptanceCode).toBeUndefined(); // a new account joins at once

    // A's owner signs in as the person and sets a password only A knows.
    const first = await login(emailX, temporary);
    expect(first.status).toBe(200);
    const changed = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(first.body.accessToken as string))
      .send({ currentPassword: temporary, newPassword: ATTACKER_PASS });
    expect(changed.status).toBe(204);
    tokX = (await login(emailX, ATTACKER_PASS)).body.accessToken as string;
  });

  it('company B invites the same email: INVITED with a one-time code that only B sees', async () => {
    const invited = await api().post('/api/v1/users/invite').set(bearer(tokB)).send({ email: emailX, roleCode: 'ACCOUNTANT' });
    expect(invited.status).toBe(201);
    expect(invited.body.status).toBe('INVITED');
    expect(invited.body.temporaryPassword).toBeUndefined();
    inviteB = invited.body.membershipId as string;
    codeB = invited.body.acceptanceCode as string;
    expect(codeB).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(new Date(invited.body.acceptanceCodeExpiresAt as string).getTime()).toBeGreaterThan(Date.now());

    // The code is never stored or listed.
    const [row] = await db.query<{ h: string }[]>('SELECT invite_code_hash AS h FROM tenant_memberships WHERE id = ?', [inviteB]);
    expect(row!.h).toMatch(/^[0-9a-f]{64}$/);
    const list = await api().get('/api/v1/users').set(bearer(tokB));
    expect(JSON.stringify(list.body)).not.toContain(codeB);
    const inbox = await api().get('/api/v1/me/invitations').set(bearer(tokX));
    expect(JSON.stringify(inbox.body)).not.toContain(codeB);
    expect(inbox.body.map((i: { membershipId: string }) => i.membershipId)).toContain(inviteB);
  });

  it('the attack chain: holding the account is not enough to join B', async () => {
    const noCode = await accept(tokX, inviteB);
    expect(noCode.status).toBe(400);
    expect(noCode.body.error.code).toBe('INVITATION_CODE_INVALID');
    expect(noCode.body.error.details.reason).toBe('CODE_REQUIRED');

    const wrong = await accept(tokX, inviteB, 'AAAAA-AAAAA');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVITATION_CODE_INVALID');
    expect(wrong.body.error.details).toEqual({ reason: 'WRONG_CODE', attemptsLeft: 4 });

    // Still not a member of B.
    expect((await login(emailX, ATTACKER_PASS, idB)).status).toBe(403);
  });

  it('after five wrong codes even the right code is refused, until B issues a new one', async () => {
    for (let i = 0; i < 4; i++) expect((await accept(tokX, inviteB, 'BBBBB-BBBBB')).status).toBe(400);
    const locked = await accept(tokX, inviteB, codeB);
    expect(locked.status).toBe(400);
    expect(locked.body.error.details).toEqual({ reason: 'TOO_MANY_ATTEMPTS', attemptsLeft: 0 });
    expect((await login(emailX, ATTACKER_PASS, idB)).status).toBe(403);
  });

  it('isolation: another company cannot re-issue B\'s code, and another user cannot use it', async () => {
    expect((await api().post(`/api/v1/users/${inviteB}/invitation-code`).set(bearer(tokA))).status).toBe(404);
    expect((await api().post(`/api/v1/users/${inviteB}/invitation-code`).set(bearer(tokC))).status).toBe(404);
    // C's owner is not the invitee: even a correct code answers 404.
    expect((await accept(tokC, inviteB, codeB)).status).toBe(404);
  });

  it('an expired code is refused', async () => {
    const reissued = await api().post(`/api/v1/users/${inviteB}/invitation-code`).set(bearer(tokB));
    expect(reissued.status).toBe(200);
    const fresh = reissued.body.acceptanceCode as string;
    // Prisma stores UTC; NOW() would be the server's local time.
    await db.query('UPDATE tenant_memberships SET invite_code_expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE WHERE id = ?', [inviteB]);
    const expired = await accept(tokX, inviteB, fresh);
    expect(expired.status).toBe(400);
    expect(expired.body.error.details).toEqual({ reason: 'EXPIRED', attemptsLeft: 0 });
  });

  it('re-issuing invalidates the old code; the new code (in the right hands) joins B', async () => {
    const reissued = await api().post(`/api/v1/users/${inviteB}/invitation-code`).set(bearer(tokB));
    expect(reissued.status).toBe(200);
    const newCode = reissued.body.acceptanceCode as string;
    expect(newCode).not.toBe(codeB);

    const old = await accept(tokX, inviteB, codeB);
    expect(old.status).toBe(400);
    expect(old.body.error.details.reason).toBe('WRONG_CODE');

    // Case, spaces and the dash do not matter.
    const joined = await accept(tokX, inviteB, newCode.toLowerCase().replace('-', ' '));
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ membershipId: inviteB, tenantId: idB, tenantName: nameB });
    const [row] = await db.query<{ h: string | null }[]>('SELECT invite_code_hash AS h FROM tenant_memberships WHERE id = ?', [inviteB]);
    expect(row!.h).toBeNull();
    // No code for a membership that is no longer an invitation.
    expect((await api().post(`/api/v1/users/${inviteB}/invitation-code`).set(bearer(tokB))).status).toBe(404);
  });

  it('declining needs no code', async () => {
    const invited = await api().post('/api/v1/users/invite').set(bearer(tokC)).send({ email: emailX, roleCode: 'VIEWER' });
    expect(invited.status).toBe(201);
    const declined = await api()
      .post(`/api/v1/me/invitations/${invited.body.membershipId as string}/decline`)
      .set(bearer(tokX));
    expect(declined.status).toBe(204);
  });
});
