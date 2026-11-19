import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../common/cls/cls.types.js';
import type { Env } from '../common/config/env.validation.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import { testDatabaseUrl } from '../../test/e2e/support/test-db.js';
import { PrismaService } from './prisma.service.js';

const RUN = `${process.pid}-${Date.now()}`;
const cls = ClsServiceManager.getClsService<RequestContext>();

let prisma: PrismaService | undefined;
let tenantId: bigint | undefined;

async function addReservation(key: string): Promise<bigint> {
  const row = await cls.run(async () => {
    cls.set('tenantId', tenantId!);
    return prisma!.client.idempotencyKey.create({
      data: {
        tenantId: tenantId!,
        key,
        endpoint: 'transaction-marker-test',
        requestHash: '0'.repeat(64),
        status: 'RESERVED',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });
  return row.id;
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
    const reservationId = await addReservation(key);

    await cls.run(async () => {
      cls.set('tenantId', tenantId!);
      cls.set('idempotencyKeyId', reservationId);
      await prisma!.forTenant().$transaction(async () => undefined);
    });

    expect(await statusOf(key)).toBe('COMMITTED');
  });

  it('leaves the reservation reserved when the tenant transaction rolls back', async () => {
    const key = `tx-rollback-${RUN}`;
    const reservationId = await addReservation(key);

    await expect(
      cls.run(async () => {
        cls.set('tenantId', tenantId!);
        cls.set('idempotencyKeyId', reservationId);
        await prisma!.forTenant().$transaction(async () => {
          throw new Error('rollback marker transaction');
        });
      }),
    ).rejects.toThrow('rollback marker transaction');

    expect(await statusOf(key)).toBe('RESERVED');
  });

  it('does not change a reservation when the active CLS context has no key', async () => {
    const key = `tx-no-key-${RUN}`;
    await addReservation(key);

    await cls.run(async () => {
      cls.set('tenantId', tenantId!);
      await prisma!.forTenant().$transaction(async () => undefined);
    });

    expect(await statusOf(key)).toBe('RESERVED');
  });

  it('rolls back transaction writes when the reservation row was taken over', async () => {
    const key = `tx-taken-over-${RUN}`;
    const reservationId = await addReservation(key);
    const entityId = `reservation-${RUN}`;

    await expect(
      cls.run(async () => {
        cls.set('tenantId', tenantId!);
        cls.set('idempotencyKeyId', reservationId);
        await prisma!.forTenant().$transaction(async (tx) => {
          await tx.auditLog.create({
            data: {
              tenantId: tenantId!,
              action: 'idempotency_marker_test',
              entityType: 'reservation',
              entityId,
            },
          });
          await prisma!.client.idempotencyKey.delete({ where: { id: reservationId } });
        });
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

    expect(await statusOf(key)).toBeNull();
    expect(
      await prisma!.client.auditLog.count({
        where: { tenantId: tenantId!, action: 'idempotency_marker_test', entityId },
      }),
    ).toBe(0);
  });

  it('allows sequential transactions owned by the same reservation', async () => {
    const key = `tx-sequential-${RUN}`;
    const reservationId = await addReservation(key);

    await cls.run(async () => {
      cls.set('tenantId', tenantId!);
      cls.set('idempotencyKeyId', reservationId);
      const db = prisma!.forTenant();
      await db.$transaction(async () => undefined);
      await db.$transaction(async () => undefined);
    });

    expect(await statusOf(key)).toBe('COMMITTED');
  });
});
