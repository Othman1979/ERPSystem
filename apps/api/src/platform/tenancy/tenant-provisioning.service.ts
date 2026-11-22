import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { openSecret } from '../../common/crypto/secret-box.js';
import type { Env } from '../../common/config/env.validation.js';
import { PrismaService, CONNECT_TIMEOUT_MS, CONNECTION_COLLATION, SESSION_CHARSET_SQL, SESSION_INIT_SQL } from '../../prisma/prisma.service.js';
import { expectedSchemaVersion, isSchemaBehind } from '../../prisma/schema-version.js';
import { createTenantDbConnection } from '../../prisma/tenant-db-router.js';
import { ChartProvisioningService } from '../accounting/chart-provisioning.service.js';
import type { AuthMeta } from '../auth/auth.service.js';
import type { RegisterDto } from '../auth/dto/auth.dto.js';
import { migrateDatabase, migrationErrorMessage } from './migrate-runner.js';
import { TenantDatabaseProvisioner, type ProvisionedDatabase } from './database-provisioner.service.js';
import { TenantMirrorService } from './tenant-mirror.service.js';
import { postAlertWebhook } from '../../common/alert-webhook.js';

interface RegistrationStep {
  userId: bigint;
  email: string;
  tenantId: bigint;
  tenantName: string;
  claimedPool: boolean;
}

class PoolWasEmpty extends Error {}

