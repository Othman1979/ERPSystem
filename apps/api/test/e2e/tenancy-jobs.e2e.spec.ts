import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { jest } from '@jest/globals';
import mariadb, { type Pool } from 'mariadb';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { openSecret } from '../../src/common/crypto/secret-box.js';
import { expectedSchemaVersion } from '../../src/prisma/schema-version.js';

const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = randomUUID().replaceAll('-', '').slice(0, 8);
const API_PORT = 5800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${API_PORT}`;
const SECRET_KEY = Buffer.alloc(32, 79).toString('base64');
const PASSWORD = 'isolated-jobs-password-123';
const CONTROL_DB = `erp_t_test${RUN}_control`;
const TENANT_PREFIX = `erp_t_test${RUN}_`;
const adminUrl = process.env.TENANT_DB_ADMIN_URL || process.env.DATABASE_URL || '';

type TenantFixture = {
  id: bigint;
  name: string;
  userId: bigint;
  token: string;
  db: PrismaClient;
  pool: Pool;
  databaseName: string;
  dbUser: string;
  companyId: bigint;
  branchId: bigint;
};

let server: ChildProcess | undefined;
let adminPool: Pool | undefined;
let control: PrismaClient | undefined;
const tenants: TenantFixture[] = [];
const scratchDatabases = new Set<string>();
const backupFolders = new Set<string>();
const extraUsers = new Set<string>();

function connectionUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function prismaFor(url: string): { db: PrismaClient; pool: Pool } {
  const parsed = new URL(url);
  const pool = mariadb.createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectionLimit: 2,
    collation: 'UTF8MB4_UNICODE_CI',
    initSql: ['SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci'],
  });
  return { db: new PrismaClient({ adapter: new PrismaMariaDb(pool) }), pool };
}

function migrate(url: string): void {
  const env = { ...process.env, DATABASE_URL: url };
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: API_DIR, env, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: API_DIR, env, stdio: 'inherit' });
}

function jobEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: connectionUrl(adminUrl, CONTROL_DB),
    TENANCY_MODE: 'isolated',
    DB_PROVISIONER: 'create',
    TENANT_DB_ADMIN_URL: adminUrl,
    TENANT_DB_HOST: new URL(adminUrl).hostname,
    TENANT_DB_NAME_PREFIX: TENANT_PREFIX,
    TENANT_DB_SECRET_KEY: SECRET_KEY,
    TENANT_DB_STATE_TTL_MS: '1',
    NODE_ENV: 'test',
    EINVOICE_WORKER: 'off',
    ...extra,
  };
}

function job(args: string[], extra: Record<string, string> = {}): string {
  return execFileSync('node', ['dist/jobs/cli.js', ...args], {
    cwd: API_DIR,
    env: jobEnvironment(extra),
    encoding: 'utf8',
  });
}

function spawnJob(args: string[], extra: Record<string, string> = {}): ChildProcess {
  return spawn('node', ['dist/jobs/cli.js', ...args], {
    cwd: API_DIR,
    env: jobEnvironment(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForOutput(child: ChildProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for job output "${text}": ${output}`));
    }, 15_000);
    function cleanup() {
      clearTimeout(timeout);
      child.stdout?.off('data', onOutput);
      child.stderr?.off('data', onOutput);
      child.off('exit', onExit);
      child.off('error', onError);
    }
    function onOutput(chunk: Buffer | string) {
      output += chunk.toString();
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    }
    function onExit() {
      cleanup();
      reject(new Error(`Job exited before output "${text}": ${output}`));
    }
    function onError(error: Error) {
      cleanup();
      reject(error);
    }
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function jobAllowingFailure(args: string[], extra: Record<string, string> = {}): string {
  try {
    return job(args, extra);
  } catch (error) {
    const stdout = (error as { stdout?: string | Buffer }).stdout;
    return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout ?? '';
  }
}

function jobFailure(args: string[], extra: Record<string, string> = {}): string {
  try {
    job(args, extra);
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    return Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr ?? String(error);
  }
  throw new Error('Expected job to fail');
}

async function waitForHealth(): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      if ((await request(BASE).get('/api/v1/health')).status === 200) return;
    } catch {
      // The API is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Isolated jobs API did not become healthy');
}

async function startApi(provisioner: 'create' | 'pool'): Promise<void> {
  const admin = new URL(adminUrl);
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: connectionUrl(adminUrl, CONTROL_DB),
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
  server.stderr?.on('data', (data) => process.stderr.write(`[tenancy-jobs-api] ${data}`));
  await waitForHealth();
}

