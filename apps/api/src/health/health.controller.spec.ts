import { DomainError } from '../common/errors/domain.error.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';

/** A client whose probe transaction always fails, counting how often it runs. */
function countingPrisma(): { prisma: PrismaService; calls: () => number } {
  let calls = 0;
  const client = {
    $transaction: async () => {
      calls += 1;
      throw new Error('write failed');
    },
  };
  return { prisma: { client } as unknown as PrismaService, calls: () => calls };
}

describe('HealthController probe cache', () => {
  it('reuses a probe result for a few seconds: two calls, one database probe', async () => {
    const { prisma, calls } = countingPrisma();
    const health = new HealthController(prisma);
    await expect(health.health()).rejects.toBeInstanceOf(DomainError);
    await expect(health.health()).rejects.toBeInstanceOf(DomainError);
    expect(calls()).toBe(1);
  });

  it('concurrent calls share one probe', async () => {
    const { prisma, calls } = countingPrisma();
    const health = new HealthController(prisma);
    await Promise.allSettled([health.health(), health.health(), health.health()]);
    expect(calls()).toBe(1);
  });

  it('liveness never touches the database', () => {
    const { prisma, calls } = countingPrisma();
    expect(new HealthController(prisma).live().status).toBe('ok');
    expect(calls()).toBe(0);
  });
});
