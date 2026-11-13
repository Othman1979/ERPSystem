import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../common/config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Status = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';

export interface StatusChange {
  tenantId: string;
  name: string;
  from: Status;
  to: Status;
  reason: string;
}

export interface TenantStatusRun {
  today: string;
  changed: StatusChange[];
  /** Subscriptions whose period ended, marked EXPIRED. */
  expiredSubscriptions: number;
  /** CANCELLED tenants past the retention period: listed, never deleted here. */
  dueForDeletion: { tenantId: string; name: string; cancelledAt: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The plan registration puts a new tenant on (prisma/seed.ts). */
const TRIAL_PLAN = 'TRIAL';

/** A date as yyyy-mm-dd in Amman (business dates of the platform). */
export function ammanDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(d);
}

/** yyyy-mm-dd of a DATE column (stored as UTC midnight). */
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

const addDays = (day: string, days: number) =>
  dateOnly(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS));

/**
 * Daily subscription lifecycle (BUILD_PLAN §13.2, ADR-009), run by Cron via
 * `pnpm --filter api job:tenant-status`:
 *  - TRIAL whose trial ended → SUSPENDED (read only);
 *  - ACTIVE whose last paid period ended → PAST_DUE (that period → EXPIRED);
 *  - PAST_DUE past the grace days after its period → SUSPENDED;
 *  - CANCELLED past the retention days → listed for deletion (manual).
 * Only moves forward, so a second run the same day changes nothing.
 *
 * systemPrisma: a platform job across all tenants (allowed in `jobs`).
 */
@Injectable()
export class TenantStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async run(now = new Date()): Promise<TenantStatusRun> {
    const db = this.prisma.client;
    const today = ammanDay(now);
    const grace = this.config.get('GRACE_DAYS', { infer: true });
    const retention = this.config.get('RETENTION_DAYS', { infer: true });
    const changed: StatusChange[] = [];

    const move = async (t: { id: bigint; name: string; status: Status }, to: Status, reason: string) => {
      // Interactive: the status is changed only if it is still the one read above.
      // An admin who changed it meanwhile wins: no change, no audit row, not reported.
      const moved = await db.$transaction(async (tx) => {
        const { count } = await tx.tenant.updateMany({
          where: { id: t.id, status: t.status },
          data: { status: to, statusChangedAt: now },
        });
        if (count === 0) return false;
        await tx.auditLog.create({
          data: {
            tenantId: t.id,
            userId: null,
            action: 'job.tenant_status',
            entityType: 'tenant',
            entityId: t.id.toString(),
            beforeJson: { status: t.status },
            afterJson: { status: to, reason },
          },
        });
        return true;
      });
      if (moved) changed.push({ tenantId: t.id.toString(), name: t.name, from: t.status, to, reason });
    };

    // Trials that ended: no paid subscription yet (one would have made them ACTIVE).
    const trials = await db.tenant.findMany({
      where: { status: 'TRIAL', trialEndsAt: { lt: now } },
      select: { id: true, name: true, status: true, trialEndsAt: true },
    });
    for (const t of trials) await move(t, 'SUSPENDED', `trial ended ${t.trialEndsAt!.toISOString()}`);

    // Paid tenants: the latest PAID period decides. Registration also writes
    // a period on the TRIAL plan; the trial itself is tenant.trialEndsAt.
    const paid = await db.tenant.findMany({
      where: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
      select: {
        id: true,
        name: true,
        status: true,
        statusChangedAt: true,
        subscriptions: {
          where: { plan: { code: { not: TRIAL_PLAN } } },
          orderBy: { periodEnd: 'desc' },
          take: 1,
          select: { periodEnd: true },
        },
      },
    });
    for (const t of paid) {
      const last = t.subscriptions[0];
      // Set by hand without a subscription: grace counts from the status change.
      const end = last ? dateOnly(last.periodEnd) : null;
      if (t.status === 'ACTIVE' && end !== null && end < today) {
        await move(t, 'PAST_DUE', `period ended ${end}`);
      } else if (t.status === 'PAST_DUE') {
        const from = end ?? (t.statusChangedAt ? ammanDay(t.statusChangedAt) : today);
        if (addDays(from, grace) < today) await move(t, 'SUSPENDED', `grace of ${grace} days after ${from} ended`);
      }
    }

    // Every period that ended (trial ones included) is EXPIRED.
    const expired = await db.subscription.updateMany({
      where: { status: 'ACTIVE', periodEnd: { lt: new Date(`${today}T00:00:00Z`) } },
      data: { status: 'EXPIRED' },
    });
    const expiredSubscriptions = expired.count;

    // Cancelled past retention: reported for a manual, confirmed deletion.
    const cutoff = new Date(now.getTime() - retention * DAY_MS);
    const cancelled = await db.tenant.findMany({
      where: { status: 'CANCELLED', statusChangedAt: { lt: cutoff } },
      select: { id: true, name: true, statusChangedAt: true },
      orderBy: { id: 'asc' },
    });

    return {
      today,
      changed,
      expiredSubscriptions,
      dueForDeletion: cancelled.map((t) => ({
        tenantId: t.id.toString(),
        name: t.name,
        cancelledAt: t.statusChangedAt!.toISOString(),
      })),
    };
  }
}
