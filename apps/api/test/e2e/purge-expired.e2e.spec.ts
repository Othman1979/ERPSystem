/**
 * DB-12 — expired idempotency keys and refresh tokens are purged (job:purge-expired):
 *  - only rows past their expiry go; fresh rows of both tenants stay;
 *  - a rotation chain of expired tokens goes (replaced_by_id is cleared first, no foreign key blocks it);
 *  - the tenants and users are untouched.
 * No HTTP server: the job runs in an application context on erp_test.
 * Its own rows only; they are removed afterwards.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { JobsModule } from '../../src/jobs/jobs.module.js';
import { PurgeExpiredService } from '../../src/jobs/purge-expired.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { testDatabaseUrl } from './support/test-db.js';

const RUN = Date.now().toString(36);
const DAY = 24 * 60 * 60 * 1000;
const HASH = '0'.repeat(64);

type App = Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;

let app: App | undefined;
const created = {
  tenantIds: [] as bigint[],
  userIds: [] as bigint[],
  tokenIds: [] as bigint[],
  keyIds: [] as bigint[],
};

describe('purge-expired (DB-12)', () => {
  beforeAll(async () => {
    // The job reads DATABASE_URL when it starts: point it at the test database first.
    process.env.DATABASE_URL = testDatabaseUrl();
    app = await NestFactory.createApplicationContext(JobsModule, { logger: false });
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    // systemPrisma: removes the rows this test created (test data only).
    const db = app.get(PrismaService).client;
    await db.refreshToken.deleteMany({ where: { id: { in: created.tokenIds } } });
    await db.idempotencyKey.deleteMany({ where: { id: { in: created.keyIds } } });
    await db.user.deleteMany({ where: { id: { in: created.userIds } } });
    await db.tenant.deleteMany({ where: { id: { in: created.tenantIds } } });
    await app.close();
  });

  it('deletes only the expired idempotency keys and refresh tokens of both tenants', async () => {
    const db = app!.get(PrismaService).client;
    const now = new Date();
    const past = new Date(now.getTime() - DAY);
    const future = new Date(now.getTime() + DAY);
    const plan = await db.plan.findUniqueOrThrow({ where: { code: 'TRIAL' } });

    const expiredKeys: bigint[] = [];
    const freshKeys: bigint[] = [];
    const expiredTokens: bigint[] = [];
    const freshTokens: bigint[] = [];

    for (const label of ['A', 'B']) {
      const tenant = await db.tenant.create({ data: { name: `PX ${label} ${RUN}`, status: 'TRIAL', planId: plan.id } });
      created.tenantIds.push(tenant.id);
      const user = await db.user.create({
        data: { email: `px-${label.toLowerCase()}-${RUN}@test.dev`, passwordHash: 'not-a-login', fullName: `PX ${label}` },
      });
      created.userIds.push(user.id);

      // Expired keys of every status, and a fresh one that must stay.
      for (const [suffix, status, expiresAt, bucket] of [
        ['old-done', 'COMPLETED', past, expiredKeys],
        ['old-running', 'IN_PROGRESS', past, expiredKeys],
        ['fresh', 'COMPLETED', future, freshKeys],
      ] as const) {
        const key = await db.idempotencyKey.create({
          data: {
            tenantId: tenant.id,
            key: `px-${RUN}-${label}-${suffix}`,
            endpoint: 'POST /api/v1/test',
            requestHash: HASH,
            status,
            expiresAt,
          },
        });
        created.keyIds.push(key.id);
        bucket.push(key.id);
      }

      // A rotation chain: fresh1 is the live token; old2 was replaced by it, old1 by old2. Both expired.
      const fresh1 = await db.refreshToken.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          tokenHash: `px-${RUN}-${label}-fresh1`,
          familyId: `px-${RUN}-${label}`,
          expiresAt: future,
        },
      });
      const old2 = await db.refreshToken.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          tokenHash: `px-${RUN}-${label}-old2`,
          familyId: `px-${RUN}-${label}`,
          expiresAt: past,
          replacedById: fresh1.id,
          revokedAt: past,
        },
      });
      const old1 = await db.refreshToken.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          tokenHash: `px-${RUN}-${label}-old1`,
          familyId: `px-${RUN}-${label}`,
          expiresAt: past,
          replacedById: old2.id,
          revokedAt: past,
        },
      });
      created.tokenIds.push(fresh1.id, old2.id, old1.id);
      expiredTokens.push(old2.id, old1.id);
      freshTokens.push(fresh1.id);
    }

    const result = await app!.get(PurgeExpiredService).run(now);
    expect(result.idempotencyKeys).toBeGreaterThanOrEqual(expiredKeys.length);
    expect(result.refreshTokens).toBeGreaterThanOrEqual(expiredTokens.length);

    const gone = async (table: 'idempotencyKey' | 'refreshToken', ids: bigint[]) =>
      table === 'idempotencyKey'
        ? db.idempotencyKey.findMany({ where: { id: { in: ids } }, select: { id: true } })
        : db.refreshToken.findMany({ where: { id: { in: ids } }, select: { id: true } });

    expect(await gone('idempotencyKey', expiredKeys)).toHaveLength(0);
    expect(await gone('refreshToken', expiredTokens)).toHaveLength(0);
    expect(await gone('idempotencyKey', freshKeys)).toHaveLength(freshKeys.length);
    expect(await gone('refreshToken', freshTokens)).toHaveLength(freshTokens.length);

    // The tenants and their users are untouched.
    expect(await db.tenant.count({ where: { id: { in: created.tenantIds } } })).toBe(2);
    expect(await db.user.count({ where: { id: { in: created.userIds } } })).toBe(2);
  });

  it('a second run leaves nothing expired behind, and the fresh rows are still there', async () => {
    await app!.get(PurgeExpiredService).run(new Date());
    const db = app!.get(PrismaService).client;
    expect(await db.refreshToken.count({ where: { id: { in: created.tokenIds }, expiresAt: { lt: new Date() } } })).toBe(0);
    expect(await db.refreshToken.count({ where: { id: { in: created.tokenIds } } })).toBe(created.tokenIds.length / 3);
  });
});
