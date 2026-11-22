import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mariadb from 'mariadb';
import type { Env } from '../../common/config/env.validation.js';
import { sealSecret } from '../../common/crypto/secret-box.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { expectedSchemaVersion } from '../../prisma/schema-version.js';
import { migrateDatabase } from './migrate-runner.js';
import { TenantDatabaseProvisioner, type ProvisionedDatabase } from './database-provisioner.service.js';
import { validateDatabaseIdentifier } from './database-provisioner.service.js';

@Injectable()
export class TenantDbPoolService {
  // systemPrisma: owner-managed database capacity is control-plane data.
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly databases: TenantDatabaseProvisioner,
  ) {}

  async add(databaseName: string, dbUser: string, host?: string, port?: number): Promise<{ added: true; schemaVersion: string }> {
    validateDatabaseIdentifier(databaseName);
    validateDatabaseIdentifier(dbUser);
    const password = process.env.TENANT_DB_PASSWORD;
    if (!password) throw new Error('TENANT_DB_PASSWORD is required');
    const base = new URL(this.config.get('DATABASE_URL', { infer: true }));
    const routeHost = host ?? this.config.get('TENANT_DB_HOST', { infer: true }) ?? base.hostname;
    const routePort = port ?? (base.port ? Number(base.port) : 3306);
    const url = this.databaseUrl(routeHost, routePort, databaseName, dbUser, password);
    const pool = mariadb.createPool({
      host: routeHost,
      port: routePort,
      user: dbUser,
      password,
      database: databaseName,
      connectionLimit: 1,
      connectTimeout: 10_000,
    });
    try {
      const rows = await pool.query<Array<{ tableCount: number }>>(
        'SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE()',
      );
      if (Number(rows[0]?.tableCount ?? 0) !== 0) throw new Error('Tenant database must be empty');
    } finally {
      await pool.end();
    }
    const schemaVersion = await migrateDatabase(url);
    await this.prisma.control().tenantDbPool.create({
      data: {
        host: routeHost,
        port: routePort,
        databaseName,
        dbUser,
        passwordSealed: sealSecret(password, this.config.get('TENANT_DB_SECRET_KEY', { infer: true })),
        schemaVersion,
      },
    });
    return { added: true, schemaVersion };
  }

  async fill(target = this.config.get('TENANT_DB_POOL_TARGET', { infer: true })): Promise<{ created: number; free: number }> {
    if (this.config.get('DB_PROVISIONER', { infer: true }) !== 'create') {
      throw new Error('db-pool-fill requires DB_PROVISIONER=create');
    }
    let free = await this.databases.countFreePoolRows();
    let created = 0;
    while (free < target) {
      const database = await this.databases.createDatabase();
      try {
        const schemaVersion = await migrateDatabase(database.url);
        await this.insert(database, schemaVersion);
      } catch (error) {
        await this.databases.dropCreatedDatabase(database).catch(() => undefined);
        throw error;
      }
      created += 1;
      free += 1;
    }
    return { created, free };
  }

  async status(): Promise<{ free: number; claimed: number; behind: number }> {
    const control = this.prisma.control();
    const expected = expectedSchemaVersion();
    const [free, claimed, behindPool, behindTenants] = await Promise.all([
      control.tenantDbPool.count({ where: { claimedByTenantId: null } }),
      control.tenantDbPool.count({ where: { claimedByTenantId: { not: null } } }),
      control.tenantDbPool.count({
        where: {
          claimedByTenantId: null,
          OR: [{ schemaVersion: null }, { schemaVersion: { lt: expected } }],
        },
      }),
      control.tenantDatabase.count({ where: { OR: [{ schemaVersion: null }, { schemaVersion: { lt: expected } }] } }),
    ]);
    return { free, claimed, behind: behindPool + behindTenants };
  }

  private async insert(database: ProvisionedDatabase, schemaVersion: string): Promise<void> {
    await this.prisma.control().tenantDbPool.create({
      data: {
        host: database.host,
        port: database.port,
        databaseName: database.databaseName,
        dbUser: database.dbUser,
        passwordSealed: database.passwordSealed,
        schemaVersion,
      },
    });
  }

  private databaseUrl(host: string, port: number, databaseName: string, dbUser: string, password: string): string {
    const url = new URL(this.config.get('DATABASE_URL', { infer: true }));
    url.hostname = host;
    url.port = String(port);
    url.pathname = `/${databaseName}`;
    url.username = dbUser;
    url.password = password;
    url.search = '';
    url.hash = '';
    return url.toString();
  }
}
