import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ConfigService } from '@nestjs/config';
import mariadb, { type Pool } from 'mariadb';
import { ClsServiceManager } from 'nestjs-cls';
import request from 'supertest';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import type { Env } from '../../src/common/config/env.validation.js';
import { sealSecret } from '../../src/common/crypto/secret-box.js';
import type { RequestContext } from '../../src/common/cls/cls.types.js';
import { AuditService } from '../../src/common/audit/audit.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { CompaniesService } from '../../src/platform/accounting/companies.service.js';
import { ChartProvisioningService } from '../../src/platform/accounting/chart-provisioning.service.js';
import { PasswordService } from '../../src/platform/auth/password.service.js';

const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = randomUUID().replaceAll('-', '').slice(0, 10);
const API_PORT = 4300 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${API_PORT}`;
const SECRET_KEY = Buffer.alloc(32, 29).toString('base64');
const PASSWORD = 'test-password-123';
const DB_NAMES = [`erp_test_ctl_${RUN}`, `erp_test_ta_${RUN}`, `erp_test_tb_${RUN}`] as const;

type Database = { client: PrismaClient; pool: Pool };

let server: ChildProcess | undefined;
let adminPool: Pool | undefined;
let control: Database | undefined;
let tenantA: Database | undefined;
let tenantB: Database | undefined;
let routingPrisma: PrismaService | undefined;
let tokenA = '';
let tokenB = '';
let idA = '';
let idB = '';
let userBId = '';
let emailB = '';
let partyA = '';
let itemA = '';

function databaseUrl(database: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

function prismaFor(url: string): Database {
  const parsed = new URL(url);
  const pool = mariadb.createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectionLimit: 3,
    connectTimeout: 10_000,
    collation: 'UTF8MB4_UNICODE_CI',
    initSql: ['SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci'],
  });
  return { client: new PrismaClient({ adapter: new PrismaMariaDb(pool) }), pool };
}

function migrateAndSeed(url: string): void {
  const env = { ...process.env, DATABASE_URL: url };
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: API_DIR, env, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: API_DIR, env, stdio: 'inherit' });
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
  throw new Error('Isolated API did not become healthy');
}

async function createTenantCompany(
  db: Database,
  tenantId: bigint,
  userId: bigint,
  membershipId: bigint,
  name: string,
): Promise<bigint> {
  const companies = new CompaniesService(
    routingPrisma!,
    new ChartProvisioningService(),
    new AuditService(routingPrisma!),
  );
  await routingPrisma!.router.resolve(tenantId);
  const cls = ClsServiceManager.getClsService<RequestContext>();
  return cls.run(async () => {
    cls.set('tenantId', tenantId);
    cls.set('userId', userId);
    cls.set('membershipId', membershipId);
    cls.set('roleCode', 'OWNER');
    const company = await companies.create({ legalNameAr: name });
    const companyId = BigInt(company.id);
    const branch = await db.client.branch.findFirstOrThrow({
      where: { tenantId, companyId, code: 'MAIN' },
      select: { id: true },
    });
    await db.client.tenantMembership.update({
      where: { id: membershipId },
      data: { defaultBranchId: branch.id },
    });
    return companyId;
  });
}

async function provisionTenant(index: number, name: string, email: string): Promise<{ tenantId: bigint; userId: bigint; companyId: bigint; accessToken: string }> {
  const db = index === 0 ? tenantA! : tenantB!;
  const plan = await control!.client.plan.findUniqueOrThrow({ where: { code: 'TRIAL' } });
  const ownerRole = await control!.client.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const user = await control!.client.user.create({ data: { email, fullName: name, passwordHash } });
  const tenant = await control!.client.tenant.create({
    data: { name, planId: plan.id, status: 'TRIAL', trialEndsAt: new Date(Date.now() + 86_400_000) },
  });
  const dbName = DB_NAMES[index + 1]!;
  const parsed = new URL(databaseUrl(dbName));
  await control!.client.tenantDatabase.create({
    data: {
      tenantId: tenant.id,
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      databaseName: dbName,
      dbUser: decodeURIComponent(parsed.username),
      passwordSealed: sealSecret(decodeURIComponent(parsed.password), SECRET_KEY),
      state: 'ACTIVE',
    },
  });
  await control!.client.userTenant.create({ data: { tenantId: tenant.id, userId: user.id } });

  const mirrorTenant = await db.client.tenant.create({
    data: { id: tenant.id, name, planId: plan.id, status: 'TRIAL', trialEndsAt: tenant.trialEndsAt },
  });
  void mirrorTenant;
  await db.client.user.create({
    data: { id: user.id, email, fullName: name, passwordHash: '!' },
  });
  const membership = await db.client.tenantMembership.create({
    data: { tenantId: tenant.id, userId: user.id, roleId: ownerRole.id, status: 'ACTIVE' },
  });
  const companyId = await createTenantCompany(db, tenant.id, user.id, membership.id, name);

  return { tenantId: tenant.id, userId: user.id, companyId, accessToken: '' };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for isolated tenancy e2e');
  const base = new URL(process.env.DATABASE_URL);
  adminPool = mariadb.createPool({
    host: base.hostname,
    port: base.port ? Number(base.port) : 3306,
    user: decodeURIComponent(base.username),
    password: decodeURIComponent(base.password),
    connectionLimit: 2,
  });
  for (const name of DB_NAMES) {
    await adminPool.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    migrateAndSeed(databaseUrl(name));
  }
  control = prismaFor(databaseUrl(DB_NAMES[0]));
  tenantA = prismaFor(databaseUrl(DB_NAMES[1]));
  tenantB = prismaFor(databaseUrl(DB_NAMES[2]));
  routingPrisma = new PrismaService(
    new ConfigService<Env, true>({
      DATABASE_URL: databaseUrl(DB_NAMES[0]),
      DB_POOL_SIZE: 3,
      DB_POOL_ACQUIRE_TIMEOUT_MS: 10_000,
      TENANCY_MODE: 'isolated',
      TENANT_DB_POOL_SIZE: 3,
      TENANT_DB_IDLE_MS: 600_000,
      TENANT_DB_MAX_POOLS: 50,
      TENANT_DB_STATE_TTL_MS: 1,
      TENANT_DB_SECRET_KEY: SECRET_KEY,
    }),
  );

  const a = await provisionTenant(0, `Tenant A ${RUN}`, `owner-a-${RUN}@test.dev`);
  const b = await provisionTenant(1, `Tenant B ${RUN}`, `owner-b-${RUN}@test.dev`);
  idA = a.tenantId.toString();
  idB = b.tenantId.toString();
  userBId = b.userId.toString();
  emailB = `owner-b-${RUN}@test.dev`;

  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(DB_NAMES[0]),
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      EINVOICE_WORKER: 'off',
      TENANCY_MODE: 'isolated',
      TENANT_DB_SECRET_KEY: SECRET_KEY,
      TENANT_DB_STATE_TTL_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (data) => process.stderr.write(`[isolated-api] ${data}`));
  await waitForHealth();
  const loginA = await request(BASE).post('/api/v1/auth/login').send({ email: `owner-a-${RUN}@test.dev`, password: PASSWORD, tenantId: a.tenantId.toString() });
  const loginB = await request(BASE).post('/api/v1/auth/login').send({ email: `owner-b-${RUN}@test.dev`, password: PASSWORD, tenantId: b.tenantId.toString() });
  expect(loginA.status).toBe(200);
  expect(loginB.status).toBe(200);
  expect(loginA.body.tenants).toEqual(expect.arrayContaining([expect.objectContaining({ tenantId: a.tenantId.toString() })]));
  expect(loginB.body.tenants).toEqual(expect.arrayContaining([expect.objectContaining({ tenantId: b.tenantId.toString() })]));
  tokenA = loginA.body.accessToken as string;
  tokenB = loginB.body.accessToken as string;
}, 180_000);

afterAll(async () => {
  if (server) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
  await Promise.all([control, tenantA, tenantB].filter((db): db is Database => Boolean(db)).map(async (db) => {
    await db.client.$disconnect();
    await db.pool.end();
  }));
  await routingPrisma?.onModuleDestroy();
  if (adminPool) {
    for (const name of DB_NAMES) await adminPool.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await adminPool.end();
  }
});

describe('isolated tenant database routing', () => {
  it('routes tenant data, denies cross-tenant ids, and keeps other tenants available during maintenance', async () => {
    const authA = { Authorization: `Bearer ${tokenA}` };
    const authB = { Authorization: `Bearer ${tokenB}` };
    const party = await request(BASE).post('/api/v1/parties').set(authA).send({ code: `A${RUN}`, nameAr: 'عميل أ', partyType: 'CUSTOMER' });
    expect(party.status).toBe(201);
    partyA = party.body.id as string;
    const unit = await tenantA!.client.unit.findFirstOrThrow({ select: { id: true } });
    const item = await request(BASE).post('/api/v1/items').set(authA).send({ code: `A${RUN}`, nameAr: 'صنف أ', baseUnitId: unit.id.toString() });
    expect(item.status).toBe(201);
    itemA = item.body.id as string;

    expect(await tenantA!.client.party.count()).toBe(1);
    expect(await tenantA!.client.item.count()).toBe(1);
    expect(await tenantB!.client.party.count()).toBe(0);
    expect(await tenantB!.client.item.count()).toBe(0);
    expect(await control!.client.party.count()).toBe(0);
    expect(await control!.client.item.count()).toBe(0);
    expect((await request(BASE).get(`/api/v1/parties/${partyA}`).set(authB)).status).toBe(404);
    expect((await request(BASE).get(`/api/v1/items/${itemA}`).set(authB)).status).toBe(404);

    const userId = BigInt(userBId);
    const tenantId = BigInt(idA);
    const ownerRole = await tenantA!.client.role.findUniqueOrThrow({ where: { code: 'OWNER' }, select: { id: true } });
    await tenantA!.client.user.create({
      data: { id: userId, email: emailB, fullName: `Tenant B ${RUN}`, passwordHash: '!' },
    });
    await tenantA!.client.tenantMembership.create({
      data: { tenantId, userId, roleId: ownerRole.id, status: 'ACTIVE' },
    });
    await control!.client.userTenant.create({ data: { tenantId, userId } });

    await control!.client.tenantDatabase.update({ where: { tenantId: BigInt(idA) }, data: { state: 'MIGRATING' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const loginBWithAUnavailable = await request(BASE)
      .post('/api/v1/auth/login')
      .send({ email: emailB, password: PASSWORD, tenantId: idB });
    expect(loginBWithAUnavailable.status).toBe(200);
    expect(loginBWithAUnavailable.body.tenants.map((tenant: { tenantId: string }) => tenant.tenantId)).toEqual([idB]);
    const loginWithoutTenant = await request(BASE)
      .post('/api/v1/auth/login')
      .send({ email: emailB, password: PASSWORD });
    expect(loginWithoutTenant.status).toBe(200);
    expect(loginWithoutTenant.body.tenants.map((tenant: { tenantId: string }) => tenant.tenantId)).toEqual([idB]);
    const listedTenants = await request(BASE).get('/api/v1/me/tenants').set({
      Authorization: `Bearer ${loginBWithAUnavailable.body.accessToken as string}`,
    });
    expect(listedTenants.body.map((tenant: { tenantId: string }) => tenant.tenantId)).toEqual([idB]);
    const switchToA = await request(BASE)
      .post('/api/v1/me/switch-tenant')
      .set({ Authorization: `Bearer ${loginBWithAUnavailable.body.accessToken as string}` })
      .send({ tenantId: idA });
    expect([switchToA.status, switchToA.body.error.code]).toEqual([503, 'TENANT_MAINTENANCE']);
    const loginAUnavailable = await request(BASE)
      .post('/api/v1/auth/login')
      .send({ email: emailB, password: PASSWORD, tenantId: idA });
    expect([loginAUnavailable.status, loginAUnavailable.body.error.code]).toEqual([503, 'TENANT_MAINTENANCE']);

    const maintenance = await request(BASE).get('/api/v1/items').set(authA);
    expect(maintenance.status).toBe(503);
    expect(maintenance.body.error.code).toBe('TENANT_MAINTENANCE');
    expect((await request(BASE).get('/api/v1/me').set(authB)).status).toBe(200);
    const signup = await request(BASE).post('/api/v1/auth/register').send({
      tenantName: 'Not ready',
      ownerName: 'New owner',
      email: `isolated-${RUN}@test.dev`,
      password: PASSWORD,
    });
    expect(signup.status).toBe(409);
    expect(signup.body.error.code).toBe('TENANCY_ISOLATED_NOT_READY');
  });
});