@Injectable()
export class TenantProvisioningService {
  // systemPrisma: registration state and user links are control-plane records.
  private readonly logger = new Logger(TenantProvisioningService.name);
  private lastPoolExhaustedAlertAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly databases: TenantDatabaseProvisioner,
    private readonly mirrors: TenantMirrorService,
    private readonly chartProvisioning: ChartProvisioningService,
  ) {}

  async registerIsolated(
    dto: RegisterDto,
    meta: AuthMeta,
    passwordHash: string,
  ): Promise<{ userId: bigint; email: string; tenantId: bigint }> {
    let step: RegistrationStep;
    try {
      step = await this.createRegistrationStep(dto, passwordHash);
    } catch (error) {
      if (!(error instanceof PoolWasEmpty)) throw error;
      if (this.config.get('DB_PROVISIONER', { infer: true }) === 'pool') {
        await this.alertPoolExhausted();
        throw new DomainError(ErrorCode.REGISTRATION_UNAVAILABLE, 'No tenant databases are available for registration');
      }
      const database = await this.databases.createDatabase();
      try {
        step = await this.createRegistrationStep(dto, passwordHash, database);
      } catch (createError) {
        await this.databases.dropCreatedDatabase(database).catch(() => undefined);
        throw createError;
      }
    }

    if (step.claimedPool) await this.alertIfLowWater();
    try {
      await this.finishProvisioning(step.tenantId, step.userId, step.email, step.tenantName, meta);
    } catch {
      await this.prisma.control().tenantDatabase.update({
        where: { tenantId: step.tenantId },
        data: { state: 'PROVISIONING' },
      }).catch(() => undefined);
      throw new DomainError(
        ErrorCode.REGISTRATION_PENDING,
        'Your account is being prepared and will be ready within minutes',
        { tenantId: step.tenantId.toString() },
      );
    }
    return { userId: step.userId, email: step.email, tenantId: step.tenantId };
  }

  async resume(tenantId: bigint): Promise<void> {
    const control = this.prisma.control();
    const database = await control.tenantDatabase.findUnique({ where: { tenantId } });
    if (!database || database.state !== 'PROVISIONING') return;
    const ownerLink = await control.userTenant.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: { userId: true },
    });
    if (!ownerLink) throw new Error(`Provisioning tenant ${tenantId} has no owner link`);
    const [tenant, user] = await Promise.all([
      control.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      control.user.findUnique({ where: { id: ownerLink.userId }, select: { email: true } }),
    ]);
    if (!tenant || !user) throw new Error(`Provisioning tenant ${tenantId} has missing control data`);
    await this.finishProvisioning(tenantId, ownerLink.userId, user.email, tenant.name);
  }

  async resumePending(): Promise<{ resumed: number; failed: number; errors: string[] }> {
    const rows = await this.prisma.control().tenantDatabase.findMany({
      where: { state: 'PROVISIONING', createdAt: { lt: new Date(Date.now() - 2 * 60_000) } },
      select: { tenantId: true },
      orderBy: { createdAt: 'asc' },
    });
    let resumed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const { tenantId } of rows) {
      try {
        await this.resume(tenantId);
        resumed += 1;
      } catch (error) {
        failed += 1;
        const message = migrationErrorMessage(error);
        errors.push(`Tenant ${tenantId}: ${message}`);
        this.logger.error(`Provisioning resume failed for tenant ${tenantId}: ${message}`);
      }
    }
    return { resumed, failed, errors };
  }

  private async createRegistrationStep(
    dto: RegisterDto,
    passwordHash: string,
    fallbackDatabase?: ProvisionedDatabase,
  ): Promise<RegistrationStep> {
    const control = this.prisma.control();
    if (
      !fallbackDatabase &&
      this.config.get('DB_PROVISIONER', { infer: true }) === 'pool' &&
      !(await control.tenantDbPool.findFirst({ where: { claimedByTenantId: null }, select: { id: true } }))
    ) {
      await this.alertPoolExhausted();
      throw new DomainError(ErrorCode.REGISTRATION_UNAVAILABLE, 'No tenant databases are available for registration');
    }
    return control.$transaction(async (tx) => {
      const plan = await tx.plan.findFirst({ where: { code: 'TRIAL', isActive: true } });
      if (!plan) throw new DomainError(ErrorCode.INTERNAL, 'System is not seeded (trial plan missing)');
      if (await tx.user.findUnique({ where: { email: dto.email } })) {
        throw new DomainError(ErrorCode.CONFLICT, 'Email is already registered');
      }

      const trialEnds = new Date(Date.now() + this.config.get('TRIAL_DAYS', { infer: true }) * 24 * 60 * 60 * 1000);
      const today = new Date();
      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          fullName: dto.ownerName,
          locale: dto.locale ?? 'ar',
        },
      });
      const tenant = await tx.tenant.create({
        data: {
          name: dto.tenantName,
          status: 'TRIAL',
          statusChangedAt: today,
          planId: plan.id,
          trialEndsAt: trialEnds,
        },
      });
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          periodStart: today,
          periodEnd: trialEnds,
          status: 'ACTIVE',
          notes: 'Trial period',
        },
      });

      let database = await this.databases.claimPoolDatabase(tx, tenant.id);
      const claimedPool = database !== null;
      if (!database && fallbackDatabase) {
        database = await this.databases.recordProvisionedDatabase(tx, tenant.id, fallbackDatabase);
      }
      if (!database) {
        if (this.config.get('DB_PROVISIONER', { infer: true }) === 'create') throw new PoolWasEmpty();
        throw new PoolWasEmpty();
      }
      await tx.tenantDatabase.update({
        where: { tenantId: tenant.id },
        data: { pendingCompanyNameAr: dto.companyNameAr ?? null },
      });

      // The link records the owner so a later resume can recover the user after a process restart.
      // Membership resolution hides it while the tenant database remains PROVISIONING.
      await tx.userTenant.createMany({
        data: [{ userId: user.id, tenantId: tenant.id }],
        skipDuplicates: true,
      });

      return {
        userId: user.id,
        email: user.email,
        tenantId: tenant.id,
        tenantName: tenant.name,
        claimedPool,
      };
    });
  }

  private async finishProvisioning(
    tenantId: bigint,
    userId: bigint,
    email: string,
    tenantName: string,
    meta: AuthMeta = {},
  ): Promise<void> {
    const control = this.prisma.control();
    const database = await control.tenantDatabase.findUnique({ where: { tenantId } });
    if (!database || database.state === 'RETIRED') throw new Error(`Provisioning database for tenant ${tenantId} is unavailable`);

    let schemaVersion = database.schemaVersion;
    const url = this.databases.databaseUrl(database);
    if (isSchemaBehind(schemaVersion, expectedSchemaVersion())) {
      schemaVersion = await migrateDatabase(url);
      await control.tenantDatabase.update({ where: { tenantId }, data: { schemaVersion } });
    }

    const password = openSecret(database.passwordSealed, this.config.get('TENANT_DB_SECRET_KEY', { infer: true }));
    const connection = createTenantDbConnection(
      { host: database.host, port: database.port, databaseName: database.databaseName, dbUser: database.dbUser, password },
      {
        poolSize: this.config.get('TENANT_DB_POOL_SIZE', { infer: true }),
        acquireTimeoutMs: this.config.get('DB_POOL_ACQUIRE_TIMEOUT_MS', { infer: true }),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        collation: CONNECTION_COLLATION,
        initSql: [SESSION_CHARSET_SQL, SESSION_INIT_SQL],
      },
    );
    try {
      await connection.client.$transaction(async (tx) => {
        await this.mirrors.syncReference(tx);
        await this.mirrors.syncTenant(tx, tenantId);
        await this.mirrors.syncUser(tx, userId);
        if (await tx.company.findFirst({ where: { tenantId }, select: { id: true } })) return;
        const ownerRole = await tx.role.findUnique({ where: { code: 'OWNER' } });
        const currency = await tx.currency.findUnique({ where: { code: 'JOD' } });
        if (!ownerRole) throw new DomainError(ErrorCode.INTERNAL, 'System is not seeded (owner role missing)');
        const company = await tx.company.create({
          data: {
            tenantId,
            legalNameAr: database.pendingCompanyNameAr ?? tenantName,
            baseCurrencyId: currency?.id ?? null,
          },
        });
        const branch = await tx.branch.create({
          data: { tenantId, companyId: company.id, code: 'MAIN', nameAr: 'الفرع الرئيسي' },
        });
        await tx.tenantMembership.create({
          data: {
            tenantId,
            userId,
            roleId: ownerRole.id,
            status: 'ACTIVE',
            defaultBranchId: branch.id,
          },
        });
        await this.chartProvisioning.provision(tx, tenantId, company.id, userId);
      });
    } finally {
      await connection.client.$disconnect();
      await connection.pool.end();
    }

    try {
      await control.$transaction(async (tx) => {
        await tx.tenantDatabase.update({
          where: { tenantId },
          data: { state: 'ACTIVE', schemaVersion, pendingCompanyNameAr: null },
        });
        await tx.userTenant.createMany({
          data: [{ userId, tenantId }],
          skipDuplicates: true,
        });
      });
      await this.prisma.router.invalidate(tenantId);
      await control.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'auth.register',
          entityType: 'tenant',
          entityId: tenantId.toString(),
          afterJson: { email, tenantName },
          ip: meta.ip?.slice(0, 64) ?? null,
          userAgent: (Array.isArray(meta.userAgent) ? meta.userAgent[0] : meta.userAgent)?.slice(0, 512) ?? null,
        },
      });
    } catch (error) {
      await control.tenantDatabase.update({ where: { tenantId }, data: { state: 'PROVISIONING' } }).catch(() => undefined);
      await this.prisma.router.invalidate(tenantId).catch(() => undefined);
      throw error;
    }
  }

  private async alertIfLowWater(): Promise<void> {
    const free = await this.databases.countFreePoolRows().catch(() => Number.MAX_SAFE_INTEGER);
    const threshold = this.config.get('TENANT_DB_POOL_LOW_WATER', { infer: true });
    const url = this.config.get('ALERT_WEBHOOK_URL', { infer: true });
    if (free >= threshold || !url) return;
    try {
      await postAlertWebhook(url, `ERP Cloud: tenant database pool low (${free} free; threshold ${threshold})`);
    } catch {
      // Pool alerts are best-effort and never block registration.
    }
  }

  private async alertPoolExhausted(): Promise<void> {
    const url = this.config.get('ALERT_WEBHOOK_URL', { infer: true });
    if (!url || Date.now() - this.lastPoolExhaustedAlertAt < 15 * 60_000) return;
    this.lastPoolExhaustedAlertAt = Date.now();
    try {
      await postAlertWebhook(url, 'ERP Cloud: tenant database pool exhausted (0 free)');
    } catch {
      // Pool alerts are best-effort and never block registration.
    }
  }
}