async function stopApi(): Promise<void> {
  if (!server) return;
  server.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  server = undefined;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for tenancy-jobs e2e');
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
  migrate(controlUrl);
  control = prismaFor(controlUrl).db;
  await startApi('create');

  for (const label of ['A', 'B']) {
    const name = `Jobs ${label} ${RUN}`;
    const email = `jobs-${label.toLowerCase()}-${RUN}@test.dev`;
    const registered = await request(BASE).post('/api/v1/auth/register').send({
      tenantName: name,
      ownerName: `Owner ${label}`,
      email,
      password: PASSWORD,
    });
    expect(registered.status).toBe(201);
    const user = await control.user.findUniqueOrThrow({ where: { email } });
    const tenantId = BigInt((await control.userTenant.findFirstOrThrow({ where: { userId: user.id } })).tenantId);
    const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const row = await control.tenantDatabase.findUniqueOrThrow({ where: { tenantId } });
    const url = new URL(connectionUrl(adminUrl, row.databaseName));
    url.hostname = row.host;
    url.port = String(row.port);
    url.username = row.dbUser;
    url.password = openSecret(row.passwordSealed, SECRET_KEY);
    const client = prismaFor(url.toString());
    const company = await client.db.company.findFirstOrThrow({ where: { tenantId } });
    const branch = await client.db.branch.findFirstOrThrow({ where: { tenantId, companyId: company.id } });
    tenants.push({
      id: tenantId,
      name: tenant.name,
      userId: user.id,
      token: registered.body.accessToken as string,
      db: client.db,
      pool: client.pool,
      databaseName: row.databaseName,
      dbUser: row.dbUser,
      companyId: company.id,
      branchId: branch.id,
    });
  }
}, 240_000);

afterAll(async () => {
  await stopApi();
  const rows = control
    ? await control.tenantDatabase.findMany({
        where: { databaseName: { startsWith: TENANT_PREFIX } },
        select: { databaseName: true, dbUser: true },
      }).catch(() => [])
    : [];
  const users = new Set(rows.map((row) => row.dbUser));
  for (const user of extraUsers) users.add(user);
  for (const tenant of tenants) {
    users.add(tenant.dbUser);
    await tenant.db.$disconnect();
    await tenant.pool.end();
  }
  await control?.$disconnect();
  if (adminPool) {
    for (const row of rows) await adminPool.query(`DROP DATABASE IF EXISTS \`${row.databaseName}\``);
    for (const tenant of tenants) await adminPool.query(`DROP DATABASE IF EXISTS \`${tenant.databaseName}\``);
    for (const database of scratchDatabases) await adminPool.query(`DROP DATABASE IF EXISTS \`${database}\``);
    for (const user of users) await adminPool.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await adminPool.query(`DROP DATABASE IF EXISTS \`${CONTROL_DB}\``);
    await adminPool.end();
  }
  await Promise.all([...backupFolders].map((folder) => rm(folder, { recursive: true, force: true })));
});

