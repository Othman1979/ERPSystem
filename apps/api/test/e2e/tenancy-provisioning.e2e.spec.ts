import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import mariadb, { type Pool } from 'mariadb';
import request from 'supertest';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { openSecret, sealSecret } from '../../src/common/crypto/secret-box.js';
import { PasswordService } from '../../src/platform/auth/password.service.js';
import { expectedSchemaVersion } from '../../src/prisma/schema-version.js';

const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = randomUUID().replaceAll('-', '').slice(0, 8);
const API_PORT = 5200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${API_PORT}`;
const SECRET_KEY = Buffer.alloc(32, 43).toString('base64');
const PASSWORD = 'isolated-test-password-123';
const CONTROL_DB = `erp_t_test${RUN}_control`;
const TENANT_PREFIX = `erp_t_test${RUN}_`;
const newInviteEmail = `invite-new-${RUN}@test.dev`;

type TestDatabase = { client: PrismaClient; pool: Pool };

let server: ChildProcess | undefined;
let adminPool: Pool | undefined;
let control: TestDatabase | undefined;
const tenantDbs: Array<{ name: string; user: string; client: PrismaClient; pool: Pool }> = [];
const extraDbs: string[] = [];
const createdUsers = new Set<string>();
let ownerTokens: string[] = [];
const ownerTenantIds: string[] = [];
const ownerEmails: string[] = ['A', 'B'].map((suffix) => `provision-${suffix}-${RUN}@test.dev`);
let itemCodes: string[] = [];

function connectionUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function prismaFor(url: string): TestDatabase {
  const parsed = new URL(url);
  const pool = mariadb.createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectionLimit: 2,
    connectTimeout: 10_000,
    collation: 'UTF8MB4_UNICODE_CI',
    initSql: ['SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci'],
  });
  return { client: new PrismaClient({ adapter: new PrismaMariaDb(pool) }), pool };
}

function migrateControl(url: string): void {
  const env = { ...process.env, DATABASE_URL: url };
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: API_DIR, env, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: API_DIR, env, stdio: 'inherit' });
}

function migrateDatabase(url: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}

async function startApi(provisioner: 'create' | 'pool'): Promise<void> {
  const adminUrl = process.env.TENANT_DB_ADMIN_URL || process.env.DATABASE_URL!;
  const admin = new URL(adminUrl);
  const controlUrl = connectionUrl(adminUrl, CONTROL_DB);
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: controlUrl,
      TENANCY_MODE: 'isolated',
      DB_PROVISIONER: provisioner,
      TENANT_DB_ADMIN_URL: adminUrl,
      TENANT_DB_HOST: admin.hostname,
      TENANT_DB_NAME_PREFIX: TENANT_PREFIX,
      TENANT_DB_USER_HOST: '%',
      TENANT_DB_POOL_LOW_WATER: '0',
      TENANT_DB_SECRET_KEY: SECRET_KEY,
      TENANT_DB_STATE_TTL_MS: '1',
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      EINVOICE_WORKER: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (data) => process.stderr.write(`[provisioning-api] ${data}`));
  await waitForHealth();
}

async function stopApi(): Promise<void> {
  if (!server) return;
  server.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  server = undefined;
}

function runJob(args: string[], provisioner: 'create' | 'pool', extraEnv: Record<string, string> = {}): string {
  const adminUrl = process.env.TENANT_DB_ADMIN_URL || process.env.DATABASE_URL!;
  const admin = new URL(adminUrl);
  return execFileSync('node', ['dist/jobs/cli.js', ...args], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: connectionUrl(adminUrl, CONTROL_DB),
      TENANCY_MODE: 'isolated',
      DB_PROVISIONER: provisioner,
      TENANT_DB_ADMIN_URL: adminUrl,
      TENANT_DB_HOST: admin.hostname,
      TENANT_DB_NAME_PREFIX: TENANT_PREFIX,
      TENANT_DB_SECRET_KEY: SECRET_KEY,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await request(BASE).get('/api/v1/health')).status === 200) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Provisioning API did not become healthy');
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for provisioning e2e');
  const adminUrl = process.env.TENANT_DB_ADMIN_URL || process.env.DATABASE_URL;
  const admin = new URL(adminUrl);
  adminPool = mariadb.createPool({
    host: admin.hostname,
    port: admin.port ? Number(admin.port) : 3306,
    user: decodeURIComponent(admin.username),
    password: decodeURIComponent(admin.password),
    connectionLimit: 2,
  });
  await adminPool.query(`CREATE DATABASE \`${CONTROL_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const controlUrl = connectionUrl(adminUrl, CONTROL_DB);
  migrateControl(controlUrl);
  control = prismaFor(controlUrl);

  await startApi('create');
}, 180_000);

afterAll(async () => {
  await stopApi();
  const registeredRows = control
    ? await control.client.tenantDatabase.findMany({
        where: { databaseName: { startsWith: TENANT_PREFIX } },
        select: { databaseName: true, dbUser: true },
      }).catch(() => [])
    : [];
  const cleanup = new Set(registeredRows.map((row) => row.databaseName));
  for (const row of tenantDbs) cleanup.add(row.name);
  for (const name of extraDbs) cleanup.add(name);
  await Promise.all(tenantDbs.map(async ({ client, pool }) => {
    await client.$disconnect();
    await pool.end();
  }));
  await control?.client.$disconnect();
  await control?.pool.end();
  if (adminPool) {
    for (const name of cleanup) {
      await adminPool.query(`DROP DATABASE IF EXISTS \`${name}\``);
    }
    for (const user of createdUsers) await adminPool.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await adminPool.query(`DROP DATABASE IF EXISTS \`${CONTROL_DB}\``);
    await adminPool.end();
  }
});

