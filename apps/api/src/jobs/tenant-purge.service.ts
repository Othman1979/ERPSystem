import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../common/config/env.validation.js';
import { StorageService } from '../common/storage/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TABLE_NAME = /^[a-z0-9_]+$/;

export interface PurgePlan {
  tenantId: string;
  name: string;
  status: string;
  cancelledAt: string | null;
  /** Earliest moment the data may be deleted (cancellation + RETENTION_DAYS). */
  deletableFrom: string | null;
  eligible: boolean;
  /** Why it may not be deleted yet, when not eligible. */
  reason: string | null;
  /** Rows per tenant table (only tables with rows). */
  rows: Record<string, number>;
  /** Users who belong to this tenant only (never platform admins). */
  users: string[];
}

/**
 * Deletes a cancelled tenant's data once the retention period is over
 * (BUILD_PLAN §13.2, ADR-009 §4 / §14). Run by hand, never by Cron or HTTP:
 *   node dist/jobs/cli.js purge-tenant <id>                      plan only
 *   node dist/jobs/cli.js purge-tenant <id> --confirm "<name>"   delete
 *
 * The one deliberate exception to "posted data is never deleted": the
 * announced deletion after cancellation. Every table with a tenant_id is
 * found in the schema (so new tables are covered), all rows of the tenant
 * go in one transaction with foreign-key checks off for that connection
 * (the whole tenant goes, so nothing is left dangling; self references
 * such as reversal_of_id would otherwise need a delete order), then the
 * tenant's files. Users who belong to no other tenant go too.
 *
 * systemPrisma: a platform job across tables; every statement on a tenant
 * table filters on tenant_id.
 */
@Injectable()
export class TenantPurgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly storage: StorageService,
  ) {}

  /** Tables holding tenant rows (tenants itself excluded), from the live schema. */
  private async tenantTables(): Promise<string[]> {
    const rows = await this.prisma.client.$queryRaw<{ name: string }[]>`
      SELECT TABLE_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id' AND TABLE_NAME <> 'tenants'
       ORDER BY TABLE_NAME`;
    return rows.map((r) => r.name).filter((n) => TABLE_NAME.test(n));
  }

  async plan(tenantId: bigint, now = new Date()): Promise<PurgePlan> {
    const db = this.prisma.client;
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, status: true, statusChangedAt: true },
    });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

    const retention = this.config.get('RETENTION_DAYS', { infer: true });
    const deletableFrom = tenant.statusChangedAt ? new Date(tenant.statusChangedAt.getTime() + retention * DAY_MS) : null;
    const reason =
      tenant.status !== 'CANCELLED'
        ? `status is ${tenant.status}, not CANCELLED`
        : !deletableFrom || deletableFrom > now
          ? `retention of ${retention} days runs until ${deletableFrom?.toISOString() ?? 'unknown'}`
          : null;

    const rows: Record<string, number> = {};
    for (const table of await this.tenantTables()) {
      const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n FROM \`${table}\` WHERE tenant_id = ?`,
        tenantId,
      );
      if (Number(r.n) > 0) rows[table] = Number(r.n);
    }
    const users = await this.soleUsers(tenantId);

    return {
      tenantId: tenant.id.toString(),
      name: tenant.name,
      status: tenant.status,
      cancelledAt: tenant.status === 'CANCELLED' ? (tenant.statusChangedAt?.toISOString() ?? null) : null,
      deletableFrom: deletableFrom?.toISOString() ?? null,
      eligible: reason === null,
      reason,
      rows,
      users: users.map((u) => u.email),
    };
  }

  /** Users of this tenant with no membership elsewhere; platform admins are kept. */
  private soleUsers(tenantId: bigint) {
    return this.prisma.client.$queryRaw<{ id: bigint; email: string }[]>`
      SELECT u.id, u.email FROM users u
       WHERE u.is_platform_admin = 0
         AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = u.id AND m.tenant_id = ${tenantId})
         AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = u.id AND m.tenant_id <> ${tenantId})
       ORDER BY u.id`;
  }

  /** Deletes everything of the tenant; `confirmName` must be the tenant's exact name. */
  async run(tenantId: bigint, confirmName: string, now = new Date()): Promise<PurgePlan> {
    const plan = await this.plan(tenantId, now);
    if (!plan.eligible) throw new Error(`Refused: ${plan.reason}`);
    if (confirmName !== plan.name) throw new Error('Refused: --confirm must be the exact tenant name');

    const tables = await this.tenantTables();
    const users = await this.soleUsers(tenantId);
    await this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
        try {
          for (const table of tables) {
            await tx.$executeRawUnsafe(`DELETE FROM \`${table}\` WHERE tenant_id = ?`, tenantId);
          }
          for (const user of users) {
            // Audit rows that stay (platform rows, failed sign-ins) lose the link to the person and the address.
            await tx.$executeRaw`UPDATE audit_logs SET user_id = NULL WHERE user_id = ${user.id} AND tenant_id IS NULL`;
            await tx.$executeRaw`UPDATE audit_logs SET entity_id = NULL
              WHERE entity_type = 'user' AND entity_id = ${user.id.toString()} AND tenant_id IS NULL`;
            await tx.$executeRaw`UPDATE audit_logs SET after_json = JSON_SET(after_json, '$.email', '[deleted]')
              WHERE tenant_id IS NULL AND action IN ('auth.login_failed', 'auth.login_locked')
                AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.email'))) = LOWER(${user.email})`;
            await tx.$executeRaw`DELETE FROM refresh_tokens WHERE user_id = ${user.id}`;
            await tx.$executeRaw`DELETE FROM users WHERE id = ${user.id}`;
          }
          await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
        } finally {
          // The connection goes back to the pool: checks must be on again.
          await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        }
      },
      { timeout: 120_000 },
    );
    await this.storage.removeTenant(tenantId);
    // Kept outside the tenant (tenant_id NULL): the record that the data was deleted.
    await this.prisma.client.auditLog.create({
      data: {
        tenantId: null,
        userId: null,
        action: 'job.tenant_purge',
        entityType: 'tenant',
        entityId: tenantId.toString(),
        afterJson: { name: plan.name, cancelledAt: plan.cancelledAt, rows: plan.rows, users: plan.users.length },
      },
    });
    return plan;
  }
}