describe('isolated tenant jobs', () => {
  it('fans stock verification out to both tenants and reports a maintenance tenant as unavailable', async () => {
    expect(job(['db-pool-status'])).toContain('free');
    const healthy = JSON.parse(job(['stock-verify'])) as { ok: boolean; tenants: number };
    expect(healthy).toMatchObject({ ok: true, tenants: 2 });

    const unavailable = tenants[0]!;
    await control!.tenantDatabase.update({ where: { tenantId: unavailable.id }, data: { state: 'MIGRATING' } });
    const output = jobAllowingFailure(['stock-verify']);
    const result = JSON.parse(output) as { ok: boolean; unavailable: string[]; tenants: number };
    expect(result.ok).toBe(false);
    expect(result.unavailable).toContain(unavailable.id.toString());
    expect(result.tenants).toBe(2);
    await control!.tenantDatabase.update({ where: { tenantId: unavailable.id }, data: { state: 'ACTIVE' } });
  }, 60_000);

  it('expires document locks in both tenant databases', async () => {
    const ids: bigint[] = [];
    for (const tenant of tenants) {
      const lock = await tenant.db.documentEditLock.create({
        data: {
          tenantId: tenant.id,
          companyId: tenant.companyId,
          docType: 'SALES_INVOICE',
          docId: 9_000_000n + tenant.id,
          userId: tenant.userId,
          holderToken: randomUUID(),
          acquiredAt: new Date(Date.now() - 3 * 86_400_000),
          heartbeatAt: new Date(Date.now() - 3 * 86_400_000),
          expiresAt: new Date(Date.now() - 2 * 86_400_000),
        },
      });
      ids.push(lock.id);
    }
    job(['purge-expired']);
    expect(await tenants[0]!.db.documentEditLock.count({ where: { id: ids[0] } })).toBe(0);
    expect(await tenants[1]!.db.documentEditLock.count({ where: { id: ids[1] } })).toBe(0);
  }, 60_000);

  it('claims an e-invoice outbox row only from tenant B and dispatches it under tenant context', async () => {
    const tenant = tenants[1]!;
    const submission = await tenant.db.eInvoiceSubmission.create({
      data: {
        tenantId: tenant.id,
        companyId: tenant.companyId,
        branchId: tenant.branchId,
        documentType: 'SALES_INVOICE',
        documentId: 8_000_000n + tenant.id,
        documentNo: `E2E-${RUN}`,
        uuid: randomUUID(),
        icv: 1,
        environment: 'SANDBOX',
      },
    });
    const send = jest.fn(async () => undefined);
    const configKeys = [
      'DATABASE_URL',
      'TENANCY_MODE',
      'DB_PROVISIONER',
      'TENANT_DB_ADMIN_URL',
      'TENANT_DB_SECRET_KEY',
      'TENANT_DB_POOL_LOW_WATER',
      'TENANT_DB_STATE_TTL_MS',
      'EINVOICE_WORKER',
    ] as const;
    const prior = new Map(configKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      DATABASE_URL: connectionUrl(adminUrl, CONTROL_DB),
      TENANCY_MODE: 'isolated',
      DB_PROVISIONER: 'create',
      TENANT_DB_ADMIN_URL: adminUrl,
      TENANT_DB_SECRET_KEY: SECRET_KEY,
      TENANT_DB_POOL_LOW_WATER: '0',
      TENANT_DB_STATE_TTL_MS: '1',
      EINVOICE_WORKER: 'off',
    });
    const [{ EInvoiceJobsModule }, { EInvoiceWorker }, { EInvoiceSenderService }] = await Promise.all([
      import('../../src/jobs/einvoice-jobs.module.js'),
      import('../../src/platform/einvoice/einvoice-worker.service.js'),
      import('../../src/platform/einvoice/einvoice-sender.service.js'),
    ]);
    const module = await Test.createTestingModule({ imports: [EInvoiceJobsModule] })
      .overrideProvider(EInvoiceSenderService)
      .useValue({ send })
      .compile();
    try {
      expect(await module.get(EInvoiceWorker).tick()).toBe(1);
      expect(send).toHaveBeenCalledWith(submission.id, expect.any(String));
      expect(await tenants[0]!.db.eInvoiceSubmission.count()).toBe(0);
      expect((await tenant.db.eInvoiceSubmission.findUniqueOrThrow({ where: { id: submission.id } })).status).toBe('SENDING');
    } finally {
      await module.close();
      await tenant.db.eInvoiceSubmission.delete({ where: { id: submission.id } });
      for (const key of configKeys) {
        const value = prior.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  it('reads admin counts from tenant databases and syncs an expired trial status', async () => {
    const adminEmail = `jobs-a-${RUN}@test.dev`;
    await control!.user.update({ where: { id: tenants[0]!.userId }, data: { isPlatformAdmin: true } });
    const login = await request(BASE).post('/api/v1/auth/login').send({
      email: adminEmail,
      password: PASSWORD,
      tenantId: tenants[0]!.id.toString(),
    });
    expect({ status: login.status, body: login.body }).toMatchObject({ status: 200 });
    const listing = await request(BASE)
      .get(`/api/v1/admin/tenants?q=${encodeURIComponent(tenants[0]!.name)}`)
      .set({ Authorization: `Bearer ${login.body.accessToken as string}` });
    expect(listing.status).toBe(200);
    expect(listing.body.items[0]).toMatchObject({ members: 1, branches: 1 });
    expect(listing.body.items[0].databaseState).toBe('ACTIVE');

    const target = tenants[1]!;
    await control!.tenant.update({ where: { id: target.id }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
    job(['tenant-status']);
    expect((await control!.tenant.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('SUSPENDED');
    expect((await target.db.tenant.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('SUSPENDED');
  }, 60_000);

  it('backs up and verifies both tenant databases, then restores only the selected tenant', async () => {
    const backupDir = await mkdtemp(path.join(os.tmpdir(), `erp-backup-${RUN}-`));
    backupFolders.add(backupDir);
    const scratch = `${TENANT_PREFIX}verify`;
    scratchDatabases.add(scratch);
    await adminPool!.query(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const verifyUrl = connectionUrl(adminUrl, scratch);

    const beforeA = (await tenants[0]!.db.company.findUniqueOrThrow({ where: { id: tenants[0]!.companyId } })).legalNameAr;
    const beforeB = (await tenants[1]!.db.company.findUniqueOrThrow({ where: { id: tenants[1]!.companyId } })).legalNameAr;
    const backup = JSON.parse(job(['backup'], { BACKUP_DIR: backupDir })) as {
      folder: string;
      files: Array<{ name: string }>;
    };
    expect(backup.files.some((file) => /database\.sql\.gz/.test(file.name))).toBe(true);
    expect(backup.files.some((file) => file.name.includes('tenant-'))).toBe(true);
    const verified = JSON.parse(
      job(['backup-verify', backup.folder], { BACKUP_DIR: backupDir, BACKUP_VERIFY_DATABASE_URL: verifyUrl }),
    ) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(verified.ok).toBe(true);
    expect(verified.checks.every((check) => check.ok)).toBe(true);

    job(['db-pool-fill', '--count', '1'], { TENANT_DB_POOL_TARGET: '1' });
    const freePoolDatabase = await control!.tenantDbPool.findFirstOrThrow({ where: { claimedByTenantId: null } });
    scratchDatabases.add(freePoolDatabase.databaseName);
    extraUsers.add(freePoolDatabase.dbUser);
    for (const databaseName of [tenants[0]!.databaseName, freePoolDatabase.databaseName]) {
      const protectedTarget = JSON.parse(
        jobAllowingFailure(['backup-verify', backup.folder], {
          BACKUP_DIR: backupDir,
          BACKUP_VERIFY_DATABASE_URL: connectionUrl(adminUrl, databaseName),
        }),
      ) as { ok: boolean; checks: Array<{ name: string; detail: string }> };
      expect(protectedTarget.ok).toBe(false);
      expect(protectedTarget.checks.find((check) => check.name === 'restore')?.detail).toContain(
        'tenant or pool database',
      );
    }

    const unavailable = tenants[1]!;
    await control!.tenantDatabase.update({ where: { tenantId: unavailable.id }, data: { state: 'RETIRED' } });
    const refused = jobFailure(
      ['backup-restore-tenant', backup.folder, unavailable.id.toString(), '--confirm', unavailable.name],
      { BACKUP_DIR: backupDir },
    );
    expect(refused).toContain('Tenant database state RETIRED is not restorable');
    expect((await control!.tenantDatabase.findUniqueOrThrow({ where: { tenantId: unavailable.id } })).state).toBe(
      'RETIRED',
    );
    await control!.tenantDatabase.update({ where: { tenantId: unavailable.id }, data: { state: 'ACTIVE' } });

    await tenants[0]!.db.company.update({
      where: { id: tenants[0]!.companyId },
      data: { legalNameAr: `Changed ${RUN}` },
    });
    await tenants[1]!.db.company.update({
      where: { id: tenants[1]!.companyId },
      data: { legalNameAr: `Still B ${RUN}` },
    });
    const interruptedRestore = spawnJob(
      ['backup-restore-tenant', backup.folder, tenants[0]!.id.toString(), '--confirm', tenants[0]!.name],
      { BACKUP_DIR: backupDir, TENANT_DB_STATE_TTL_MS: '60000' },
    );
    let interruptedOutput = '';
    interruptedRestore.stdout?.on('data', (chunk) => (interruptedOutput += chunk.toString()));
    interruptedRestore.stderr?.on('data', (chunk) => (interruptedOutput += chunk.toString()));
    try {
      await waitForOutput(interruptedRestore, 'Waiting ');
      const interruptedExit = once(interruptedRestore, 'exit');
      expect(interruptedRestore.kill('SIGTERM')).toBe(true);
      const [exitCode, exitSignal] = (await interruptedExit) as [number | null, NodeJS.Signals | null];
      expect(exitCode).not.toBe(0);
      expect(exitSignal).toBeNull();
      expect(interruptedOutput).toContain('SIGTERM');
      expect((await control!.tenantDatabase.findUniqueOrThrow({ where: { tenantId: tenants[0]!.id } })).state).toBe(
        'ACTIVE',
      );
      expect(
        (await tenants[0]!.db.company.findUniqueOrThrow({ where: { id: tenants[0]!.companyId } })).legalNameAr,
      ).toBe(`Changed ${RUN}`);
    } finally {
      if (interruptedRestore.exitCode === null && interruptedRestore.signalCode === null) {
        interruptedRestore.kill('SIGKILL');
        await once(interruptedRestore, 'exit').catch(() => undefined);
      }
    }
    const restoreLockName = `erp_tenant_restore_${tenants[0]!.id}`;
    const heldLockConnection = await adminPool!.getConnection();
    let restoreLockHeld = false;
    try {
      const lockRows = (await heldLockConnection.query('SELECT GET_LOCK(?, 0) AS acquired', [
        restoreLockName,
      ])) as { acquired: number | string | null }[];
      restoreLockHeld = Number(lockRows[0]?.acquired) === 1;
      expect(restoreLockHeld).toBe(true);
      const refused = jobFailure(
        ['backup-restore-tenant', backup.folder, tenants[0]!.id.toString(), '--confirm', tenants[0]!.name],
        { BACKUP_DIR: backupDir },
      );
      expect(refused).toContain('another restore of this tenant is running');
      expect((await control!.tenantDatabase.findUniqueOrThrow({ where: { tenantId: tenants[0]!.id } })).state).toBe(
        'ACTIVE',
      );
    } finally {
      try {
        if (restoreLockHeld) {
          await heldLockConnection.query('SELECT RELEASE_LOCK(?)', [restoreLockName]);
        }
      } finally {
        heldLockConnection.release();
      }
    }
    const controlUrl = new URL(connectionUrl(adminUrl, CONTROL_DB));
    const auditConnection = await mariadb.createConnection({
      host: controlUrl.hostname,
      port: controlUrl.port ? Number(controlUrl.port) : 3306,
      user: decodeURIComponent(controlUrl.username),
      password: decodeURIComponent(controlUrl.password),
      database: CONTROL_DB,
    });
    const trigger = `fail_restore_audit_${RUN}`;
    try {
      await auditConnection.query(
        `CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced restore audit failure'`,
      );
      const restore = job(
        ['backup-restore-tenant', backup.folder, tenants[0]!.id.toString(), '--confirm', tenants[0]!.name],
        { BACKUP_DIR: backupDir },
      );
      expect(JSON.parse(restore)).toMatchObject({ tenantId: tenants[0]!.id.toString() });
      expect((await control!.tenantDatabase.findUniqueOrThrow({ where: { tenantId: tenants[0]!.id } })).state).toBe(
        'ACTIVE',
      );
    } finally {
      try {
        await auditConnection.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
      } finally {
        await auditConnection.end();
      }
    }
    expect((await tenants[0]!.db.company.findUniqueOrThrow({ where: { id: tenants[0]!.companyId } })).legalNameAr).toBe(beforeA);
    expect((await tenants[1]!.db.company.findUniqueOrThrow({ where: { id: tenants[1]!.companyId } })).legalNameAr).toBe(
      `Still B ${RUN}`,
    );
    expect(beforeB).not.toBe(`Still B ${RUN}`);
  }, 180_000);

  it('resumes create-mode purge for a tenant claimed from a filled pool and deletes its pool row', async () => {
    job(['db-pool-fill', '--count', '1'], { TENANT_DB_POOL_TARGET: '1' });
    const poolDatabase = await control!.tenantDbPool.findFirstOrThrow({
      where: { claimedByTenantId: null, databaseName: { startsWith: TENANT_PREFIX } },
    });
    const email = `jobs-create-pool-${RUN}@test.dev`;
    const registered = await request(BASE).post('/api/v1/auth/register').send({
      tenantName: `Jobs Create Pool ${RUN}`,
      ownerName: 'Create Pool Owner',
      email,
      password: PASSWORD,
    });
    expect(registered.status).toBe(201);
    const user = await control!.user.findUniqueOrThrow({ where: { email } });
    const tenantId = (await control!.userTenant.findFirstOrThrow({ where: { userId: user.id } })).tenantId;
    const tenant = await control!.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const database = await control!.tenantDatabase.findUniqueOrThrow({ where: { tenantId } });
    expect(database.databaseName).toBe(poolDatabase.databaseName);
    const url = new URL(connectionUrl(adminUrl, database.databaseName));
    url.hostname = database.host;
    url.port = String(database.port);
    url.username = database.dbUser;
    url.password = openSecret(database.passwordSealed, SECRET_KEY);
    const client = prismaFor(url.toString());
    const company = await client.db.company.findFirstOrThrow({ where: { tenantId } });
    const branch = await client.db.branch.findFirstOrThrow({ where: { tenantId, companyId: company.id } });
    const target: TenantFixture = {
      id: tenantId,
      name: tenant.name,
      userId: user.id,
      token: registered.body.accessToken as string,
      db: client.db,
      pool: client.pool,
      databaseName: database.databaseName,
      dbUser: database.dbUser,
      companyId: company.id,
      branchId: branch.id,
    };
    tenants.push(target);
    await control!.tenant.update({
      where: { id: target.id },
      data: { status: 'CANCELLED', statusChangedAt: new Date(Date.now() - 91 * 86_400_000) },
    });
    await control!.tenantDatabase.update({ where: { tenantId: target.id }, data: { state: 'RETIRED' } });
    job(['purge-tenant', target.id.toString(), '--confirm', target.name]);
    expect(await control!.tenant.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await control!.tenantDatabase.findUnique({ where: { tenantId: target.id } })).toBeNull();
    expect(await control!.userTenant.findFirst({ where: { tenantId: target.id } })).toBeNull();
    expect(await control!.tenantDbPool.findFirst({ where: { databaseName: target.databaseName } })).toBeNull();
    const [{ count }] = (await adminPool!.query(
      'SELECT COUNT(*) AS count FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [target.databaseName],
    )) as { count: bigint }[];
    expect(Number(count)).toBe(0);
  }, 120_000);

  it('returns a pool-provisioned database to the migrated free pool on purge', async () => {
    const databaseName = `${TENANT_PREFIX}pool`;
    const dbUser = `pool_${RUN}`;
    const password = `poolPass${RUN}`;
    scratchDatabases.add(databaseName);
    extraUsers.add(dbUser);
    await adminPool!.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await adminPool!.query(`CREATE USER '${dbUser}'@'%' IDENTIFIED BY '${password}'`);
    await adminPool!.query(`GRANT ALL ON \`${databaseName}\`.* TO '${dbUser}'@'%'`);
    job(['db-pool-add', databaseName, dbUser], {
      DB_PROVISIONER: 'pool',
      TENANT_DB_PASSWORD: password,
    });

    await stopApi();
    await startApi('pool');
    const email = `jobs-pool-${RUN}@test.dev`;
    const registered = await request(BASE).post('/api/v1/auth/register').send({
      tenantName: `Jobs Pool ${RUN}`,
      ownerName: 'Pool Owner',
      email,
      password: PASSWORD,
    });
    expect(registered.status).toBe(201);
    const user = await control!.user.findUniqueOrThrow({ where: { email } });
    const tenantId = (await control!.userTenant.findFirstOrThrow({ where: { userId: user.id } })).tenantId;
    const tenant = await control!.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const client = prismaFor(connectionUrl(adminUrl, databaseName));
    const company = await client.db.company.findFirstOrThrow({ where: { tenantId } });
    const branch = await client.db.branch.findFirstOrThrow({ where: { tenantId, companyId: company.id } });
    tenants.push({
      id: tenantId,
      name: tenant.name,
      userId: user.id,
      token: registered.body.accessToken as string,
      db: client.db,
      pool: client.pool,
      databaseName,
      dbUser,
      companyId: company.id,
      branchId: branch.id,
    });

    await control!.tenant.update({
      where: { id: tenantId },
      data: { status: 'CANCELLED', statusChangedAt: new Date(Date.now() - 91 * 86_400_000) },
    });
    await control!.tenantDatabase.update({ where: { tenantId }, data: { state: 'RETIRED' } });
    job(['purge-tenant', tenantId.toString(), '--confirm', tenant.name], { DB_PROVISIONER: 'pool' });

    expect(await control!.tenant.findUnique({ where: { id: tenantId } })).toBeNull();
    expect(await control!.tenantDatabase.findUnique({ where: { tenantId } })).toBeNull();
    const poolRow = await control!.tenantDbPool.findFirstOrThrow({ where: { databaseName } });
    expect(poolRow.claimedByTenantId).toBeNull();
    expect(poolRow.claimedAt).toBeNull();
    expect(poolRow.schemaVersion).toBe(expectedSchemaVersion());
    const [{ count }] = (await adminPool!.query(
      'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
      [databaseName, 'BASE TABLE'],
    )) as { count: bigint }[];
    expect(Number(count)).toBeGreaterThan(0);
  }, 180_000);
});