describe('isolated tenant provisioning', () => {
  it('registers separate databases, creates isolated items, and keeps the password mirror unusable', async () => {
    const companyNameAr = `Company A ${RUN}`;
    const registrations = await Promise.all(
      ownerEmails.map((email, index) =>
        request(BASE).post('/api/v1/auth/register').send({
          tenantName: `Provision ${index === 0 ? 'A' : 'B'} ${RUN}`,
          ownerName: `Owner ${index === 0 ? 'A' : 'B'}`,
          companyNameAr: index === 0 ? companyNameAr : undefined,
          email,
          password: PASSWORD,
        }),
      ),
    );
    expect(registrations.map((response) => response.status)).toEqual([201, 201]);

    ownerTokens = [];
    itemCodes = [];
    for (let index = 0; index < registrations.length; index += 1) {
      const email = ownerEmails[index]!;
      const user = await control!.client.user.findUniqueOrThrow({ where: { email } });
      const login = await request(BASE).post('/api/v1/auth/login').send({
        email,
        password: PASSWORD,
        tenantId: (await control!.client.userTenant.findFirstOrThrow({ where: { userId: user.id } })).tenantId.toString(),
      });
      expect(login.status).toBe(200);
      ownerTokens[index] = login.body.accessToken as string;
      const link = await control!.client.userTenant.findFirstOrThrow({ where: { userId: user.id } });
      ownerTenantIds[index] = link.tenantId.toString();
      const database = await control!.client.tenantDatabase.findUniqueOrThrow({ where: { tenantId: link.tenantId } });
      createdUsers.add(database.dbUser);
      expect(database.state).toBe('ACTIVE');
      expect(database.databaseName).toMatch(new RegExp(`^${TENANT_PREFIX}`));
      expect(database.schemaVersion).not.toBeNull();
      const tenantUrl = new URL(connectionUrl(process.env.TENANT_DB_ADMIN_URL || process.env.DATABASE_URL!, database.databaseName));
      tenantUrl.hostname = database.host;
      tenantUrl.port = String(database.port);
      tenantUrl.username = database.dbUser;
      tenantUrl.password = openSecret(database.passwordSealed, SECRET_KEY);
      const tenantDb = prismaFor(tenantUrl.toString());
      tenantDbs.push({ name: database.databaseName, user: database.dbUser, ...tenantDb });
      const mirroredUser = await tenantDb.client.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(mirroredUser.passwordHash).toBe('!');
      if (index === 0) {
        const company = await tenantDb.client.company.findFirstOrThrow({ where: { tenantId: link.tenantId } });
        expect(company.legalNameAr).toBe(companyNameAr);
      }

      const unit = await tenantDb.client.unit.findFirstOrThrow({ where: { tenantId: link.tenantId } });
      const created = await request(BASE)
        .post('/api/v1/items')
        .set({ Authorization: `Bearer ${registrations[index]!.body.accessToken as string}` })
        .send({ code: `ITEM-${index}-${RUN}`, nameAr: `Item ${index}`, baseUnitId: unit.id.toString() });
      expect(created.status).toBe(201);
      itemCodes.push(created.body.code as string);
    }

    expect(tenantDbs).toHaveLength(2);
    expect(await tenantDbs[0]!.client.item.count()).toBe(1);
    expect(await tenantDbs[1]!.client.item.count()).toBe(1);
    expect(await control!.client.item.count()).toBe(0);
    const rowA = await control!.client.tenantDatabase.findFirstOrThrow({
      where: { databaseName: tenantDbs[0]!.name },
    });
    const rowB = await control!.client.tenantDatabase.findFirstOrThrow({
      where: { databaseName: tenantDbs[1]!.name },
    });
    expect(rowA.databaseName).not.toBe(rowB.databaseName);
  }, 180_000);

  it('invites a new user and an existing owner, accepts both invitations, and switches into tenant A', async () => {
    const inviteNew = await request(BASE)
      .post('/api/v1/users/invite')
      .set({ Authorization: `Bearer ${ownerTokens[0]}` })
      .send({ email: newInviteEmail, roleCode: 'VIEWER' });
    expect(inviteNew.status).toBe(201);
    expect(inviteNew.body.status).toBe('INVITED');
    expect(inviteNew.body.temporaryPassword).toBeTruthy();
    expect(inviteNew.body.acceptanceCode).toBeTruthy();

    const newLogin = await request(BASE)
      .post('/api/v1/auth/login')
      .send({ email: newInviteEmail, password: inviteNew.body.temporaryPassword });
    expect(newLogin.status).toBe(200);
    const changedPassword = await request(BASE)
      .post('/api/v1/auth/change-password')
      .set({ Authorization: `Bearer ${newLogin.body.accessToken as string}` })
      .send({ currentPassword: inviteNew.body.temporaryPassword, newPassword: PASSWORD });
    expect(changedPassword.status).toBe(204);
    const acceptedLogin = await request(BASE)
      .post('/api/v1/auth/login')
      .send({ email: newInviteEmail, password: PASSWORD });
    expect(acceptedLogin.status).toBe(200);
    const newAccepted = await request(BASE)
      .post(`/api/v1/me/invitations/${inviteNew.body.membershipId}/accept`)
      .set({ Authorization: `Bearer ${acceptedLogin.body.accessToken as string}` })
      .send({ code: inviteNew.body.acceptanceCode });
    expect(newAccepted.status).toBe(200);

    const inviteExisting = await request(BASE)
      .post('/api/v1/users/invite')
      .set({ Authorization: `Bearer ${ownerTokens[0]}` })
      .send({ email: ownerEmails[1], roleCode: 'VIEWER' });
    expect(inviteExisting.status).toBe(201);
    expect(inviteExisting.body.status).toBe('INVITED');
    expect(inviteExisting.body.temporaryPassword).toBeUndefined();

    const existingInbox = await request(BASE)
      .get('/api/v1/me/invitations')
      .set({ Authorization: `Bearer ${ownerTokens[1]}` });
    expect(existingInbox.status).toBe(200);
    const existingInvitationId = `${ownerTenantIds[0]}:${inviteExisting.body.membershipId}`;
    expect(existingInbox.body.map((row: { membershipId: string }) => row.membershipId)).toContain(existingInvitationId);
    const existingAccepted = await request(BASE)
      .post(`/api/v1/me/invitations/${existingInvitationId}/accept`)
      .set({ Authorization: `Bearer ${ownerTokens[1]}` })
      .send({ code: inviteExisting.body.acceptanceCode });
    expect(existingAccepted.status).toBe(200);

    const switched = await request(BASE)
      .post('/api/v1/me/switch-tenant')
      .set({ Authorization: `Bearer ${ownerTokens[1]}` })
      .send({ tenantId: ownerTenantIds[0] });
    expect(switched.status).toBe(200);
    const visible = await request(BASE)
      .get('/api/v1/items')
      .set({ Authorization: `Bearer ${switched.body.accessToken as string}` });
    expect(visible.status).toBe(200);
    expect(visible.body.items.map((row: { code: string }) => row.code)).toContain(itemCodes[0]);
    expect(visible.body.items.map((row: { code: string }) => row.code)).not.toContain(itemCodes[1]);
  }, 90_000);

  it('migrate-all gates a behind tenant, then restores requests', async () => {
    const tenantId = BigInt(ownerTenantIds[0]!);
    await control!.client.tenantDatabase.update({
      where: { tenantId },
      data: { schemaVersion: '20200101000000_previous' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const gated = await request(BASE)
      .get('/api/v1/items')
      .set({ Authorization: `Bearer ${ownerTokens[0]}` });
    expect([gated.status, gated.body.error.code]).toEqual([503, 'TENANT_MAINTENANCE']);

    runJob(['migrate-all', '--tenant', tenantId.toString()], 'create');
    const row = await control!.client.tenantDatabase.findUniqueOrThrow({ where: { tenantId } });
    expect([row.state, row.schemaVersion]).toEqual(['ACTIVE', expectedSchemaVersion()]);
    expect((await request(BASE).get('/api/v1/items').set({ Authorization: `Bearer ${ownerTokens[0]}` })).status).toBe(200);
  }, 120_000);

  it('resumes a step-a provisioning record and activates its owner', async () => {
    const adminUrl = process.env.TENANT_DB_ADMIN_URL || process.env.DATABASE_URL!;
    const admin = new URL(adminUrl);
    const databaseName = `${TENANT_PREFIX}resume`;
    extraDbs.push(databaseName);
    await adminPool!.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    migrateDatabase(connectionUrl(adminUrl, databaseName));

    const plan = await control!.client.plan.findUniqueOrThrow({ where: { code: 'TRIAL' } });
    const password = 'resume-owner-password-123';
    const email = `resume-${RUN}@test.dev`;
    const user = await control!.client.user.create({
      data: { email, fullName: 'Resume Owner', passwordHash: await new PasswordService().hash(password) },
    });
    const tenant = await control!.client.tenant.create({
      data: {
        name: `Resume ${RUN}`,
        status: 'TRIAL',
        statusChangedAt: new Date(),
        planId: plan.id,
        trialEndsAt: new Date(Date.now() + 86_400_000),
      },
    });
    await control!.client.subscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 86_400_000),
        status: 'ACTIVE',
      },
    });
    const adminPassword = decodeURIComponent(admin.password);
    const adminUser = decodeURIComponent(admin.username);
    await control!.client.tenantDatabase.create({
      data: {
        tenantId: tenant.id,
        host: admin.hostname,
        port: admin.port ? Number(admin.port) : 3306,
        databaseName,
        dbUser: adminUser,
        passwordSealed: sealSecret(adminPassword, SECRET_KEY),
        schemaVersion: expectedSchemaVersion(),
        pendingCompanyNameAr: `Resumed Company ${RUN}`,
        state: 'PROVISIONING',
        createdAt: new Date(Date.now() - 3 * 60_000),
      },
    });
    await control!.client.userTenant.create({ data: { tenantId: tenant.id, userId: user.id } });

    runJob(['provision-resume'], 'create');
    const database = await control!.client.tenantDatabase.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(database.state).toBe('ACTIVE');
    expect(database.pendingCompanyNameAr).toBeNull();
    const resumed = prismaFor(connectionUrl(adminUrl, databaseName));
    tenantDbs.push({ name: databaseName, user: adminUser, ...resumed });
    const company = await resumed.client.company.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(company.legalNameAr).toBe(`Resumed Company ${RUN}`);
    const login = await request(BASE).post('/api/v1/auth/login').send({
      email,
      password,
      tenantId: tenant.id.toString(),
    });
    expect(login.status).toBe(200);
  }, 120_000);

  it('adds and claims a pool database, rejects a non-empty database, and leaves no account when the pool is empty', async () => {
    const adminUrl = process.env.TENANT_DB_ADMIN_URL || process.env.DATABASE_URL!;
    const admin = new URL(adminUrl);
    const poolDatabase = `${TENANT_PREFIX}pool`;
    extraDbs.push(poolDatabase);
    await adminPool!.query(`CREATE DATABASE \`${poolDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const password = decodeURIComponent(admin.password);
    runJob(
      ['db-pool-add', poolDatabase, decodeURIComponent(admin.username), '--host', admin.hostname, '--port', admin.port || '3306'],
      'pool',
      { TENANT_DB_PASSWORD: password },
    );
    await stopApi();
    await startApi('pool');

    const pooled = await request(BASE).post('/api/v1/auth/register').send({
      tenantName: `Pooled ${RUN}`,
      ownerName: 'Pooled Owner',
      email: `pooled-${RUN}@test.dev`,
      password: PASSWORD,
    });
    expect(pooled.status).toBe(201);
    const pooledUser = await control!.client.user.findUniqueOrThrow({ where: { email: `pooled-${RUN}@test.dev` } });
    const pooledLink = await control!.client.userTenant.findFirstOrThrow({ where: { userId: pooledUser.id } });
    const poolRow = await control!.client.tenantDbPool.findFirstOrThrow({ where: { databaseName: poolDatabase } });
    expect(poolRow.claimedByTenantId).toBe(pooledLink.tenantId);
    createdUsers.delete(decodeURIComponent(admin.username));

    const nonEmpty = `${TENANT_PREFIX}nonempty`;
    extraDbs.push(nonEmpty);
    await adminPool!.query(`CREATE DATABASE \`${nonEmpty}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await adminPool!.query(`CREATE TABLE \`${nonEmpty}\`.sentinel (id INT PRIMARY KEY)`);
    expect(() =>
      runJob(
        ['db-pool-add', nonEmpty, decodeURIComponent(admin.username), '--host', admin.hostname, '--port', admin.port || '3306'],
        'pool',
        { TENANT_DB_PASSWORD: password },
      ),
    ).toThrow();
    expect(await control!.client.tenantDbPool.findFirst({ where: { databaseName: nonEmpty } })).toBeNull();

    const before = {
      users: await control!.client.user.count(),
      tenants: await control!.client.tenant.count(),
      subscriptions: await control!.client.subscription.count(),
    };
    const unavailable = await request(BASE).post('/api/v1/auth/register').send({
      tenantName: `No pool ${RUN}`,
      ownerName: 'No Pool Owner',
      email: `no-pool-${RUN}@test.dev`,
      password: PASSWORD,
    });
    expect([unavailable.status, unavailable.body.error.code]).toEqual([503, 'REGISTRATION_UNAVAILABLE']);
    expect({
      users: await control!.client.user.count(),
      tenants: await control!.client.tenant.count(),
      subscriptions: await control!.client.subscription.count(),
    }).toEqual(before);
  }, 180_000);
});
