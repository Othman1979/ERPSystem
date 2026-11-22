import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mariadb from 'mariadb';
import type { Env } from '../common/config/env.validation.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { TenantDatabaseProvisioner } from '../platform/tenancy/database-provisioner.service.js';
import { migrateDatabase } from '../platform/tenancy/migrate-runner.js';
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
 * tenant's files. Users who belong to no other tenant, and have no history
 * in another company, go too.
 *
 * Platform job: control rows are removed transactionally after tenant data
 * is dropped or reset for the configured provisioner.
 */
@Injectable()
export class TenantPurgeService {
  // systemPrisma: the purge coordinates tenant routing state with control-plane records.
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly storage: StorageService,
    private readonly databases: TenantDatabaseProvisioner,
  ) {}

  /** Tables holding tenant rows (tenants itself excluded), from the live schema. */
  private async tenantTables(db: PrismaClient = this.prisma.control()): Promise<string[]> {
    const rows = await db.$queryRaw<{ name: string }[]>`
      SELECT TABLE_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id' AND TABLE_NAME <> 'tenants'
       ORDER BY TABLE_NAME`;
    return rows.map((r) => r.name).filter((n) => TABLE_NAME.test(n));
  }

  async plan(tenantId: bigint, now = new Date()): Promise<PurgePlan> {
    let db: PrismaClient | null = this.prisma.control();
    if (this.prisma.tenancyMode === 'isolated') {
      const database = await this.prisma.control().tenantDatabase.findUnique({ where: { tenantId } });
      db = null;
      if (database?.state === 'ACTIVE') {
        try {
          await this.prisma.router.resolve(tenantId);
          db = this.prisma.forTenant(tenantId);
        } catch {
          db = null;
        }
      }
    }
    const control = this.prisma.control();
    const tenant = await control.tenant.findUnique({
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
    if (db) {
      for (const table of await this.tenantTables(db)) {
        const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT COUNT(*) AS n FROM \`${table}\` WHERE tenant_id = ?`,
          tenantId,
        );
        if (Number(r.n) > 0) rows[table] = Number(r.n);
      }
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

  /**
   * Users who belong to this tenant only; platform admins are kept. A user
   * whose history reaches another company is kept too: an audit row there
   * (a declined or accepted invitation outlives the membership) or an
   * invitation they sent into another company. Deleting them would leave
   * those rows pointing at nobody.
   */
  private soleUsers(tenantId: bigint) {
    if (this.prisma.tenancyMode === 'isolated') {
      return this.prisma.control().$queryRaw<{ id: bigint; email: string }[]>`
        SELECT u.id, u.email FROM users u
         WHERE u.is_platform_admin = 0
           AND EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.id AND ut.tenant_id = ${tenantId})
           AND NOT EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.id AND ut.tenant_id <> ${tenantId})
         ORDER BY u.id`;
    }
    return this.prisma.client.$queryRaw<{ id: bigint; email: string }[]>`
      SELECT u.id, u.email FROM users u
       WHERE u.is_platform_admin = 0
         AND EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = u.id AND m.tenant_id = ${tenantId})
         AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m.user_id = u.id AND m.tenant_id <> ${tenantId})
         AND NOT EXISTS (SELECT 1 FROM audit_logs a
                          WHERE a.user_id = u.id AND a.tenant_id IS NOT NULL AND a.tenant_id <> ${tenantId})
         AND NOT EXISTS (SELECT 1 FROM tenant_memberships m
                          WHERE m.invited_by = u.id AND m.tenant_id <> ${tenantId})
       ORDER BY u.id`;
  }

  /** Deletes everything of the tenant; `confirmName` must be the tenant's exact name. */
  async run(tenantId: bigint, confirmName: string, now = new Date()): Promise<PurgePlan> {
    const plan = await this.plan(tenantId, now);
    if (!plan.eligible) throw new Error(`Refused: ${plan.reason}`);
    if (confirmName !== plan.name) throw new Error('Refused: --confirm must be the exact tenant name');

    if (this.prisma.tenancyMode === 'isolated') return this.runIsolated(tenantId, plan);

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

  private async runIsolated(tenantId: bigint, plan: PurgePlan): Promise<PurgePlan> {
    const control = this.prisma.control();
    const database = await control.tenantDatabase.findUnique({ where: { tenantId } });
    if (!database) throw new Error(`Tenant database ${tenantId} not found`);
    await control.tenantDatabase.update({ where: { tenantId }, data: { state: 'RETIRED' } });
    await this.prisma.router.invalidate(tenantId);

    let poolSchemaVersion: string | null = null;
    if (this.config.get('DB_PROVISIONER', { infer: true }) === 'create') {
      await this.databases.dropCreatedDatabase(database.databaseName, database.dbUser);
    } else {
      const url = this.databases.databaseUrl(database);
      await dropTenantDatabaseTables(url);
      poolSchemaVersion = await migrateDatabase(url);
    }

    const users = await this.soleUsers(tenantId);
    await control.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
        try {
          if (poolSchemaVersion !== null) {
            await tx.$executeRaw`
              UPDATE tenant_db_pool SET claimed_by_tenant_id = NULL, claimed_at = NULL, schema_version = ${poolSchemaVersion}
               WHERE host = ${database.host} AND port = ${database.port} AND database_name = ${database.databaseName}`;
          } else {
            await tx.tenantDbPool.deleteMany({
              where: { host: database.host, port: database.port, databaseName: database.databaseName },
            });
          }
          await tx.tenantDatabase.deleteMany({ where: { tenantId } });
          await tx.userTenant.deleteMany({ where: { tenantId } });
          await tx.subscription.deleteMany({ where: { tenantId } });
          await tx.auditLog.deleteMany({ where: { tenantId } });
          for (const user of users) {
            await tx.$executeRaw`UPDATE audit_logs SET user_id = NULL WHERE user_id = ${user.id} AND tenant_id IS NULL`;
            await tx.$executeRaw`UPDATE audit_logs SET entity_id = NULL
              WHERE entity_type = 'user' AND entity_id = ${user.id.toString()} AND tenant_id IS NULL`;
            await tx.$executeRaw`UPDATE audit_logs SET after_json = JSON_SET(after_json, '$.email', '[deleted]')
              WHERE tenant_id IS NULL AND action IN ('auth.login_failed', 'auth.login_locked')
                AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(after_json, '$.email'))) = LOWER(${user.email})`;
            await tx.refreshToken.deleteMany({ where: { userId: user.id } });
            await tx.user.deleteMany({ where: { id: user.id } });
          }
          await tx.tenant.deleteMany({ where: { id: tenantId } });
        } finally {
          await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
        }
      },
      { timeout: 120_000 },
    );
    await this.storage.removeTenant(tenantId);
    await control.auditLog.create({
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

export function dropTableStatement(name: string, type: string): string {
  if (!TABLE_NAME.test(name)) throw new Error('Invalid table identifier');
  const quoted = `\`${name}\``;
  return type === 'VIEW' ? `DROP VIEW IF EXISTS ${quoted}` : `DROP TABLE IF EXISTS ${quoted}`;
}

export async function dropTenantDatabaseTables(url: string): Promise<void> {
  const target = new URL(url);
  const connection = await mariadb.createConnection({
    host: target.hostname,
    port: target.port ? Number(target.port) : 3306,
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database: decodeURIComponent(target.pathname.slice(1)),
  });
  try {
    const tables = (await connection.query(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    )) as { name: string; type: string }[];
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) await connection.query(dropTableStatement(table.name, table.type));
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }
}
