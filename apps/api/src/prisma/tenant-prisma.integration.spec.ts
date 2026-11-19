import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../common/cls/cls.types.js';
import type { Env } from '../common/config/env.validation.js';
import { testDatabaseUrl } from '../../test/e2e/support/test-db.js';
import { PrismaService } from './prisma.service.js';

const RUN = `${process.pid}-${Date.now()}`;
const cls = ClsServiceManager.getClsService<RequestContext>();

let prisma: PrismaService | undefined;
let tenantId: bigint | undefined;

async function addReservation(key: string): Promise<void> {
  await cls.run(async () => {
    cls.set('tenantId', tenantId!);
    await prisma!.client.idempotencyKey.create({
      data: {
        tenantId: tenantId!,
        key,
        endpoint: 'transaction-marker-test',
        requestHash: '0'.repeat(64),
        status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });
}

async function statusOf(key: string): Promise<string | null> {
  const row = await prisma!.client.idempotencyKey.findFirst({
    where: { tenantId: tenantId!, key },
    select: { status: true },
  });
  return row?.status ?? null;
}

beforeAll(async () => {
  const config = new ConfigService<Env, true>({
    DATABASE_URL: testDatabaseUrl(),
    DB_POOL_SIZE: 2,
    DB_POOL_ACQUIRE_TIMEOUT_MS: 10_000,
  });
  prisma = new PrismaService(config);
  const tenant = await prisma.client.tenant.create({
    data: { name: `Transaction marker test ${RUN}` },
    select: { id: true },
  });
  tenantId = tenant.id;
});

afterAll(async () => {
  if (!prisma) return;
  try {
    if (tenantId !== undefined) await prisma.client.tenant.delete({ where: { id: tenantId } });
  } finally {
    await prisma.onModuleDestroy();
  }
});

describe('tenant transaction idempotency marker (real MariaDB)', () => {
  it('commits the reservation marker with a successful tenant transaction', async () => {
    const key = `tx-success-${RUN}`;
    await addReservation(key);

    await cls.run(async () => {
      cls.set('tenantId', tenantId!);
      cls.set('idempotencyKey', key);
      await prisma!.forTenant().$transaction(async () => undefined);
    });

    expect(await statusOf(key)).toBe('COMMITTED');
  });

  it('leaves the reservation in progress when the tenant transaction rolls back', async () => {
    const key = `tx-rollback-${RUN}`;
    await addReservation(key);

    await expect(
      cls.run(async () => {
        cls.set('tenantId', tenantId!);
        cls.set('idempotencyKey', key);
        await prisma!.forTenant().$transaction(async () => {
          throw new Error('rollback marker transaction');
        });
      }),
    ).rejects.toThrow('rollback marker transaction');

    expect(await statusOf(key)).toBe('IN_PROGRESS');
  });

  it('does not change a reservation when the active CLS context has no key', async () => {
    const key = `tx-no-key-${RUN}`;
    await addReservation(key);

    await cls.run(async () => {
      cls.set('tenantId', tenantId!);
      await prisma!.forTenant().$transaction(async () => undefined);
    });

    expect(await statusOf(key)).toBe('IN_PROGRESS');
  });
});
